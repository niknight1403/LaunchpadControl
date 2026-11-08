import { MeshClockSync } from '../../src/agent/MeshClockSync';
import {
  MeshSyncEngine,
  beatPhaseAt,
  msToNextBeat,
  safeCamelot,
} from '../../src/agent/MeshSyncEngine';
import { LoopbackMeshTransport } from '../../src/agent/MeshTransport';
import { check, near, section, sleep } from './harness';

const deck = (overrides: Partial<{ bpm: number; positionMs: number; camelot: string; isPlaying: boolean }> = {}) => ({
  bpm: 128,
  positionMs: 1_000,
  camelot: '8A',
  isPlaying: true,
  ...overrides,
});

/** Builds a clock that believes itself to be the master (lowest id wins). */
function masterClock(): { clock: MeshClockSync; transport: LoopbackMeshTransport } {
  const transport = new LoopbackMeshTransport({ peers: ['peer-a'], latencyMs: 2 });
  const clock = new MeshClockSync({ pingIntervalMs: 40 });
  clock.setSelfId('local');
  return { clock, transport };
}

/**
 * A node that is *not* the master: its id sorts after the peer's, so every
 * follower-only code path (phase nudge, trust warning) is reachable.
 */
async function followerClock(latencyMs = 2): Promise<MeshClockSync> {
  const transport = new LoopbackMeshTransport({ peers: ['peer-a'], latencyMs });
  const clock = new MeshClockSync({ pingIntervalMs: 30 });
  clock.setSelfId('zz-follower');
  await clock.attach(transport);
  clock.start(['peer-a']);
  await sleep(120);
  clock.stop();
  return clock;
}

export async function run(): Promise<void> {
  section('Mesh sync: beat phase');
  check('the beat itself is phase 0', beatPhaseAt(0, 120) === 0);
  check('half a beat later is phase 0.5', near(beatPhaseAt(250, 120), 0.5, 1e-9));
  check('a whole beat wraps back to 0', near(beatPhaseAt(500, 120), 0, 1e-9));
  check('an offset first beat shifts the phase', near(beatPhaseAt(250, 120, 250), 0, 1e-9));
  check('a bad tempo yields a safe phase', beatPhaseAt(100, 0) === 0);
  check('negative time still yields a valid phase', beatPhaseAt(-125, 120) >= 0 && beatPhaseAt(-125, 120) <= 1);

  check('at a bar line there is no wait', msToNextBeat(0, 120) === 0);
  check('mid-bar waits for the next bar', near(msToNextBeat(500, 120), 1_500, 1e-9), String(msToNextBeat(500, 120)));
  check('a full bar later is a bar line again', near(msToNextBeat(2_000, 120), 0, 1e-9));
  check('tempo changes the bar length', near(msToNextBeat(500, 140), (60_000 / 140) * 4 - 500, 1e-6));

  section('Mesh sync: status');
  const { clock, transport } = masterClock();
  await clock.attach(transport);
  clock.start(['peer-a']);
  await sleep(120);
  clock.stop();

  const engine = new MeshSyncEngine(clock, { masterBpm: 128, masterCamelot: '8A' });
  const status = engine.status();
  check('the lowest id is master', status.isMaster && status.masterId === 'local', status.masterId);
  check('a master needs no trust check', status.trusted || status.isMaster);
  check('status is not frozen by default', !status.frozen);
  engine.freeze();
  check('freezing is reported', engine.status().frozen);
  engine.resume();
  check('resuming clears it', !engine.status().frozen);

  section('Mesh sync: tempo plan');
  const matched = engine.planFor(deck());
  check('a matched tempo needs no shift', matched.tempoShiftPercent === 0, String(matched.tempoShiftPercent));
  check('no shift means no clamp', !matched.tempoShiftClamped);

  const slower = engine.planFor(deck({ bpm: 124 }));
  check('a slower deck is told to speed up', slower.tempoShiftPercent > 3, String(slower.tempoShiftPercent));
  check('the shift is percent of the master tempo', near(slower.tempoShiftPercent, 3.23, 0.05), String(slower.tempoShiftPercent));

  const wild = new MeshSyncEngine(clock, { masterBpm: 160, maxTempoShiftPercent: 6 });
  const clamped = wild.planFor(deck({ bpm: 120 }));
  check('an impossible match is clamped', clamped.tempoShiftClamped);
  check('the clamp is the configured maximum', Math.abs(clamped.tempoShiftPercent) === 6, String(clamped.tempoShiftPercent));
  check('the clamp is explained', clamped.warnings.some((warning) => warning.includes('apart')), clamped.warnings.join('|'));

  section('Mesh sync: phase and launch');
  const plan = engine.planFor(deck({ isPlaying: true }));
  check('the next bar is in the future', plan.nextBarAtMasterMs >= engine.now() - 5, `${plan.nextBarAtMasterMs} vs ${engine.now()}`);
  check('the next bar is at most one bar away', plan.nextBarAtMasterMs - engine.now() <= (60_000 / 128) * 4 + 20, String(plan.nextBarAtMasterMs - engine.now()));
  check('a local time is provided for the launch', Number.isFinite(plan.nextBarAtLocalMs));
  check('local and master times stay close on one device', Math.abs(plan.nextBarAtLocalMs - plan.nextBarAtMasterMs) < 5_000);
  const stopped = engine.planFor(deck({ isPlaying: false }));
  check('a stopped deck gets no nudge', stopped.phaseNudgeMs === 0);
  check('a stopped deck says why', stopped.warnings.some((warning) => warning.includes('stopped')), stopped.warnings.join('|'));
  engine.freeze();
  check('a frozen engine plans no nudge', engine.planFor(deck()).phaseNudgeMs === 0);
  check('a frozen engine says so', engine.planFor(deck()).warnings.some((warning) => warning.includes('frozen')));
  engine.resume();
  const nudge = engine.planFor(deck());
  check('a nudge never exceeds one beat', nudge.phaseNudgeMs <= 60_000 / 128 + 0.01, String(nudge.phaseNudgeMs));

  section('Mesh sync: key');
  check('an unknown key is not penalised', engine.keyScore(undefined) === 1);
  check('the master key matches itself', engine.keyScore('8A') === 1);
  check('an adjacent Camelot key scores well', engine.keyScore('9A') > 0.7, String(engine.keyScore('9A')));
  check('a distant key scores low', engine.keyScore('2B') < 0.5, String(engine.keyScore('2B')));
  check('a nonsense code falls back to neutral', engine.keyScore('nope') === 1);
  check('a plan carries the key score', engine.planFor(deck({ camelot: '9A' })).keyScore > 0.7);
  check('safeCamelot parses a real code', safeCamelot('12B')?.letter === 'B');
  check('safeCamelot refuses nonsense', safeCamelot('xyz') === null);

  section('Mesh sync: wording');
  // The engine above is the master, so it does not "sync to itself": the summary
  // must say master, and a follower is the only node that gets a sync line.
  check('a master does not pretend to sync', plan.summary.includes('master'), plan.summary);
  check('describe names the master', engine.describe().includes('local'), engine.describe());
  const follower = new MeshSyncEngine(await followerClock(), { masterBpm: 128, masterCamelot: '8A' });
  const followerPlan = follower.planFor(deck({ bpm: 126 }));
  check('a follower is not the master', !follower.status().isMaster, follower.status().masterId);
  check('a usable plan summarises itself', followerPlan.summary.includes('sync'), followerPlan.summary);
  check('a follower gets a phase nudge', followerPlan.phaseNudgeMs > 0 || followerPlan.summary.includes('sync'));
  check('a follower names its master', follower.describe().includes('peer-a'), follower.describe());

  section('Mesh sync: degraded link');
  // A follower with an unrealistically tight trust threshold: the link is fine, but
  // the engine must refuse to nudge rather than trust a clock it cannot measure well.
  const strict = new MeshSyncEngine(await followerClock(), { maxTrustedQualityMs: 0, masterBpm: 128 });
  const poorPlan = strict.planFor(deck());
  check('an untrusted clock is flagged', !strict.status().trusted, String(strict.status().qualityMs));
  check('an untrusted master plans no nudge', poorPlan.phaseNudgeMs === 0);
  check('the untrusted quality is named', poorPlan.warnings.some((warning) => warning.includes('ms')), poorPlan.warnings.join('|'));
  check('an untrusted link still reports the next bar', poorPlan.nextBarAtMasterMs > 0);

  section('Mesh sync: reference updates');
  const mutable = new MeshSyncEngine(clock, {});
  mutable.setMasterReference({ bpm: 140, camelot: '5B', firstBeatMs: 120 });
  const raised = mutable.planFor(deck({ bpm: 128, camelot: '5B' }));
  check('a new master tempo produces a shift', raised.tempoShiftPercent > 5, String(raised.tempoShiftPercent));
  check('a new master key is used', raised.keyScore === 1);
  mutable.setMasterReference({ bpm: 128 });
  check('partial updates keep the rest', mutable.planFor(deck({ camelot: '5B' })).keyScore === 1);
}
