/**
 * Tempo estimation from a decoded audio buffer.
 *
 * Approach: RMS energy envelope → half-wave rectified flux (onsets) →
 * normalised autocorrelation over the musical tempo range → parabolic peak
 * refinement. Classic and dependency-free; it runs on the JS thread in a few
 * milliseconds for a full track because it works on the envelope, not samples.
 *
 * Honest limitation: energy flux favours percussive material. For a sustained
 * pad with no transients the estimate gets weak, and `confidence` says so —
 * callers must check confidence before trusting the number. The audio engine
 * path (spectral flux in C++) is the upgrade, not a workaround.
 */

export interface BeatOptions {
  /** Samples per envelope frame. 64–256 is sensible. */
  hopSize?: number;
  minBpm?: number;
  maxBpm?: number;
}

export interface BpmEstimate {
  bpm: number;
  /** 0..1. Below ~0.25 the estimate is a guess. */
  confidence: number;
  frames: number;
}

export function onsetEnvelope(samples: readonly number[], hopSize: number): Float64Array {
  const frames = Math.floor(samples.length / hopSize);
  const rms = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const offset = frame * hopSize;
    for (let i = 0; i < hopSize; i += 1) {
      const value = samples[offset + i] ?? 0;
      sum += value * value;
    }
    rms[frame] = Math.sqrt(sum / hopSize);
  }

  // Half-wave rectified difference: only energy *increases* are onsets.
  const flux = new Float64Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    const delta = (rms[frame] ?? 0) - (rms[frame - 1] ?? 0);
    flux[frame] = delta > 0 ? delta : 0;
  }
  return flux;
}

function normalisedAutocorrelation(
  signal: Float64Array,
  minLag: number,
  maxLag: number,
): Float64Array {
  const result = new Float64Array(maxLag + 2);
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag += 1) {
    const count = signal.length - lag;
    if (count <= 0) break;
    let sum = 0;
    for (let i = 0; i < count; i += 1) sum += (signal[i] ?? 0) * (signal[i + lag] ?? 0);
    result[lag] = sum / count;
  }
  return result;
}

export function detectBpm(
  samples: readonly number[],
  sampleRate: number,
  options: BeatOptions = {},
): BpmEstimate | null {
  const hopSize = options.hopSize ?? 128;
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 180;
  if (samples.length < sampleRate * 2) return null; // need at least two seconds

  const flux = onsetEnvelope(samples, hopSize);
  if (flux.length < 8) return null;

  // Remove the DC component: a track with constant loudness would otherwise
  // autocorrelate with itself and produce a confident, wrong answer.
  let mean = 0;
  for (const value of flux) mean += value;
  mean /= flux.length;
  const centred = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i += 1) centred[i] = (flux[i] ?? 0) - mean;

  const framesPerSecond = sampleRate / hopSize;
  const minLag = Math.max(2, Math.round((60 / maxBpm) * framesPerSecond));
  const maxLag = Math.min(centred.length - 1, Math.round((60 / minBpm) * framesPerSecond));
  if (maxLag <= minLag) return null;

  const correlation = normalisedAutocorrelation(centred, minLag, maxLag);

  let bestLag = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  let windowSum = 0;
  let windowCount = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = correlation[lag] ?? 0;
    windowSum += value;
    windowCount += 1;
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestValue <= 0) return null;

  // Parabolic interpolation around the peak: the true period rarely lands on an
  // integer frame, and rounding it is a 1–2 BPM error on short loops.
  const previous = correlation[bestLag - 1] ?? 0;
  const current = bestValue;
  const next = correlation[bestLag + 1] ?? 0;
  const denominator = previous - 2 * current + next;
  const shift = Math.abs(denominator) > 1e-12 ? (0.5 * (previous - next)) / denominator : 0;
  const refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, shift));

  const bpm = (60 * framesPerSecond) / refinedLag;
  const windowMean = windowCount > 0 ? windowSum / windowCount : 0;
  const confidence = Math.max(0, Math.min(1, (current - windowMean) / (Math.abs(current) + 1e-9)));

  // Fold into the searched range: octave errors are the usual failure, and a
  // 240 BPM reading of a 120 BPM track helps nobody on a dance floor.
  let folded = bpm;
  while (folded < minBpm) folded *= 2;
  while (folded > maxBpm) folded /= 2;

  return {
    bpm: Math.round(folded * 10) / 10,
    confidence: Math.round(confidence * 1000) / 1000,
    frames: flux.length,
  };
}

/** Rounds to a musically meaningful tempo: 128, not 127.94. */
export function quantiseBpm(bpm: number, grid = 0.5): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 120;
  return Math.round(bpm / grid) * grid;
}

/** Beats per bar for 4/4 material; kept explicit so 3/4 can be added later. */
export const DEFAULT_BEATS_PER_BAR = 4;

/** Seconds per bar at a given tempo. */
export function barDurationSeconds(bpm: number, beatsPerBar = DEFAULT_BEATS_PER_BAR): number {
  if (bpm <= 0) return 2;
  return (60 / bpm) * beatsPerBar;
}
