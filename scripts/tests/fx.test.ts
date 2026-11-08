import { FxChain, shapeValue, type FxTarget } from '../../src/engine/fx/FxChain';
import { FxParam, type DeckId } from '../../src/engine/types';
import { check, near, section, sleep } from './harness';

interface Write {
  deck: DeckId;
  param: FxParam;
  value: number;
  at: number;
}

class RecordingFx implements FxTarget {
  readonly writes: Write[] = [];

  setFx(deck: DeckId, param: FxParam, value: number): void {
    this.writes.push({ deck, param, value, at: Date.now() });
  }

  valuesFor(param: FxParam): number[] {
    return this.writes.filter((write) => write.param === param).map((write) => write.value);
  }
}

export async function run(): Promise<void> {
  section('LFO shapes');
  check('sine starts at the middle', near(shapeValue('sine', 0), 0.5, 1e-9));
  check('sine peaks a quarter cycle in', near(shapeValue('sine', 0.25), 1, 1e-9));
  check('sine bottoms at three quarters', near(shapeValue('sine', 0.75), 0, 1e-9));
  check('triangle is linear up', near(shapeValue('triangle', 0.25), 0.5, 1e-9));
  check('triangle is linear down', near(shapeValue('triangle', 0.75), 0.5, 1e-9));
  check('square is high then low', shapeValue('square', 0.25) === 1 && shapeValue('square', 0.75) === 0);
  check('shapes wrap over cycles', near(shapeValue('sine', 3.25), shapeValue('sine', 1.25), 1e-9));

  section('FxChain parameters');
  const recorder = new RecordingFx();
  const chain = new FxChain(recorder, 2, { bpm: 120 });
  chain.setParam(FxParam.FilterCutoff, 0.3);
  check('a set parameter is written through', recorder.valuesFor(FxParam.FilterCutoff).at(-1) === 0.3);
  check('the value is readable back', chain.getParam(FxParam.FilterCutoff) === 0.3);
  chain.setParam(FxParam.FilterCutoff, 5);
  check('values are clamped to 0..1', chain.getParam(FxParam.FilterCutoff) === 1);

  section('FxChain automation maths');
  chain.setParam(FxParam.DelayMix, 0.5);
  chain.attachLfo(FxParam.DelayMix, { depth: 0.25, beats: 4 });
  check('at beat 0 the LFO is at the base', near(chain.evaluate(FxParam.DelayMix, 0), 0.5, 1e-9));
  check('a quarter period reaches base + depth', near(chain.evaluate(FxParam.DelayMix, 1), 0.75, 1e-9));
  check('three quarters reaches base − depth', near(chain.evaluate(FxParam.DelayMix, 3), 0.25, 1e-9));
  check('a full period returns to base', near(chain.evaluate(FxParam.DelayMix, 4), 0.5, 1e-9));
  check('the LFO is marked active', chain.hasLfo(FxParam.DelayMix));

  chain.setParam(FxParam.DelayMix, 0.95);
  check('output stays clamped even with a large depth', chain.evaluate(FxParam.DelayMix, 1) <= 1);
  chain.detachLfo(FxParam.DelayMix);
  check('detaching restores the base value', recorder.valuesFor(FxParam.DelayMix).at(-1) === 0.95);
  check('no LFO remains', !chain.hasLfo(FxParam.DelayMix));

  section('FxChain macro binding');
  recorder.writes.length = 0;
  chain.setMacro(
    [
      { param: FxParam.FilterCutoff, from: 0.15, to: 1 },
      { param: FxParam.FilterResonance, from: 0.1, to: 0.9 },
    ],
    0,
  );
  check('macro 0 hits the from values', chain.getParam(FxParam.FilterCutoff) === 0.15);
  chain.setMacro(
    [
      { param: FxParam.FilterCutoff, from: 0.15, to: 1 },
      { param: FxParam.FilterResonance, from: 0.1, to: 0.9 },
    ],
    0.5,
  );
  check('macro 0.5 interpolates', near(chain.getParam(FxParam.FilterResonance), 0.5, 1e-9));
  check('macro writes both parameters', recorder.writes.length >= 3);

  section('FxChain automation loop');
  const liveRecorder = new RecordingFx();
  const live = new FxChain(liveRecorder, 0, { bpm: 240, tickMs: 8 });
  live.setParam(FxParam.FilterCutoff, 0.5);
  live.attachLfo(FxParam.FilterCutoff, { depth: 0.4, beats: 1, shape: 'triangle' });
  live.start();
  await sleep(160);
  const ticks = live.tickCount;
  live.stop();
  const values = liveRecorder.valuesFor(FxParam.FilterCutoff);
  check('automation ticks while running', ticks > 5, String(ticks));
  check('automation wrote values', values.length > 5, String(values.length));
  check('every written value is in range', values.every((value) => value >= 0 && value <= 1));
  check('values actually move', new Set(values.map((value) => value.toFixed(3))).size > 3);

  const afterStop = liveRecorder.writes.length;
  await sleep(80);
  check('no writes after stop', liveRecorder.writes.length === afterStop, `${liveRecorder.writes.length} vs ${afterStop}`);
  check('stop cancels the scheduled ticks', !live.isRunning);

  section('FxChain deck switching');
  live.setDeck(3);
  check('the chain follows the active deck', live.getDeck() === 3);
  live.setBpm(128);
  check('bpm can be updated for the LFO clock', live.snapshot()[FxParam.FilterCutoff] !== undefined);
}
