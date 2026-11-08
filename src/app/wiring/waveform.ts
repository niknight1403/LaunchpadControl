import { buildMarkers, buildWaveformData, bucketWeights, loudestPosition, type WaveformData } from '../../analysis/WaveformData';
import type { StudioContext, StudioPlugin } from '../Studio';

/**
 * Sprint 15 wiring: analysed waveforms reach the screen and the pads.
 *
 * The analysis existed as a data structure nothing rendered. Two decisions live here:
 * how many buckets to build (enough for a phone-width waveform, not enough to hurt), and
 * how a bucket becomes a pad colour — the pad grid shows the *band* mix, so a bass-heavy
 * section looks different from a hi-hat breakdown.
 */
export interface WaveformWiring {
  build(deck: number, channels: readonly Float32Array[], sampleRate: number): { buckets: number; markers: number; loudest: number } | null;
  data(deck: number): WaveformData | undefined;
  /** 0..1 brightness for a pad column, from the low/mid/high mix of that region. */
  brightness(deck: number, column: number): number;
  /** Colour for a pad column: bass-heavy is pink, highs-heavy is cyan. */
  color(deck: number, column: number): { r: number; g: number; b: number };
}

const BUCKETS = 384;

export function waveformPlugin(): StudioPlugin & { wiring: WaveformWiring | null } {
  const plugin: StudioPlugin & { wiring: WaveformWiring | null } = {
    name: 'waveform',
    sprint: 15,
    wiring: null,
    install(ctx: StudioContext) {
      const bucketAt = (deck: number, column: number) => {
        const data = ctx.state.decks[deck]?.waveform;
        if (!data || data.buckets.length === 0) return null;
        // Eight pad columns over 384 buckets: take the loudest bucket in the column's
        // slice, because an average hides a kick that only appears for two buckets.
        const perColumn = Math.max(1, Math.floor(data.buckets.length / 8));
        const from = Math.min(data.buckets.length - 1, Math.max(0, column) * perColumn);
        const to = Math.min(data.buckets.length, from + perColumn);
        let best = data.buckets[from]!;
        let bestWeight = -1;
        for (let index = from; index < to; index += 1) {
          const bucket = data.buckets[index]!;
          const weight = bucketWeights(bucket);
          const total = weight.low + weight.mid + weight.high;
          if (total > bestWeight) {
            bestWeight = total;
            best = bucket;
          }
        }
        return best;
      };

      const wiring: WaveformWiring = {
        build: (deck, channels, sampleRate) => {
          const grid = ctx.state.decks[deck]?.grid ?? null;
          const data = buildWaveformData(channels, sampleRate, grid, { bucketCount: BUCKETS });
          const deckState = ctx.state.decks[deck];
          if (deckState) deckState.waveform = data;
          ctx.notify();
          ctx.log('waveform', `deck ${deck}: ${data.buckets.length} buckets, ${data.markers?.length ?? 0} markers`);
          return { buckets: data.buckets.length, markers: data.markers?.length ?? 0, loudest: loudestPosition(data) };
        },
        data: (deck) => ctx.state.decks[deck]?.waveform,
        brightness: (deck, column) => {
          const bucket = bucketAt(deck, column);
          if (!bucket) return 0.12;
          const weight = bucketWeights(bucket);
          // A floor keeps an empty column visible instead of a dead pad.
          return Math.min(1, Math.max(0.12, (weight.low + weight.mid + weight.high) / 3));
        },
        color: (deck, column) => {
          const bucket = bucketAt(deck, column);
          if (!bucket) return { r: 14, g: 20, b: 34 };
          const weight = bucketWeights(bucket);
          const total = Math.max(1e-6, weight.low + weight.mid + weight.high);
          // Weighted blend between the accent colours instead of a per-bucket palette,
          // so the grid reads as one instrument.
          return {
            r: Math.round(255 * (weight.low / total)),
            g: Math.round(242 * (weight.high / total)),
            b: Math.round(254 * (weight.mid / total)),
          };
        },
      };
      plugin.wiring = wiring;

      ctx.provide('buildWaveform', wiring.build);
      ctx.provide('waveformData', wiring.data);
      ctx.provide('waveformBrightness', wiring.brightness);

      // Rebuild markers when a grid arrives later: an analysed track usually gets its
      // grid after its waveform, and markers without a grid are just buckets.
      ctx.subscribe(() => {
        ctx.state.decks.forEach((deck, index) => {
          if (!deck.waveform || !deck.grid) return;
          if ((deck.waveform.markers?.length ?? 0) > 0) return;
          const durationSeconds = deck.waveform.buckets.length * deck.waveform.secondsPerBucket;
          const markers = buildMarkers(deck.grid, durationSeconds, deck.waveform.buckets.length, deck.waveform.secondsPerBucket);
          if (markers.length > 0) {
            deck.waveform.markers = markers;
            ctx.log('waveform', `deck ${index}: ${markers.length} markers added`);
          }
        });
      });
    },
    dispose() {
      /* nothing held */
    },
  };
  return plugin;
}
