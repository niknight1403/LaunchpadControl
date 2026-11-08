import { AudioEngine } from '../../src/engine/AudioEngine';
import { FxParam } from '../../src/engine/types';
import { MemoryStorage, PresetStore } from '../../src/state/PresetStore';
import { PRESET_SCHEMA_VERSION, emptyPreset, parsePreset, summarise } from '../../src/state/schema';
import { check, near, section, sleep } from './harness';

function makeEngine(): AudioEngine {
  return new AudioEngine({ sampleRate: 48000, framesPerBuffer: 128 });
}

export async function run(): Promise<void> {
  section('Preset schema');
  const fresh = emptyPreset('Test', 1_000);
  check('a fresh preset validates', parsePreset(fresh, 1_000).ok);
  check('four decks are present', fresh.decks.length === 4);
  check('summary counts loaded decks', summarise(fresh).loadedDecks === 0);

  const broken = parsePreset({ ...fresh, bpm: 900 }, 1_000);
  check('out-of-range bpm is rejected', !broken.ok && broken.errors.some((e) => e.includes('bpm')));

  const future = parsePreset({ ...fresh, version: PRESET_SCHEMA_VERSION + 5 }, 1_000);
  check('a newer schema version is refused, not guessed', !future.ok);

  // v1 shape: no fx block, transitionLength instead of transitionBars.
  const v1 = {
    version: 1,
    id: 'legacy',
    name: 'Alt',
    bpm: 130,
    masterGain: 0.7,
    crossfader: 0.2,
    decks: [0, 1, 2, 3].map((id) => ({
      id,
      clipPath: null,
      bpm: 130,
      gain: 0.8,
      stemGains: { drums: 1, bass: 1, synth: 1, vocals: 1 },
      filterMode: 'lowpass',
    })),
    agent: { coPilot: true, transitionLength: 16 },
  };
  const migrated = parsePreset(v1, 2_000);
  check('v1 preset migrates', migrated.ok, migrated.ok ? '' : migrated.errors.join(','));
  if (migrated.ok) {
    check('migration is reported', migrated.migrated);
    check('legacy transitionLength becomes transitionBars', migrated.preset.agent.transitionBars === 16);
    check('migration adds default fx', migrated.preset.decks[0]?.fx.filterCutoff === 1);
    check('migration adds a surface block', migrated.preset.surface.profile === 'mini-mk3');
    check('migrated preset is stamped with the current version', migrated.preset.version === PRESET_SCHEMA_VERSION);
  }

  section('Preset store');
  const storage = new MemoryStorage();
  const store = new PresetStore(storage, { autosaveMs: 30, now: () => 5_000 });
  await store.load();
  check('empty store loads', store.list().length === 0 && store.isLoaded);

  const engine = makeEngine();
  engine.setBpm(132);
  engine.setMasterGain(0.6);
  engine.setCrossfader(0.25);
  engine.setDeckGain(1, 0.7);
  engine.setStemGain(1, 'vocals', 0);
  engine.setFilterMode(1, 'highpass');
  engine.setFx(1, FxParam.FilterCutoff, 0.4);
  engine.setFx(1, FxParam.DelayMix, 0.8);

  const snapshot = store.captureFromEngine(engine, {
    name: 'Peak Time',
    clipPaths: { 0: '/music/a.wav', 1: '/music/b.wav' },
    now: 5_000,
  });
  check('capture reads the transport bpm', snapshot.bpm === 132);
  check('capture reads master gain', near(snapshot.masterGain, 0.6, 1e-9));
  check('capture reads stem gains', snapshot.decks[1]?.stemGains.vocals === 0);
  check('capture reads the filter mode', snapshot.decks[1]?.filterMode === 'highpass');
  check('capture reads fx values by name', snapshot.decks[1]?.fx.delayMix === 0.8, String(snapshot.decks[1]?.fx.delayMix));
  check('capture keeps clip paths', snapshot.decks[0]?.clipPath === '/music/a.wav');

  await store.save(snapshot);
  check('save writes the index and the record', storage.size === 2);
  check('list returns the preset', store.list().length === 1);
  check('summary counts the two loaded decks', store.list()[0]?.loadedDecks === 2);

  // A second engine applies the preset; state must land where it came from.
  const target = makeEngine();
  const applied = store.applyToEngine(target, snapshot);
  check('apply reports applied decks', applied.appliedDecks === 4, String(applied.appliedDecks));
  check('apply restores bpm', target.currentBpm === 132);
  check('apply restores master gain', near(target.masterGainValue, 0.6, 1e-9));
  check('apply restores deck gain', near(target.getDeckState(1)?.gain ?? -1, 0.7, 1e-9));
  check('apply restores fx', near(target.getDeckState(1)?.fx[FxParam.DelayMix] ?? -1, 0.8, 1e-9));
  check('apply restores stem levels', target.getDeckState(1)?.stemGains.vocals === 0);

  section('Preset export / import');
  const exported = store.export(snapshot);
  const reimported = store.import(exported);
  check('export/import round-trips the name', reimported.name === 'Peak Time');
  check('import keeps the deck count', reimported.decks.length === 4);
  let threw = false;
  try {
    store.import('{"name": ""}');
  } catch {
    threw = true;
  }
  check('importing garbage throws a usable error', threw);

  section('Autosave');
  let counter = 0;
  const autosaveStore = new PresetStore(new MemoryStorage(), { autosaveMs: 25, now: () => 9_000 });
  await autosaveStore.load();
  // Five rapid changes must collapse into one write.
  for (let i = 0; i < 5; i += 1) {
    autosaveStore.scheduleAutosave(() => {
      counter += 1;
      return { ...snapshot, name: `Snapshot ${counter}` };
    });
  }
  await sleep(60);
  check('debounced autosave fires exactly once', counter === 1, String(counter));
  await autosaveStore.flush();
  check('flushed autosave is persisted', autosaveStore.list().length === 1);

  section('Persistence across restarts');
  const reloadStorage = new MemoryStorage();
  const first = new PresetStore(reloadStorage, { now: () => 11_000 });
  await first.load();
  const saved = await first.save({ ...snapshot, id: 'keep-me' });
  const second = new PresetStore(reloadStorage, { now: () => 12_000 });
  await second.load();
  check('preset survives a reload', second.get('keep-me')?.name === saved.name);
  await second.delete('keep-me');
  const third = new PresetStore(reloadStorage, { now: () => 13_000 });
  await third.load();
  check('deleted preset stays deleted', third.get('keep-me') === undefined && third.list().length === 0);
}
