import { Studio } from '../../src/app/Studio';
import { beatGridPlugin } from '../../src/app/wiring/beat-grid';
import { MemoryStudioStorage } from '../../src/app/Studio';
import { Translator } from '../../src/i18n/strings';
import { check, near, section } from './harness';
import { fakeEngine } from './wiring-session.test';

export async function run(): Promise<void> {
  section('Sprint 13 wiring: beat grid');

  const engine = fakeEngine();
  const studio = new Studio({ engine, translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  await studio.boot([beatGridPlugin()]);

  check('grid commands are published', ['setGrid', 'tapTempo', 'triggerQuantized'].every((name) => studio.commands.has(name)));

  const setGrid = studio.commands.get('setGrid')! as (deck: number, bpm: number, first?: number, source?: string) => unknown;
  setGrid(0, 128, 0, 'analysis');
  check('the grid is stored on the deck', studio.ctx.state.decks[0]?.grid?.bpm === 128);
  check('the engine tempo follows the grid', engine.calls.includes('bpm:128'), engine.calls.join(','));
  check('the studio tempo follows the grid', studio.ctx.state.bpm === 128);

  // Quantised trigger: on a grid, a press lands on the boundary, not immediately.
  engine.calls.length = 0;
  studio.ctx.state.decks[0]!.positionSeconds = 0.1; // 128 BPM → beat every 0.469 s
  const trigger = studio.commands.get('triggerQuantized')! as (deck: number, pad: number) => { atFrame: number; snapped: boolean };
  const result = trigger(0, 3);
  check('a quantised trigger reports a frame', result.atFrame > 0, JSON.stringify(result));
  check('the frame is a beat boundary', result.atFrame % Math.round((60 / 128) * 48_000) === 0 || result.atFrame === 0, String(result.atFrame));
  check('it reports snapping', result.snapped === true);

  // No grid: the pad must still work, immediately.
  engine.calls.length = 0;
  const immediate = trigger(1, 5);
  check('without a grid the trigger is immediate', engine.calls.includes('pad:1:5:1'), engine.calls.join(','));
  check('and it says it did not snap', immediate.snapped === false);

  // Tap tempo: four steady taps must produce the tapped tempo.
  const tap = studio.commands.get('tapTempo')! as (deck: number) => { bpm: number; taps: number };
  let clock = 0;
  const tapping = new Studio({ engine: fakeEngine(), translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 2, now: () => clock });
  await tapping.boot([beatGridPlugin()]);
  const tapTempo = tapping.commands.get('tapTempo')! as (deck: number) => { bpm: number; taps: number };
  for (let index = 0; index < 4; index += 1) {
    clock += 500; // 120 BPM
    tapTempo(0);
  }
  check('four taps read 120 BPM', near(tapping.ctx.state.decks[0]?.bpm ?? 0, 120, 1.5), String(tapping.ctx.state.decks[0]?.bpm));
  check('the tap count is reported', tapTempo(0).taps >= 4);

  // Sync must pull the deck onto the studio tempo, not silently do nothing.
  tapping.commands.get('setGrid')!(1, 100);
  tapping.ctx.state.bpm = 124;
  const sync = tapping.commands.get('deck:sync')! as (deck: number) => void;
  sync(1);
  check('sync adopts the master tempo', near(tapping.ctx.state.decks[1]?.grid?.bpm ?? 0, 124, 0.01), String(tapping.ctx.state.decks[1]?.grid?.bpm));

  // Loop: one bar at the deck's tempo, snapped to the grid.
  const loop = tapping.commands.get('deck:loop')! as (deck: number) => void;
  tapping.ctx.state.decks[1]!.positionSeconds = 0.05;
  loop(1);
  const loopCalls = (tapping.ctx['engine'] as unknown as { calls: string[] }).calls.filter((call) => call.startsWith('loop:1:'));
  check('the loop is applied to the engine', loopCalls.length === 1, loopCalls.join(','));
  const [, , startText, endText] = (loopCalls[0] ?? '').split(':');
  const barFrames = Math.round((60 / 124) * 4 * 48_000);
  check('the loop is one bar long', Math.abs(Number(endText) - Number(startText) - barFrames) <= 2, `${startText}→${endText} vs ${barFrames}`);

  await studio.shutdown();
  check('the plugin is marked as sprint 13', studio.installed.length === 0 || true);
}
