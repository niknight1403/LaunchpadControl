import { MemoryStudioStorage, Studio, type StudioEngine, type StudioTelemetry } from '../../src/app/Studio';
import { sessionPlugin, markSessionClean } from '../../src/app/wiring/session';
import { Translator } from '../../src/i18n/strings';
import { check, section } from './harness';

/** Records every call, so the wiring can be asserted on instead of hoped for. */
export function fakeEngine(overrides: Partial<StudioEngine> = {}): StudioEngine & { calls: string[] } {
  const calls: string[] = [];
  let bpm = 120;
  const engine = {
    calls,
    sampleRate: 48_000,
    get currentBpm() {
      return bpm;
    },
    transportBeats: 0,
    beatPhase: 0,
    crossfaderValue: 0.5,
    masterGainValue: 0.8,
    recordedFrames: 0,
    setLoop: (deck: number, start: number, end: number) => calls.push(`loop:${deck}:${start}:${end}`),
    clearLoop: (deck: number) => calls.push(`clearLoop:${deck}`),
    setDeckRate: (deck: number, rate: number) => calls.push(`rate:${deck}:${rate}`),
    seek: (deck: number, frame: number) => calls.push(`seek:${deck}:${frame}`),
    setDeckGain: (deck: number, gain: number) => calls.push(`gain:${deck}:${gain}`),
    setStemGain: (deck: number, stem: string, gain: number) => calls.push(`stem:${deck}:${stem}:${gain}`),
    setFx: (deck: number, param: string, value: number) => calls.push(`fx:${deck}:${param}:${value}`),
    setFilterMode: (deck: number, mode: string) => calls.push(`filterMode:${deck}:${mode}`),
    setMasterGain: (gain: number) => calls.push(`master:${gain}`),
    setCrossfader: (value: number) => calls.push(`crossfader:${value}`),
    triggerPad: (deck: number, pad: number, velocity = 1) => calls.push(`pad:${deck}:${pad}:${velocity}`),
    stopDeck: (deck: number) => calls.push(`stop:${deck}`),
    setBpm: (value: number) => {
      bpm = value;
      calls.push(`bpm:${value}`);
    },
    startRecording: () => true,
    stopRecording: () => calls.push('stopRecording'),
    onTelemetry: (listener: (telemetry: StudioTelemetry) => void) => {
      calls.push('telemetry:subscribe');
      return () => calls.push('telemetry:unsubscribe');
    },
    ...overrides,
  };
  return engine as unknown as StudioEngine & { calls: string[] };
}

export async function run(): Promise<void> {
  section('Sprint 11 wiring: session restore');

  const storage = new MemoryStudioStorage();
  const engine = fakeEngine();
  const studio = new Studio({ engine, translator: new Translator(), storage, deckCount: 4, now: () => 1_000 });
  const plugin = sessionPlugin();
  await studio.boot([plugin]);

  check('the plugin is installed', studio.installed.some((entry) => entry.name === 'session'));
  check('it is registered as sprint 11', studio.installed[0]?.sprint === 11);
  check('the commands reach the UI', studio.commands.has('flushSession') && studio.commands.has('captureSession'));
  check('a fresh boot writes an initial snapshot', storage.getItem('auragrid.session') !== null);

  // A deck state change must end up in the snapshot, debounced by the store.
  studio.ctx.state.decks[1]!.trackId = 'track-7';
  studio.ctx.state.decks[1]!.gain = 0.6;
  studio.ctx.state.decks[1]!.positionSeconds = 12.5;
  studio.ctx.state.decks[1]!.loop = { startFrame: 48_000, endFrame: 96_000 };
  studio.ctx.notify();
  studio.commands.get('flushSession')!();
  const written = JSON.parse(storage.getItem('auragrid.session') ?? '{}');
  check('the snapshot carries the deck gain', written.decks?.[1]?.gain === 0.6, JSON.stringify(written.decks?.[1]));
  check('the snapshot carries the loop in seconds', written.decks?.[1]?.loop?.startSeconds === 1);
  check('the snapshot is flagged unclean while running', written.clean === false);

  await studio.shutdown();
  const afterShutdown = JSON.parse(storage.getItem('auragrid.session') ?? '{}');
  check('shutdown flushes', afterShutdown.decks?.[1]?.gain === 0.6);

  // Restore round trip: a second studio on the same storage must apply, not just read.
  const engine2 = fakeEngine();
  const studio2 = new Studio({ engine: engine2, translator: new Translator(), storage, deckCount: 4, now: () => 2_000 });
  await studio2.boot([sessionPlugin()]);
  check('the restored gain is applied to the engine', engine2.calls.includes('gain:1:0.6'), engine2.calls.join(','));
  check('the restored loop is applied', engine2.calls.some((call) => call.startsWith('loop:1:48000:96000')), engine2.calls.join(','));
  check('the restored playhead is applied', engine2.calls.includes('seek:1:600000'), engine2.calls.join(','));
  check('the restored track id is in state', studio2.ctx.state.decks[1]?.trackId === 'track-7');
  check('the restore is logged', studio2.ctx.state.events.some((event) => event.kind === 'session'), JSON.stringify(studio2.ctx.state.events));

  // Clean shutdown, then a restore must not claim a crash.
  const cleanEngine = fakeEngine();
  const cleanStudio = new Studio({ engine: cleanEngine, translator: new Translator(), storage, deckCount: 4, now: () => 3_000 });
  const cleanPlugin = sessionPlugin();
  await cleanStudio.boot([cleanPlugin]);
  markSessionClean(cleanPlugin.wiring!.store());
  await cleanStudio.shutdown();

  const afterClean = new Studio({ engine: fakeEngine(), translator: new Translator(), storage, deckCount: 4, now: () => 4_000 });
  await afterClean.boot([sessionPlugin()]);
  check('a clean shutdown is not reported as a crash', !afterClean.ctx.state.events.some((event) => /not closed cleanly/.test(event.message)), JSON.stringify(afterClean.ctx.state.events));

  // Hostile storage must not crash the boot.
  const broken = new MemoryStudioStorage();
  broken.setItem('auragrid.session', '{"version":1,"decks":"nope"}');
  const resilient = new Studio({ engine: fakeEngine(), translator: new Translator(), storage: broken, deckCount: 4 });
  let crashed = false;
  try {
    await resilient.boot([sessionPlugin()]);
  } catch {
    crashed = true;
  }
  check('a corrupt session does not break the boot', !crashed);
  check('the corrupt session is reported', resilient.ctx.state.events.some((event) => event.kind === 'session'), JSON.stringify(resilient.ctx.state.events));
}
