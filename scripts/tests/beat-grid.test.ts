import {
  TapTempo,
  barPhase,
  beatToSeconds,
  currentBar,
  gridDriftMs,
  makeGrid,
  nextBarSeconds,
  refineGridOffset,
  secondsToBeat,
  snapToDivision,
} from '../../src/analysis/BeatGrid';
import { check, near, section } from './harness';

export async function run(): Promise<void> {
  section('Beat grid: conversions');
  const grid = makeGrid(120, 0.25);
  check('one beat at 120 BPM is 500 ms', near(beatToSeconds(grid, 1) - grid.firstBeatSeconds, 0.5, 1e-9));
  check('beat 0 sits on the first beat', near(beatToSeconds(grid, 0), 0.25, 1e-9));
  check('beat 8 sits four seconds later', near(beatToSeconds(grid, 8), 4.25, 1e-9));
  check('conversion roundtrips', near(secondsToBeat(grid, beatToSeconds(grid, 3.7)), 3.7, 1e-9));
  check('negative beats are allowed for prep rolls', beatToSeconds(grid, -2) < grid.firstBeatSeconds);
  check('bpm is clamped into a musical range', makeGrid(900).bpm === 300 && makeGrid(2).bpm === 20);
  check('confidence is clamped', makeGrid(120, 0, 'manual', 5).confidence === 1);

  section('Beat grid: snapping');
  const snapped = snapToDivision(grid, 0.6, 1);
  check('a position near a beat snaps to it', near(snapped.seconds, 0.75, 1e-9), String(snapped.seconds));
  check('the snap reports its delta', near(snapped.deltaSeconds, 0.15, 1e-9));
  check('the snapped position lands on an integer beat', near(snapped.beat, 1, 1e-9));
  const sixteenth = snapToDivision(grid, 0.6, 4);
  check('sixteenth snapping is finer', near(sixteenth.beat, 0.75, 1e-9), String(sixteenth.beat));
  check('a position already on the grid does not move', near(snapToDivision(grid, 0.75, 1).deltaSeconds, 0, 1e-9));

  section('Beat grid: bars');
  check('beat 0 is the start of a bar', near(barPhase(grid, beatToSeconds(grid, 0)), 0, 1e-9));
  check('beat 2 is halfway through the bar', near(barPhase(grid, beatToSeconds(grid, 2)), 0.5, 1e-9));
  check('beat 4 starts the next bar', near(barPhase(grid, beatToSeconds(grid, 4)), 0, 1e-9));
  check('the bar counter is correct', currentBar(grid, beatToSeconds(grid, 9)) === 2);
  check('the next bar line is ahead', nextBarSeconds(grid, beatToSeconds(grid, 5)) > beatToSeconds(grid, 5));
  check('the next bar line lands on a bar boundary', near(currentBar(grid, nextBarSeconds(grid, beatToSeconds(grid, 5.1))), 2, 1e-9));

  section('Beat grid: offset refinement');
  const sloppy = makeGrid(128, 0);
  const onsets = Array.from({ length: 16 }, (_, index) => 0.13 + index * (60 / 128));
  check('the sloppy grid starts to drift', gridDriftMs(sloppy, onsets) > 50, String(gridDriftMs(sloppy, onsets)));
  const refined = refineGridOffset(sloppy, onsets);
  check('the refined grid finds the offset', near(refined.firstBeatSeconds, 0.13, 0.006), String(refined.firstBeatSeconds));
  check('the refined grid has almost no drift', gridDriftMs(refined, onsets) < 8, String(gridDriftMs(refined, onsets)));
  check('refinement never goes negative', refineGridOffset(makeGrid(120, 0), [99.9, 99.95]).firstBeatSeconds >= 0);
  check('refinement without onsets changes nothing', refineGridOffset(sloppy, []).firstBeatSeconds === 0);

  section('Beat grid: tap tempo');
  let clock = 10_000;
  const tapper = new TapTempo({ now: () => clock });
  check('one tap has no tempo yet', tapper.tap().bpm === 0);
  for (let index = 0; index < 5; index += 1) {
    clock += 500;
    tapper.tap();
  }
  const steady = tapper.tap();
  check('a steady 500 ms tap reads 120 BPM', near(steady.bpm, 120, 0.5), String(steady.bpm));
  check('the tap count is reported', steady.taps >= 6);
  check('a steady tap is confident', steady.confidence > 0.9, String(steady.confidence));

  const human = new TapTempo({ now: () => clock });
  const intervals = [500, 512, 489, 505, 480, 520, 495, 508];
  human.tap(0);
  let moment = 0;
  for (const interval of intervals) {
    moment += interval;
    human.tap(moment);
  }
  const humanResult = human.tap(moment + 500);
  check('human jitter still averages out', Math.abs(humanResult.bpm - 120) < 4, String(humanResult.bpm));
  check('jitter lowers confidence', humanResult.confidence < 0.99, String(humanResult.confidence));

  const pausing = new TapTempo({ now: () => clock, resetAfterMs: 2_000 });
  pausing.tap(0);
  pausing.tap(500);
  const afterPause = pausing.tap(9_000);
  check('a long pause restarts the series', afterPause.restarted);
  check('a restarted series has no tempo yet', afterPause.bpm === 0);

  const doubleTap = new TapTempo({ now: () => clock, minIntervalMs: 120 });
  doubleTap.tap(0);
  doubleTap.tap(20); // bounce: must be ignored as an interval
  doubleTap.tap(500);
  const bounced = doubleTap.tap(1_000);
  check('a bounced double tap does not wreck the tempo', near(bounced.bpm, 120, 1), String(bounced.bpm));

  tapper.clear();
  check('clear empties the series', tapper.tapCount === 0);
}
