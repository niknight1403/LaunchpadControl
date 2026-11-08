import { SetRunner, arcTarget, buildSet, chooseTransition } from '../../src/agent/SetBuilder';
import { makeKey, type MusicalKey } from '../../src/agent/harmonic';
import type { Track } from '../../src/agent/AuraGridAgent';
import { check, near, section, sleep } from './harness';

function track(id: string, bpm: number, camelot: string, energy: number): Track {
  const root = Number.parseInt(camelot, 10) - 1;
  const mode: MusicalKey['mode'] = camelot.endsWith('A') ? 'minor' : 'major';
  return {
    id,
    title: `Track ${id}`,
    artist: 'Test',
    path: `/m/${id}.wav`,
    bpm,
    key: makeKey(((root % 12) + 12) % 12 as 0, mode),
    energy,
  };
}

export async function run(): Promise<void> {
  section('Set builder: energy arc');
  check('arc starts at the start energy', near(arcTarget(0, 0.2, 0.7), 0.2, 1e-9));
  check('arc peaks at the peak position', near(arcTarget(0.7, 0.2, 0.7), 1, 1e-9));
  check('arc rises monotonically before the peak', arcTarget(0.3, 0.2, 0.7) < arcTarget(0.5, 0.2, 0.7));
  check('arc descends after the peak', arcTarget(0.95, 0.2, 0.7) < arcTarget(0.7, 0.2, 0.7));
  check('arc ends above the start', arcTarget(1, 0.2, 0.7) > 0.2);
  check('arc clamps out-of-range positions', near(arcTarget(-5, 0.2, 0.7), 0.2, 1e-9) && near(arcTarget(5, 0.2, 0.7), arcTarget(1, 0.2, 0.7), 1e-9));

  section('Set builder: plan');
  const library: Track[] = [
    track('1', 124, '8A', 0.2),
    track('2', 126, '8B', 0.35),
    track('3', 128, '9A', 0.55),
    track('4', 130, '9B', 0.75),
    track('5', 132, '10A', 0.9),
    track('6', 150, '4A', 0.95), // outside the tempo window
    track('7', 100, '11A', 0.6), // outside the tempo window
  ];
  const plan = buildSet(library, { targetMinutes: 18, startEnergy: 0.2, peakAt: 0.7, defaultTrackSeconds: 180 });
  check('plan has entries', plan.entries.length > 1, String(plan.entries.length));
  check('plan excludes the out-of-window tracks', plan.entries.every((entry) => entry.bpm >= 117 && entry.bpm <= 137));
  check('plan warns about excluded tracks', plan.warnings.some((warning) => warning.includes('outside the tempo window')));
  check('entries are laid out in time', plan.entries[1]!.atSeconds > plan.entries[0]!.atSeconds);
  check('total duration matches the last entry', near(plan.totalSeconds, plan.entries.at(-1)!.atSeconds + plan.entries.at(-1)!.durationSeconds, 0.01));
  check('energy roughly follows the arc', (() => {
    const first = plan.entries[0]!.energy;
    const peakIndex = plan.entries.reduce((best, entry, index) => (entry.energy > plan.entries[best]!.energy ? index : best), 0);
    return peakIndex >= Math.floor(plan.entries.length / 2) - 1 && plan.entries[peakIndex]!.energy > first;
  })());
  check('handovers carry a transition', plan.entries.slice(0, -1).every((entry) => entry.transitionOut !== null));
  check('the last entry has no transition', plan.entries.at(-1)!.transitionOut === null);
  check('harmonic score is reported', plan.harmonicScore > 0, String(plan.harmonicScore));
  check('no duplicate tracks in the plan', new Set(plan.entries.map((entry) => entry.trackId)).size === plan.entries.length);

  const empty = buildSet([]);
  check('an empty library yields an empty plan with a warning', empty.entries.length === 0 && empty.warnings.length === 1);

  const narrow = buildSet([track('a', 124, '8A', 0.5), track('b', 175, '8A', 0.5)], { tempoWindow: 0.02 });
  check('a too-narrow window is reported, not silently empty', narrow.entries.length === 0 && (narrow.warnings[0] ?? '').includes('tempo window'));

  section('Set builder: transitions');
  const cut = chooseTransition(track('a', 128, '8A', 0.5), track('b', 128, '8A', 0.5));
  check('identical neighbours get a cut', cut.kind === 'cut' && cut.bars === 0);
  const filtered = chooseTransition(track('a', 128, '8A', 0.2), track('b', 130, '8A', 0.9));
  check('a big energy jump uses the filter', filtered.kind === 'filter' && filtered.bars === 8);
  const looped = chooseTransition(track('a', 128, '8A', 0.5), track('b', 128, '2A', 0.55));
  check('a weak harmonic match uses a loop', looped.kind === 'loop', looped.kind);
  check('tempo shift is reported in percent', Math.abs(cut.tempoShiftPercent) < 0.001);
  const shifted = chooseTransition(track('a', 128, '8A', 0.5), track('b', 132, '8A', 0.55));
  check('a real shift is signed correctly', near(shifted.tempoShiftPercent, 3.1, 0.2), String(shifted.tempoShiftPercent));

  section('Set builder: runner');
  const shortPlan = buildSet(library, { targetMinutes: 3, startEnergy: 0.2, defaultTrackSeconds: 0.25 });
  const events: string[] = [];
  const runner = new SetRunner({ speedFactor: 1 });
  runner.start(shortPlan, {
    onTrack: (entry) => events.push(`track:${entry.trackId}`),
    onTransition: (_transition, from) => events.push(`trans:${from.trackId}`),
    onFinish: () => events.push('finish'),
  });
  check('the first track starts immediately', (events[0] ?? '').startsWith('track:'), events[0]);
  await sleep(shortPlan.totalSeconds * 1000 + 400);
  check('every track was played', shortPlan.entries.every((entry) => events.includes(`track:${entry.trackId}`)), events.join(','));
  check('the runner finishes', events.at(-1) === 'finish');
  check('the runner is idle after finishing', !runner.isRunning);
  runner.stop();

  const skipEvents: string[] = [];
  const skipper = new SetRunner();
  skipper.start(shortPlan, {
    onTrack: (entry) => skipEvents.push(entry.trackId),
    onFinish: () => skipEvents.push('end'),
  });
  skipper.skip();
  check('skip jumps to the next track', skipEvents.length === 2, skipEvents.join(','));
  skipper.skip();
  skipper.stop();
  check('stop clears the plan', !skipper.isRunning && skipper.current === null);
}
