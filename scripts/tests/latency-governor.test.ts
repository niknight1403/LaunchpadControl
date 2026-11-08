import {
  DEFAULT_LADDER,
  LatencyGovernor,
  governorSampleFrom,
} from '../../src/engine/LatencyGovernor';
import { check, near, section } from './harness';

const hot = governorSampleFrom(0.9);
const cold = governorSampleFrom(0.2);
const warm = governorSampleFrom(0.5);

/** Feeds a sample n times and returns the last decision. */
function feed(governor: LatencyGovernor, sample: ReturnType<typeof governorSampleFrom>, times: number) {
  let last = governor.observe(sample);
  for (let index = 1; index < times; index += 1) last = governor.observe(sample);
  return last;
}

export async function run(): Promise<void> {
  section('Latency governor: starting point');
  const governor = new LatencyGovernor();
  check('the default buffer is 128 frames', governor.framesPerBuffer === 128);
  check('128 frames at 48 kHz is 2.7 ms', near(governor.bufferMs(48_000), 2.7, 0.05), String(governor.bufferMs(48_000)));
  check('the ladder is documented and ascending', DEFAULT_LADDER.every((value, index) => index === 0 || value > DEFAULT_LADDER[index - 1]!));
  // A custom ladder is sorted on the way in, so a descending list still climbs.
  const custom = new LatencyGovernor({ ladder: [300, 100, 200], initialFrames: 100, cooldownSamples: 0 });
  check('a custom ladder starts where asked', custom.framesPerBuffer === 100);
  feed(custom, hot, 3);
  check('an unsorted ladder climbs in ascending order', custom.framesPerBuffer === 200, String(custom.framesPerBuffer));
  check('an unknown starting point snaps to the nearest step', new LatencyGovernor({ initialFrames: 130 }).framesPerBuffer === 128);

  section('Latency governor: hysteresis');
  const climbing = new LatencyGovernor({ cooldownSamples: 0 });
  check('one hot sample is not enough', climbing.observe(hot).framesPerBuffer === 128);
  climbing.observe(hot);
  const third = climbing.observe(hot);
  check('the third hot sample acts', third.changed && third.framesPerBuffer === 192, String(third.framesPerBuffer));
  check('the decision explains itself', third.reason.includes('sustained'), third.reason);
  check('the direction is reported', third.direction === 'up');
  check('the count of changes is tracked', climbing.changeCount === 1);

  const flickering = new LatencyGovernor({ cooldownSamples: 0 });
  flickering.observe(hot);
  flickering.observe(cold);
  flickering.observe(hot);
  flickering.observe(cold);
  check('alternating samples never trigger a change', flickering.framesPerBuffer === 128);

  section('Latency governor: cooldown');
  const cooling = new LatencyGovernor({ cooldownSamples: 4 });
  // Six hot samples: acted once, then five more inside the cooldown.
  feed(cooling, hot, 6);
  check('a change starts a cooldown', cooling.framesPerBuffer === 192, String(cooling.framesPerBuffer));
  feed(cooling, hot, 4);
  check('after the cooldown it climbs again', cooling.framesPerBuffer === 256, String(cooling.framesPerBuffer));

  section('Latency governor: dropouts');
  const xrunny = new LatencyGovernor({ cooldownSamples: 8 });
  const reaction = xrunny.observe(governorSampleFrom(0.2, 1));
  check('one dropout acts immediately', reaction.changed);
  check('one dropout climbs two steps', reaction.framesPerBuffer === 256, String(reaction.framesPerBuffer));
  check('the reason names the cause', reaction.reason.includes('dropout'), reaction.reason);

  section('Latency governor: descending');
  const descending = new LatencyGovernor({ initialFrames: 256, cooldownSamples: 0 });
  feed(descending, cold, 5);
  check('cooling a little is not enough', descending.framesPerBuffer === 256, String(descending.framesPerBuffer));
  // The sixth cool sample is the one that acts; the one after it holds again.
  const dropped = descending.observe(cold);
  check('a long cool streak steps down', dropped.framesPerBuffer === 192, String(dropped.framesPerBuffer));
  check('the direction is reported', dropped.direction === 'down', dropped.direction);
  check('the step after a change holds', descending.observe(cold).direction === 'hold');

  const settledLow = new LatencyGovernor({ ladder: [64, 128], initialFrames: 64, cooldownSamples: 0 });
  const floor = feed(settledLow, cold, 10);
  check('it never goes below the smallest buffer', floor.framesPerBuffer === 64 && !floor.changed);
  check('the floor is explained', floor.reason.includes('smallest'), floor.reason);

  section('Latency governor: ceiling');
  const ceiling = new LatencyGovernor({ initialFrames: 384, cooldownSamples: 0 });
  const top = feed(ceiling, hot, 20);
  check('it stops at the largest buffer', top.framesPerBuffer === 512, String(top.framesPerBuffer));
  check('it does not keep claiming changes', !top.changed);
  check('the ceiling is explained', top.reason.includes('largest'), top.reason);
  check('a warm phone ends with a bigger buffer than it started', top.framesPerBuffer > 384);

  section('Latency governor: manual reset');
  const manual = new LatencyGovernor({ cooldownSamples: 0 });
  feed(manual, hot, 3);
  check('automation moved it before the reset', manual.framesPerBuffer === 192);
  manual.reset(128);
  check('a manual choice is honoured', manual.framesPerBuffer === 128);
  check('the manual choice is explained', manual.reason.includes('hand'), manual.reason);
  check('resetting forgets the streaks', manual.observe(hot).framesPerBuffer === 128);
  manual.reset(999);
  check('an off-ladder manual value snaps to the nearest step', manual.framesPerBuffer === 512);

  section('Latency governor: realistic run');
  // Simulates a phone that heats up over 40 samples, then cools down again.
  const simulated = new LatencyGovernor({ cooldownSamples: 4, requiredSamples: 3 });
  const trace: number[] = [];
  for (let step = 0; step < 40; step += 1) {
    const load = step < 20 ? 0.5 : 0.95;
    simulated.observe(governorSampleFrom(load, 0));
    trace.push(simulated.framesPerBuffer);
  }
  check('the buffer grows once the phone heats up', trace.at(-1)! > trace[0]!, `${trace[0]} -> ${trace.at(-1)}`);
  check('every change is exactly one ladder step', (() => {
    for (let index = 1; index < trace.length; index += 1) {
      const from = DEFAULT_LADDER.indexOf(trace[index - 1]!);
      const to = DEFAULT_LADDER.indexOf(trace[index]!);
      if (from < 0 || to < 0) return false;
      if (Math.abs(to - from) > 1) return false;
    }
    return true;
  })());
  check('the trace is monotonic in the hot phase', trace.slice(20).every((value, index, array) => index === 0 || value >= array[index - 1]!));
}
