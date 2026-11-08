import { TapTempo, beatSeconds, makeGrid, nextBarSeconds, snapToDivision, type BeatGrid, type Division } from '../../analysis/BeatGrid';
import { asDeck, type StudioContext, type StudioPlugin } from '../Studio';

/**
 * Sprint 13 wiring: the beat grid decides *when* a trigger lands.
 *
 * Quantising is the difference between a pad and a performance control, and it has to
 * happen against the deck's own grid — not the master tempo, not the wall clock. The
 * grid module had all the maths; this plugin owns the decision of which grid is
 * authoritative and turns a press into a frame-accurate trigger.
 */
export interface BeatGridWiring {
  setGrid(deck: number, bpm: number, firstBeatSeconds?: number, source?: 'analysis' | 'tap' | 'manual'): BeatGrid;
  grid(deck: number): BeatGrid | undefined;
  tap(deck: number): { bpm: number; taps: number; confidence: number };
  resetTaps(deck: number): void;
  /** Triggers a pad at the next beat/bar boundary instead of immediately. */
  triggerQuantized(deck: number, pad: number, division?: Division, velocity?: number): { atFrame: number; snapped: boolean };
  nextBarFrame(deck: number): number;
}

export function beatGridPlugin(): StudioPlugin & { wiring: BeatGridWiring | null } {
  const tappers = new Map<number, TapTempo>();
  const plugin: StudioPlugin & { wiring: BeatGridWiring | null } = {
    name: 'beat-grid',
    sprint: 13,
    wiring: null,
    install(ctx: StudioContext) {
      const gridFor = (deck: number): BeatGrid | undefined => ctx.state.decks[deck]?.grid;

      const wiring: BeatGridWiring = {
        setGrid: (deck, bpm, firstBeatSeconds = 0, source = 'manual') => {
          const grid = makeGrid(bpm, firstBeatSeconds, source);
          const deckState = ctx.state.decks[deck];
          if (deckState) {
            deckState.grid = grid;
            deckState.bpm = bpm;
          }
          ctx.engine.setBpm(bpm);
          ctx.state.bpm = bpm;
          ctx.notify();
          ctx.log('grid', `deck ${deck}: ${bpm} BPM (${source})`);
          return grid;
        },
        grid: gridFor,
        tap: (deck) => {
          let tapper = tappers.get(deck);
          if (!tapper) {
            tapper = new TapTempo();
            tappers.set(deck, tapper);
          }
          const result = tapper.tap(ctx.now());
          if (result.bpm > 0) {
            const grid = makeGrid(result.bpm, 0, 'tap', result.confidence);
            const deckState = ctx.state.decks[deck];
            if (deckState) {
              deckState.grid = grid;
              deckState.bpm = result.bpm;
            }
            ctx.state.bpm = result.bpm;
            ctx.engine.setBpm(result.bpm);
            ctx.notify();
          }
          return { bpm: result.bpm, taps: tapper.tapCount, confidence: result.confidence };
        },
        resetTaps: (deck) => {
          tappers.get(deck)?.clear();
        },
        triggerQuantized: (deck, pad, division = 1, velocity = 1) => {
          const grid = gridFor(deck);
          const rate = Math.max(1, ctx.engine.sampleRate);
          if (!grid) {
            ctx.engine.triggerPad(asDeck(deck), pad, velocity);
            ctx.log('grid', `deck ${deck}: no grid, triggered immediately`);
            return { atFrame: 0, snapped: false };
          }
          const nowSeconds = ctx.state.decks[deck]?.positionSeconds ?? 0;
          // A trigger snaps *forward*: snapping to the nearest division can land in the
          // past, which would fire a pad "on the beat" that already went by.
          const boundary = nextDivisionSeconds(grid, nowSeconds, division);
          const waitMs = Math.max(0, (boundary - nowSeconds) * 1000);
          const target = { atFrame: Math.round(boundary * rate), snapped: Math.abs(boundary - nowSeconds) > 0.001 };
          if (waitMs < 4) {
            ctx.engine.triggerPad(asDeck(deck), pad, velocity);
            return target;
          }
          // A short timer, not a long one: anything under a bar keeps the UI honest and
          // is cancelled by the pad's own retrigger.
          setTimeout(() => ctx.engine.triggerPad(asDeck(deck), pad, velocity), waitMs);
          return target;
        },
        nextBarFrame: (deck) => {
          const grid = gridFor(deck);
          if (!grid) return 0;
          const rate = Math.max(1, ctx.engine.sampleRate);
          const from = ctx.state.decks[deck]?.positionSeconds ?? 0;
          return Math.round(nextBarSeconds(grid, from) * rate);
        },
      };
      plugin.wiring = wiring;

      ctx.provide('setGrid', wiring.setGrid);
      ctx.provide('tapTempo', wiring.tap);
      ctx.provide('triggerQuantized', wiring.triggerQuantized);
      ctx.provide('deck:sync', (deck: number) => {
        // Sync pulls this deck's grid onto the master tempo; it does not touch the rate,
        // because that is the DeckController's job and mixing the two causes double work.
        const grid = gridFor(deck);
        if (!grid) {
          ctx.log('grid', `deck ${deck}: sync without a grid`);
          return;
        }
        wiring.setGrid(deck, ctx.state.bpm, grid.firstBeatSeconds, 'tap');
      });
      ctx.provide('deck:loop', (deck: number) => {
        const grid = gridFor(deck);
        if (!grid) return;
        const rate = Math.max(1, ctx.engine.sampleRate);
        const startSeconds = ctx.state.decks[deck]?.positionSeconds ?? 0;
        const barSeconds = (60 / grid.bpm) * grid.beatsPerBar;
        const snapped = snapToDivision(grid, startSeconds, 4);
        ctx.engine.setLoop(asDeck(deck), Math.round(snapped.seconds * rate), Math.round((snapped.seconds + barSeconds) * rate));
        const deckState = ctx.state.decks[deck];
        if (deckState) {
          deckState.loop = { startFrame: Math.round(snapped.seconds * rate), endFrame: Math.round((snapped.seconds + barSeconds) * rate) };
        }
        ctx.notify();
      });
    },
    dispose() {
      tappers.clear();
    },
  };
  return plugin;
}

/** Smallest grid boundary at or after `seconds`, in seconds. */
export function nextDivisionSeconds(grid: BeatGrid, seconds: number, division: Division = 1): number {
  const step = beatSeconds(grid) / division;
  if (!Number.isFinite(step) || step <= 0) return seconds;
  const relative = seconds - grid.firstBeatSeconds;
  // `ceil(x - epsilon)` keeps a press that lands exactly on the line on that line
  // (immediate trigger) instead of pushing it a whole division later.
  const steps = Math.ceil(relative / step - 1e-9);
  return grid.firstBeatSeconds + steps * step;
}
