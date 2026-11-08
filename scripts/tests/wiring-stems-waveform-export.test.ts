import { Studio, MemoryStudioStorage } from '../../src/app/Studio';
import { buildExportBundle, peakDb } from '../../src/recording/PostProcess';
import { exportPlugin } from '../../src/app/wiring/export';
import { stemsPlugin, STEM_NAMES } from '../../src/app/wiring/stems';
import { waveformPlugin } from '../../src/app/wiring/waveform';
import { sine } from '../../src/analysis/StemSplit';
import { Translator } from '../../src/i18n/strings';
import { check, near, section } from './harness';
import { fakeEngine } from './wiring-session.test';

export async function run(): Promise<void> {
  section('Sprint 14 wiring: stems');
  const engine = fakeEngine();
  const studio = new Studio({ engine, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  await studio.boot([stemsPlugin()]);

  check('stem commands are published', ['analyseStems', 'setStemGain', 'soloStem', 'stemGains'].every((name) => studio.commands.has(name)));

  // A 60 Hz tone is bass, a 5 kHz tone is highs: the analysis must separate them.
  const bassTone = sine(60, 0.3, 48_000);
  const highTone = sine(5_000, 0.3, 48_000);
  const energy = studio.commands.get('analyseStems')!(0, [bassTone], 48_000) as { bass: number; mid: number; highs: number };
  check('a 60 Hz tone lands in the bass band', energy.bass > energy.highs * 2, JSON.stringify(energy));
  const energyHigh = studio.commands.get('analyseStems')!(1, [highTone], 48_000) as { bass: number; mid: number; highs: number };
  check('a 5 kHz tone lands in the highs', energyHigh.highs > energyHigh.bass * 2, JSON.stringify(energyHigh));

  const setGain = studio.commands.get('setStemGain')! as (deck: number, stem: string, gain: number) => void;
  engine.calls.length = 0;
  setGain(0, 'bass', 0.4);
  check('a stem gain reaches the engine', engine.calls.includes('stem:0:bass:0.4'), engine.calls.join(','));
  setGain(0, 'mid', 5);
  check('a wild gain is clamped', engine.calls.includes('stem:0:mid:1'), engine.calls.join(','));
  setGain(0, 'mid', Number.NaN);
  check('a NaN gain does not poison the engine', engine.calls.includes('stem:0:mid:1'), engine.calls.join(','));

  engine.calls.length = 0;
  studio.commands.get('soloStem')!(0, 'bass');
  const gains = studio.commands.get('stemGains')!(0) as Record<string, number>;
  check('solo keeps one band', gains.bass === 1 && gains.mid === 0 && gains.highs === 0, JSON.stringify(gains));
  check('solo writes every band', STEM_NAMES.every((stem) => engine.calls.some((call) => call.startsWith(`stem:0:${stem}:`))), engine.calls.join(','));
  studio.commands.get('soloStem')!(0, null);
  const released = studio.commands.get('stemGains')!(0) as Record<string, number>;
  check('releasing solo restores unity', released.bass === 1 && released.mid === 1 && released.highs === 1, JSON.stringify(released));

  section('Sprint 15 wiring: waveform');
  await studio.install(waveformPlugin());
  check('waveform commands are published', ['buildWaveform', 'waveformData', 'waveformBrightness'].every((name) => studio.commands.has(name)));

  const build = studio.commands.get('buildWaveform')! as (deck: number, channels: Float32Array[], rate: number) => { buckets: number; markers: number; loudest: number };
  const summary = build(0, [bassTone], 48_000);
  check('the waveform has buckets', summary.buckets > 100, JSON.stringify(summary));
  check('the loudest bucket is inside the data', summary.loudest >= 0 && summary.loudest < summary.buckets, JSON.stringify(summary));
  const data = studio.commands.get('waveformData')!(0) as { buckets: { low: number; high: number }[] };
  check('the data is stored on the deck', data.buckets.length === summary.buckets);
  check('a bass tone produces low-band energy', data.buckets[Math.floor(summary.buckets / 2)]!.low > data.buckets[Math.floor(summary.buckets / 2)]!.high);

  const brightness = studio.commands.get('waveformBrightness')! as (deck: number, column: number) => number;
  check('a column has brightness', brightness(0, 3) > 0.1 && brightness(0, 3) <= 1, String(brightness(0, 3)));
  check('an empty deck still renders', brightness(3, 0) > 0 && brightness(3, 0) < 0.2);

  // Markers appear once a grid exists.
  studio.commands.get('setGrid') ? undefined : undefined;
  await studio.install((await import('../../src/app/wiring/beat-grid')).beatGridPlugin());
  studio.commands.get('setGrid')!(0, 120, 0, 'manual');
  studio.ctx.notify();
  const withMarkers = studio.commands.get('waveformData')!(0) as { markers: unknown[] };
  check('markers are added when a grid arrives', withMarkers.markers.length > 0, String(withMarkers.markers.length));

  section('Sprint 16 wiring: export');
  await studio.install(exportPlugin());
  check('export commands are published', ['toggleRecord', 'exportTake'].every((name) => studio.commands.has(name)));

  const written: { name: string; bytes: number }[] = [];
  const take = studio.commands.get('exportTake')!(0, [sine(440, 0.5, 48_000)], 48_000, 'Take 1') as {
    manifest: { name: string; peakDb: number; durationSeconds: number };
    wav: Uint8Array;
  };
  check('the take has a manifest', take.manifest.name === 'Take 1', JSON.stringify(take.manifest));
  check('the wav has a header and data', take.wav.length > 44, String(take.wav.length));
  check('the export is logged', studio.ctx.state.events.some((event) => event.kind === 'export'), JSON.stringify(studio.ctx.state.events.slice(-3)));
  check('the last export is in state', studio.ctx.state.lastExport?.name === 'Take 1', JSON.stringify(studio.ctx.state.lastExport));
  check('unused capture list stays empty', written.length === 0);

  // Normalisation: a quiet take must come back at the ceiling, not at its own level.
  const quiet = new Float32Array(4_800).fill(0.05);
  const bundle = buildExportBundle([quiet], { name: 'quiet', createdAt: 0, sampleRate: 48_000 });
  check('a quiet take is normalised up', near(peakDb([quiet]), -26, 1), String(peakDb([quiet])));
  check('the exported take is louder than the input', bundle.manifest.peakDb > -20, String(bundle.manifest.peakDb));

  await studio.shutdown();
  check('shutdown clears the plugins', studio.installed.length === 0);
}
