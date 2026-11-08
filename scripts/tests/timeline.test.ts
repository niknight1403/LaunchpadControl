import { LookaheadTimeline } from '../../src/agent/Timeline';
import { check, near, section, sleep } from './harness';

export async function run(): Promise<void> {
  section('Lookahead timeline');
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

  // Cancel semantics: a cancelled tag must not fire.
  const cancelTimeline = new LookaheadTimeline({ tickMs: 5, lookaheadMs: 10 });
  let cancelledFired = false;
  cancelTimeline.start();
  cancelTimeline.schedule('t1', Date.now() + 10, () => {
    cancelledFired = true;
  }, 'transition');
  cancelTimeline.cancelTag('transition');
  await sleep(60);
  cancelTimeline.stop();
  check('cancelTag prevents execution', !cancelledFired);
}
