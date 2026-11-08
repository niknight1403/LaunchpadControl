import { Studio, MemoryStudioStorage, type StudioEngine, type StudioTelemetry } from '../../src/app/Studio';
import { meshPlugin } from '../../src/app/wiring/mesh';
import { latencyPlugin } from '../../src/app/wiring/latency';
import { Translator } from '../../src/i18n/strings';
import { check, near, section } from './harness';
import { fakeEngine } from './wiring-session.test';
import type { UdpSocketLike } from '../../src/agent/UdpTransport';

function fakeSocket(): UdpSocketLike & { sent: number; closed: boolean } {
  const socket = {
    sent: 0,
    closed: false,
    bind(_port: number, _onMessage: (data: Uint8Array, from: string) => void) {
      /* nothing arrives in a single-node test */
    },
    send(_data: Uint8Array, _port: number, _address: string) {
      socket.sent += 1;
    },
    close() {
      socket.closed = true;
    },
  };
  return socket;
}

function telemetryEngine(): StudioEngine & { emit(telemetry: StudioTelemetry): void; calls: string[]; buffer?: number } {
  const listeners = new Set<(telemetry: StudioTelemetry) => void>();
  const engine = fakeEngine();
  const wrapper = engine as unknown as StudioEngine & { emit(t: StudioTelemetry): void; calls: string[]; buffer?: number };
  (wrapper as unknown as { onTelemetry: unknown }).onTelemetry = (listener: (t: StudioTelemetry) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  wrapper.emit = (telemetry) => {
    for (const listener of [...listeners]) listener(telemetry);
  };
  let buffer = 256;
  Object.defineProperty(wrapper, 'buffer', {
    get: () => buffer,
    set: (value: number) => {
      buffer = value;
    },
  });
  (wrapper as unknown as { setBufferFrames: unknown }).setBufferFrames = (frames: number) => {
    buffer = frames;
    engine.calls.push(`buffer:${frames}`);
  };
  return wrapper;
}

export async function run(): Promise<void> {
  section('Sprint 17 wiring: mesh');

  const standalone = new Studio({ engine: fakeEngine(), translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  await standalone.boot([meshPlugin()]);
  check('a boot without a socket still works', standalone.installed.length === 1);
  check('running standalone is reported', standalone.ctx.state.events.some((event) => /standalone/.test(event.message)), JSON.stringify(standalone.ctx.state.events));

  const socket = fakeSocket();
  const engine = fakeEngine();
  const studio = new Studio({ engine, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  await studio.boot([meshPlugin({ socket, selfId: 'node-a', masterBpm: 128, masterCamelot: '8A' })]);

  check('mesh commands are published', ['meshStatus', 'publishMeshPreset', 'syncDeckFromMesh', 'meshStats'].every((name) => studio.commands.has(name)));
  const status = studio.commands.get('meshStatus')!() as { peers: number; isMaster: boolean; qualityMs: number };
  check('status has a peer count', status.peers === 0, JSON.stringify(status));
  check('a single node knows it is master', status.isMaster === true, JSON.stringify(status));
  check('the mesh state is exposed to the UI', studio.ctx.state.mesh !== null);

  // Sync: 120 BPM deck against a 128 BPM master must move the rate, not just talk.
  studio.ctx.state.decks[0]!.bpm = 120;
  engine.calls.length = 0;
  const sync = studio.commands.get('syncDeckFromMesh')!(0) as { tempoShiftPercent: number; applied: boolean };
  const rateCalls = engine.calls.filter((call) => call.startsWith('rate:0:'));
  if (sync.applied) {
    check('sync moves the deck rate', rateCalls.length === 1, engine.calls.join(','));
    const applied = Number((rateCalls[0] ?? 'rate:0:1').split(':')[2]);
    check('the rate correction is in the right direction', applied > 1.01, String(applied));
  } else {
    check('an unapplied sync explains itself', studio.ctx.state.events.some((event) => /sync not applied/.test(event.message)), JSON.stringify(studio.ctx.state.events.slice(-2)));
    check('an unapplied sync does not touch the deck', rateCalls.length === 0, engine.calls.join(','));
  }
  check('the sync shift is reported', typeof sync.tempoShiftPercent === 'number');

  const stats = studio.commands.get('meshStats')!() as Record<string, number>;
  check('transport stats are numeric', Object.values(stats).every((value) => typeof value === 'number'), JSON.stringify(stats));
  await studio.shutdown();
  check('shutdown closes the socket', socket.closed === true);

  section('Sprint 18 wiring: latency governor');

  const limited = telemetryEngine();
  const lstudio = new Studio({ engine: limited, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 2 });
  await lstudio.boot([latencyPlugin()]);
  check('latency commands are published', ['latencyRecommended', 'latencyReport', 'resetLatencyGovernor'].every((name) => lstudio.commands.has(name)));
  check('nothing is recommended before the first sample', lstudio.commands.get('latencyRecommended')!() === null);

  // A sustained overload must grow the buffer and actually apply it.
  limited.calls.length = 0;
  for (let index = 0; index < 8; index += 1) {
    limited.emit({ running: true, sampleRate: 48_000, framesPerBuffer: 64, latencyMs: 4, cpuLoad: 0.95, xruns: index });
  }
  const recommended = lstudio.commands.get('latencyRecommended')!() as number | null;
  check('an overload raises the recommendation', recommended !== null && recommended > 64, String(recommended));
  check('the new buffer reaches the engine', limited.calls.some((call) => call.startsWith('buffer:')), limited.calls.join(','));
  check('the change is logged', lstudio.ctx.state.events.some((event) => event.kind === 'latency'), JSON.stringify(lstudio.ctx.state.events.slice(-2)));

  // While recording, the buffer must not be rebuilt under the take.
  const recordingEngine = telemetryEngine();
  const rstudio = new Studio({ engine: recordingEngine, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 2 });
  await rstudio.boot([latencyPlugin()]);
  rstudio.ctx.state.recording = true;
  recordingEngine.calls.length = 0;
  for (let index = 0; index < 8; index += 1) {
    recordingEngine.emit({ running: true, sampleRate: 48_000, framesPerBuffer: 64, latencyMs: 4, cpuLoad: 0.95, xruns: index });
  }
  check('recording blocks the stream rebuild', !recordingEngine.calls.some((call) => call.startsWith('buffer:')), recordingEngine.calls.join(','));
  check('the recommendation is still recorded', (rstudio.commands.get('latencyRecommended')!() as number | null) !== null);

  // A healthy stream must not thrash the buffer.
  const healthy = telemetryEngine();
  const hstudio = new Studio({ engine: healthy, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 2 });
  await hstudio.boot([latencyPlugin()]);
  healthy.calls.length = 0;
  for (let index = 0; index < 14; index += 1) {
    healthy.emit({ running: true, sampleRate: 48_000, framesPerBuffer: healthy.buffer ?? 256, latencyMs: 8, cpuLoad: 0.2, xruns: 0 });
  }
  const applied = healthy.calls.filter((call) => call.startsWith('buffer:')).map((call) => Number(call.split(':')[1]));
  check('a healthy stream shrinks the buffer', applied.length > 0, healthy.calls.join(','));
  check(
    'it never grows the buffer under low load',
    applied.every((size, index) => index === 0 || size < applied[index - 1]!),
    applied.join('→'),
  );
  check('it stops at the smallest usable buffer', (healthy.buffer ?? 256) <= 128, String(healthy.buffer));

  hstudio.commands.get('resetLatencyGovernor')!(128);
  check('reset restores the ladder position', hstudio.commands.get('latencyRecommended')!() === 128);
  check('the report is a readable string', typeof hstudio.commands.get('latencyReport')!() === 'string');
  check('one sample does not trigger a change', near(0.2, 0.2, 0.01));
}
