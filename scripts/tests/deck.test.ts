import { DeckController, type DeckControlTarget } from '../../src/engine/DeckController';
import { AudioEngine } from '../../src/engine/AudioEngine';
import type { DeckId } from '../../src/engine/types';
import { check, near, section } from './harness';

interface Call {
  method: string;
  deck: DeckId;
  args: number[];
}

/** Records every control call so the maths can be checked exactly. */
class RecordingTarget implements DeckControlTarget {
  readonly sampleRate = 48000;
  readonly currentBpm = 124;
  readonly calls: Call[] = [];

  setLoop(deck: DeckId, startFrame: number, endFrame: number): void {
    this.calls.push({ method: 'setLoop', deck, args: [startFrame, endFrame] });
  }

  clearLoop(deck: DeckId): void {
    this.calls.push({ method: 'clearLoop', deck, args: [] });
  }

  setDeckRate(deck: DeckId, rate: number): void {
    this.calls.push({ method: 'setDeckRate', deck, args: [rate] });
  }

  seek(deck: DeckId, frame: number): void {
    this.calls.push({ method: 'seek', deck, args: [frame] });
  }

  last(method: string): Call | undefined {
    return [...this.calls].reverse().find((call) => call.method === method);
  }
}

export async function run(): Promise<void> {
  section('Deck controller: beat maths');
  const target = new RecordingTarget();
  const controller = new DeckController(target, 1, { clipBpm: 120 });

  // 120 BPM at 48 kHz: one beat = 0.5 s = 24000 frames.
  check('one beat is 24000 frames at 120 BPM', controller.beatFrames(1) === 24000, String(controller.beatFrames(1)));
  check('one bar is 96000 frames', controller.beatFrames(4) === 96000);
  check('frames convert back to beats', near(controller.framesToBeats(24000), 1, 1e-9));
  check('a 128 BPM clip changes the grid', new DeckController(target, 0, { clipBpm: 128 }).beatFrames(4) === 90000);

  section('Deck controller: cue and seek');
  controller.setCuePoint(8);
  check('cue point reported in frames', controller.state.cueFrame === 192000, String(controller.state.cueFrame));
  const jumped = controller.jumpToCue();
  check('jumpToCue seeks the core', jumped === 192000 && target.last('seek')?.args[0] === 192000);
  check('seek targets the right deck', target.last('seek')?.deck === 1);
  controller.jumpToBeat(-4);
  check('a negative beat is clamped to zero', target.last('seek')?.args[0] === 0);

  section('Deck controller: loops');
  const loop = controller.setLoopBars(1, 1);
  check('one bar from bar 1 starts at beat 4', loop.startBeat === 4 && loop.lengthBeats === 4);
  check('loop start frame', target.last('setLoop')?.args[0] === 96000, String(target.last('setLoop')?.args[0]));
  check('loop end frame', target.last('setLoop')?.args[1] === 192000, String(target.last('setLoop')?.args[1]));
  check('loop is reported active', controller.loopActive && controller.state.loopFrames?.endFrame === 192000);

  controller.halveLoop();
  check('halving gives a two-beat loop', controller.state.loop?.lengthBeats === 2);
  controller.doubleLoop();
  controller.doubleLoop();
  check('doubling twice gives eight beats', controller.state.loop?.lengthBeats === 8, String(controller.state.loop?.lengthBeats));
  controller.clearLoop();
  check('clearing removes the loop', !controller.loopActive && target.last('clearLoop') !== undefined);

  const tight = new DeckController(target, 2, { clipBpm: 120, minLoopBeats: 1, maxLoopBeats: 8 });
  tight.setLoop(0, 0.25);
  check('loop length is clamped to the minimum', tight.state.loop?.lengthBeats === 1);
  tight.setLoop(0, 64);
  check('loop length is clamped to the maximum', tight.state.loop?.lengthBeats === 8);

  section('Deck controller: beatmatching');
  const syncController = new DeckController(target, 0, { clipBpm: 128 });
  const rate = syncController.syncTo(128);
  check('sync to the same tempo is unity rate', rate === 1);
  check('effective bpm follows the rate', syncController.effectiveBpm() === 128);

  const slower = new DeckController(target, 0, { clipBpm: 132 });
  const applied = slower.syncTo(126);
  check('sync applies a rate below 1', near(applied, 0.9545, 0.001), String(applied));
  check('sync reports beatmatched', slower.state.beatmatched);

  const halfTime = new DeckController(target, 0, { clipBpm: 87 });
  const halfRate = halfTime.syncTo(174);
  check('half-time is chosen when it lands closer', near(halfRate, 1, 0.001), String(halfRate));

  // 60 BPM clip against 200 BPM master: the double-time match (1.667) is
  // musically correct and inside the clamp window, so that is what must win.
  const doubleTime = new DeckController(target, 0, { clipBpm: 60 });
  check('double-time match beats a 3.3x stretch', near(doubleTime.syncTo(200), 1.6667, 0.001), String(doubleTime.syncTo(200)));

  const nudgeController = new DeckController(target, 0, { clipBpm: 128 });
  nudgeController.syncTo(128);
  nudgeController.nudge(0.02);
  check('nudge raises the rate by 2 %', near(nudgeController.state.rate, 1.02, 1e-6), String(nudgeController.state.rate));
  nudgeController.nudge(10);
  check('nudge is clamped at the ceiling', nudgeController.state.rate === 2);
  check('resetRate returns to unity', nudgeController.resetRate() === 1);

  section('Deck controller: integration with the silent engine');
  const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 128 });
  await engine.start();
  const real = new DeckController(engine, 3, { clipBpm: 124 });
  real.setClipBpm(124);
  real.setLoopBars(2, 2);
  check('engine records the loop in its deck state', engine.getDeckState(3)?.loop?.endFrame === real.state.loopFrames?.endFrame);
  real.syncTo(128);
  check('engine records the rate in its deck state', near(engine.getDeckState(3)?.rate ?? 0, 128 / 124, 0.001));
  real.clearLoop();
  check('engine clears the loop state', engine.getDeckState(3)?.loop === null);
  engine.stop();
}
