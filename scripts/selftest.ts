/**
 * Logic self-test for the parts that must be right before a gig and can be
 * checked without a device: key maths, MIDI wire format, timeline, mesh clock.
 *
 * Run:  npm run test:logic      (= esbuild bundle + node)
 */
import {
  estimateKey,
  harmonicCompatibility,
  keyFromCamelot,
  makeKey,
  nextKeyCandidates,
  requiredTempoShift,
  tempoMatchScore,
} from '../src/agent/harmonic';
import { LoopbackMeshTransport } from '../src/agent/MeshTransport';
import { MeshClockSync } from '../src/agent/MeshClockSync';
import { LookaheadTimeline } from '../src/agent/Timeline';
import { LaunchpadMidiManager } from '../src/midi/LaunchpadMidiManager';
import { MockMidiTransport } from '../src/midi/MockMidiTransport';
import { toWireChannel, velocityBrightness } from '../src/midi/LaunchpadProfiles';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testHarmonic(): Promise<void> {
  console.log('\nCamelot / harmonic');
  const cMajor = makeKey(0, 'major');
  const aMinor = makeKey(9, 'minor');
  const fSharpMinor = makeKey(6, 'minor');

  check('C major is 8B', cMajor.camelot === '8B', cMajor.camelot);
  check('A minor is 8A', aMinor.camelot === '8A', aMinor.camelot);
  check('F# minor is 11A', fSharpMinor.camelot === '11A', fSharpMinor.camelot);
  check('every code round-trips', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((root) => {
    const key = makeKey(root as 0, 'major');
    const parsed = keyFromCamelot(key.camelot);
    return parsed !== null && parsed.root === key.root && parsed.mode === 'major';
  }));
  check('same key scores 1.0', harmonicCompatibility(aMinor, aMinor) === 1);
  check('relative major scores 0.95', harmonicCompatibility(aMinor, cMajor) === 0.95);
  check(
    'energy neighbour scores 0.9',
    harmonicCompatibility(aMinor, makeKey(4, 'minor')) === 0.9,
    String(harmonicCompatibility(aMinor, makeKey(4, 'minor'))),
  );
  const candidates = nextKeyCandidates(aMinor);
  check('candidates include the relative major', candidates.some((entry) => entry.key.camelot === '8B'));
  check('candidates are sorted by score', candidates.every((entry, index) => index === 0 || candidates[index - 1]!.score >= entry.score));
}

async function testKeyEstimation(): Promise<void> {
  console.log('\nKey estimation');
  // A minor tonality: A, C, E strongly weighted.
  const chroma = [5, 0, 3, 0, 4, 2, 0, 1, 0, 6, 0, 1];
  const estimate = estimateKey(chroma);
  check('estimate returns a key', estimate !== null);
  check('estimates A minor', estimate?.camelot === '8A', estimate?.camelot);
  check('confidence is plausible', (estimate?.confidence ?? 0) > 0.5, String(estimate?.confidence));
  check('rejects a malformed vector', estimateKey([1, 2, 3]) === null);
}

async function testTempo(): Promise<void> {
  console.log('\nTempo matching');
  check('87 vs 174 BPM is a match (half time)', tempoMatchScore(87, 174) > 0.95, String(tempoMatchScore(87, 174)));
  check('128 vs 128 is perfect', tempoMatchScore(128, 128) === 1);
  check('128 vs 150 is poor', tempoMatchScore(128, 150) < 0.2, String(tempoMatchScore(128, 150)));
  check('shift needed 128 → 132 is +3.1 %', near(requiredTempoShift(128, 132), 0.031, 0.002), String(requiredTempoShift(128, 132)));
}

async function testMidiWire(): Promise<void> {
  console.log('\nLaunchpad wire format');
  const transport = new MockMidiTransport();
  const manager = new LaunchpadMidiManager(transport);
  await manager.open();

  const afterOpen = transport.sent[0] ?? new Uint8Array();
  check('programmer-mode SysEx is sent on open', afterOpen[0] === 0xf0 && afterOpen[4] === 0x0d, Array.from(afterOpen).join(','));
  check('enter programmer mode flag', Array.from(afterOpen).slice(5, 7).join(',') === '0,1');

  transport.sent.length = 0;
  manager.setPad(0, 0, { r: 0, g: 242, b: 254 });
  manager.flush();
  const message = transport.sent[0] ?? new Uint8Array();
  check('lighting SysEx header', Array.from(message).slice(0, 6).join(',') === '240,0,32,41,13,3', Array.from(message).join(','));
  // y = 0 is the top visual row → hardware row 7 → note (7+1)*10 + 0 + 1 = 81
  check('top-left pad addressed as note 81', message[7] === 81, String(message[7]));
  // 242/255*127 = 120.5 → 121, 254/255*127 = 126.5 → 127
  check('RGB is scaled to 0..127', message[9] === 121 && message[10] === 127, `${message[9]},${message[10]}`);
  check('message is terminated', message[message.length - 1] === 0xf7);

  transport.sent.length = 0;
  manager.setPad(0, 0, { r: 0, g: 242, b: 254 });
  manager.flush();
  check('unchanged pad is not retransmitted (diff ledger)', transport.sent.length === 0);

  let hit: { row: number; col: number; velocity: number; pressed: boolean } | null = null;
  manager.onPad((event) => {
    hit = { row: event.row, col: event.col, velocity: event.velocity, pressed: event.pressed };
  });
  transport.inject([0x90, 11, 100]);
  check('note 11 decodes to bottom-left of the hardware grid', hit !== null && (hit as { row: number }).row === 0 && (hit as { col: number }).col === 0);
  check('velocity normalised to 0..1', hit !== null && near((hit as { velocity: number }).velocity, 100 / 127, 0.001));

  let control: { area: string; index: number } | null = null;
  manager.onControl((event) => {
    control = { area: event.area, index: event.index };
  });
  transport.inject([0xb0, 104, 127]);
  check('top row CC 104 decodes to control 0', control !== null && (control as { index: number }).index === 0);

  check('screen cell for note 11 is the bottom visual row', manager.screenCellForNote(11)?.row === 7);
  check('brightness mapping keeps a floor', velocityBrightness(0) >= 0.1 && velocityBrightness(1) <= 1);
  check('wire channel clamp', toWireChannel(255) === 127 && toWireChannel(0) === 0);

  await manager.close();
}

async function testTimeline(): Promise<void> {
  console.log('\nLookahead timeline');
  const timeline = new LookaheadTimeline({ tickMs: 10, lookaheadMs: 40 });
  const fired: number[] = [];
  timeline.start();
  timeline.schedule('a', Date.now() + 5, () => fired.push(1));
  timeline.schedule('b', Date.now() + 25, () => fired.push(2));
  await sleep(120);
  timeline.stop();
  check('both scheduled events fired', fired.length === 2, fired.join(','));
  check('in order', fired[0] === 1 && fired[1] === 2);

  const rampTimeline = new LookaheadTimeline({ tickMs: 5, lookaheadMs: 10 });
  let lastProgress = 0;
  rampTimeline.start();
  rampTimeline.ramp('fx', 30, 3, (progress) => {
    lastProgress = progress;
  });
  await sleep(120);
  rampTimeline.stop();
  check('ramp ends at 1.0', near(lastProgress, 1, 0.001), String(lastProgress));
}

async function testMeshClock(): Promise<void> {
  console.log('\nMesh clock sync');
  const transport = new LoopbackMeshTransport({ peers: ['peer-a'], latencyMs: 4 });
  const sync = new MeshClockSync({ pingIntervalMs: 40 });
  sync.setSelfId('local');
  await sync.attach(transport);
  sync.start(['peer-a']);
  await sleep(150);
  sync.stop();

  const peers = sync.getPeers();
  check('a peer was measured', peers.length === 1, `peers=${peers.length}`);
  check('round trip measured in ms', (peers[0]?.rttMs ?? -1) >= 0, String(peers[0]?.rttMs));
  check('local node is master (lowest id)', sync.masterId() === 'local', sync.masterId());
  check('synced clock is finite', Number.isFinite(sync.syncedNow()));
}

async function main(): Promise<void> {
  console.log('AuraGrid logic self-test');
  await testHarmonic();
  await testKeyEstimation();
  await testTempo();
  await testMidiWire();
  await testTimeline();
  await testMeshClock();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
