import { splitBands, stemEnergy, type BandSplit } from '../../analysis/StemSplit';
import { asDeck, type StudioContext, type StudioPlugin } from '../Studio';

/**
 * Sprint 14 wiring: the three bands become controls.
 *
 * `splitBands` produced bands offline; nothing could touch them live. This plugin owns
 * the mapping from a stem name to an engine stem, the clamps, and the row layout on the
 * hardware — the three things a DJ expects to be stable between tracks.
 */
export type StemName = 'bass' | 'mid' | 'highs';

export const STEM_NAMES: StemName[] = ['bass', 'mid', 'highs'];

export interface StemWiring {
  /** Splits a decoded buffer and records its band energies for the UI. */
  analyse(deck: number, channels: readonly Float32Array[], sampleRate: number): { bass: number; mid: number; highs: number };
  setGain(deck: number, stem: StemName, gain: number): void;
  /** Silences every band but this one; `null` releases the solo. */
  solo(deck: number, stem: StemName | null): void;
  gains(deck: number): Record<StemName, number>;
  /** Grid row for a stem, so the hardware shows the same layout as the screen. */
  rowOf(stem: StemName): number;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function stemsPlugin(): StudioPlugin & { wiring: StemWiring | null } {
  const splits = new Map<number, BandSplit>();
  const solos = new Map<number, StemName | null>();
  const plugin: StudioPlugin & { wiring: StemWiring | null } = {
    name: 'stems',
    sprint: 14,
    wiring: null,
    install(ctx: StudioContext) {
      const gainsOf = (deck: number): Record<StemName, number> => {
        const deckState = ctx.state.decks[deck];
        const stored = deckState?.stemGains ?? {};
        return {
          bass: stored.bass ?? 1,
          mid: stored.mid ?? 1,
          highs: stored.highs ?? 1,
        };
      };

      const applyGains = (deck: number, gains: Record<StemName, number>) => {
        const deckState = ctx.state.decks[deck];
        if (deckState) deckState.stemGains = { ...gains };
        STEM_NAMES.forEach((stem) => ctx.engine.setStemGain(asDeck(deck), stem, gains[stem]));
        ctx.notify();
      };

      const wiring: StemWiring = {
        analyse: (deck, channels, sampleRate) => {
          const split = splitBands(channels, sampleRate);
          splits.set(deck, split);
          const energy = stemEnergy(split);
          ctx.log('stems', `deck ${deck}: bass ${energy.bass} mid ${energy.mid} highs ${energy.highs}`);
          return energy;
        },
        setGain: (deck, stem, gain) => {
          const gains = gainsOf(deck);
          gains[stem] = clamp01(gain);
          applyGains(deck, gains);
        },
        solo: (deck, stem) => {
          const gains = gainsOf(deck);
          if (stem === null) {
            STEM_NAMES.forEach((name) => {
              gains[name] = 1;
            });
          } else {
            STEM_NAMES.forEach((name) => {
              gains[name] = name === stem ? 1 : 0;
            });
          }
          solos.set(deck, stem);
          applyGains(deck, gains);
          ctx.log('stems', `deck ${deck}: ${stem === null ? 'solo released' : `solo ${stem}`}`);
        },
        gains: gainsOf,
        rowOf: (stem) => STEM_NAMES.indexOf(stem),
      };
      plugin.wiring = wiring;

      ctx.provide('analyseStems', wiring.analyse);
      ctx.provide('setStemGain', wiring.setGain);
      ctx.provide('soloStem', wiring.solo);
      ctx.provide('stemGains', wiring.gains);

      // Hardware rows show which stem is loaded and whether it is muted, so the grid and
      // the screen never disagree about what row 2 means.
      if (ctx.midi?.setPad) {
        const paint = (deck: number) => {
          const gains = gainsOf(deck);
          STEM_NAMES.forEach((stem, row) => {
            const gain = gains[stem];
            const color = gain === 0 ? { r: 40, g: 20, b: 20 } : gain < 0.99 ? { r: 255, g: 176, b: 32 } : { r: 0, g: 242, b: 254 };
            ctx.midi?.setPad?.(row, deck, color, gain === 0 ? 'flash' : 'static');
          });
          ctx.midi?.flush?.();
        };
        ctx.subscribe(() => paint(ctx.state.selectedDeck));
        paint(ctx.state.selectedDeck);
      }
    },
    dispose() {
      splits.clear();
      solos.clear();
    },
  };
  return plugin;
}
