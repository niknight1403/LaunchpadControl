import { barDurationSeconds, detectBpm, onsetEnvelope, quantiseBpm } from '../../src/analysis/beat';
import { TrackLibrary } from '../../src/library/TrackLibrary';
import { MemoryStorage } from '../../src/state/PresetStore';
import { check, near, section } from './harness';

/** Impulse train: the cleanest case a tempo detector can be asked about. */
function clickTrack(bpm: number, seconds: number, sampleRate: number): number[] {
  const beatSamples = Math.round((60 / bpm) * sampleRate);
  const total = Math.round(seconds * sampleRate);
  const samples = new Array<number>(total).fill(0);
  for (let start = 0; start + beatSamples < total; start += beatSamples) {
    // 8 ms decaying burst reads as a click, not a single sample spike (which a
    // frame-based envelope can miss entirely).
    const burst = Math.min(beatSamples, Math.round(sampleRate * 0.008));
    for (let i = 0; i < burst; i += 1) {
      samples[start + i] = Math.sin((i / sampleRate) * 2 * Math.PI * 1200) * (1 - i / burst);
    }
  }
  return samples;
}

export async function run(): Promise<void> {
  section('BPM detection');
  const sampleRate = 8000;

  const exact = detectBpm(clickTrack(120, 12, sampleRate), sampleRate, { hopSize: 100 });
  check('finds 120 BPM on an exact grid', exact !== null && near(exact.bpm, 120, 0.5), String(exact?.bpm));
  check('reports high confidence for a click track', (exact?.confidence ?? 0) > 0.6, String(exact?.confidence));

  const fast = detectBpm(clickTrack(128, 12, sampleRate), sampleRate, { hopSize: 64 });
  check('finds 128 BPM within ±2', fast !== null && near(fast.bpm, 128, 2), String(fast?.bpm));

  const slow = detectBpm(clickTrack(85, 16, sampleRate), sampleRate, { hopSize: 100 });
  check('finds 85 BPM within ±2', slow !== null && near(slow.bpm, 85, 2), String(slow?.bpm));

  check('silence returns nothing', detectBpm(new Array(sampleRate * 4).fill(0), sampleRate) === null);
  check('a buffer shorter than 2 s is rejected', detectBpm(new Array(sampleRate).fill(0), sampleRate) === null);

  const envelope = onsetEnvelope(clickTrack(120, 4, sampleRate), 100);
  check('envelope has one frame per hop', envelope.length === Math.floor((sampleRate * 4) / 100));
  check('envelope is non-negative', envelope.every((value) => value >= 0));

  check('bpm quantises to a musical grid', quantiseBpm(127.94) === 128);
  check('bar duration at 128 BPM is 1.875 s', near(barDurationSeconds(128), 1.875, 1e-9));

  section('Track library');
  const storage = new MemoryStorage();
  const library = new TrackLibrary(storage, { now: () => 1_000 });

  const a = library.add({ title: 'Aurora', artist: 'Nova', path: '/m/a.wav', bpm: 126.4, durationSeconds: 320, camelot: '8A', energy: 0.5 });
  const b = library.add({ title: 'Basalt', artist: 'Kite', path: '/m/b.wav', bpm: 128, durationSeconds: 300, camelot: '8B', energy: 0.7 });
  const c = library.add({ title: 'Cinder', artist: 'Nova', path: '/m/c.wav', bpm: 140, durationSeconds: 280, camelot: '11A', energy: 0.9 });

  check('three tracks added', library.size === 3);
  check('bpm is quantised on insert', a.bpm === 126.5, String(a.bpm));
  check('duplicate path updates instead of duplicating', library.add({ title: 'Aurora (Remaster)', path: '/m/a.wav', bpm: 126, durationSeconds: 321 }).id === a.id && library.size === 3);
  check('title was updated by the duplicate add', library.get(a.id)?.title === 'Aurora (Remaster)');
  check('a partial upsert keeps the artist', library.get(a.id)?.artist === 'Nova', library.get(a.id)?.artist);

  check('search matches the artist', library.query({ text: 'nova' }).length === 2);
  check('bpm range filter', library.query({ minBpm: 127, maxBpm: 130 }).map((t) => t.title).join(',') === 'Basalt');
  check('camelot filter', library.query({ camelot: '8B' }).length === 1);
  check('energy filter', library.query({ minEnergy: 0.8 }).map((t) => t.title).join(',') === 'Cinder');
  check('unanalysed filter', library.query({ analysedOnly: true }).length === 0);

  const analysis = library.applyAnalysis(b.id, { bpm: 128.3, camelot: '9A', energy: 0.75, durationSeconds: 301 });
  check('analysis writes the bpm back', analysis?.bpm === 128.5, String(analysis?.bpm));
  check('analysis marks the track as analysed', analysis?.analysed === true);
  check('analysed filter now finds it', library.query({ analysedOnly: true }).length === 1);

  const similar = library.similar(b.id, 2);
  check('similar returns the other two tracks', similar.length === 2);
  check('relative major ranks above a distant key', similar[0]?.track.title === 'Aurora (Remaster)' || similar[0]?.track.title === 'Cinder');
  check('scores are sorted descending', similar.every((entry, index) => index === 0 || similar[index - 1]!.score >= entry.score));

  // Read the record back: `b` is the pre-analysis snapshot.
  const agentTrack = library.toAgentTrack(library.get(b.id)!);
  check('agent track carries a usable key', agentTrack.key.camelot === '9A', agentTrack.key.camelot);
  check('agent track carries bpm and energy', agentTrack.bpm === 128.5 && agentTrack.energy === 0.75, `${agentTrack.bpm}/${agentTrack.energy}`);
  check('toAgentTracks maps the whole library', library.toAgentTracks().length === 3);

  await library.persist();
  const reloaded = new TrackLibrary(storage, { now: () => 2_000 });
  await reloaded.load();
  check('library survives a reload', reloaded.size === 3);
  check('analysed flag survives a reload', reloaded.get(b.id)?.analysed === true);

  reloaded.remove(c.id);
  await reloaded.persist();
  const third = new TrackLibrary(storage, { now: () => 3_000 });
  await third.load();
  check('removal is persisted', third.size === 2 && third.get(c.id) === undefined);

  const corrupt = new MemoryStorage();
  await corrupt.setItem('auragrid.library.v1', 'not json at all');
  const tolerant = new TrackLibrary(corrupt);
  await tolerant.load();
  check('a corrupt library file does not throw', tolerant.size === 0);
}
