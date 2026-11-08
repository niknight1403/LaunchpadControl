import { makeGrid, type BeatGrid } from './BeatGrid';

/**
 * Waveform data for the UI: colour per band, plus the beat grid baked in.
 *
 * A flat RMS waveform tells you where the loud parts are and nothing else. Splitting
 * each bucket into low/mid/high lets the renderer draw the low end in a different
 * colour, which is how you spot the drop, the breakdown and the vocal-less bar at a
 * glance. Built once per track on import, so the UI never touches raw samples.
 */

export interface WaveformBucket {
  /** Peak magnitude per band, 0..1. */
  low: number;
  mid: number;
  high: number;
  /** Overall peak of the bucket, for the silhouette. */
  peak: number;
  /** RMS of the bucket, 0..1. */
  rms: number;
}

export interface BeatMarker {
  /** Bucket index the marker falls in. */
  bucket: number;
  /** Seconds from the start of the file. */
  seconds: number;
  /** Beat index on the grid, may be fractional after downsampling. */
  beat: number;
  /** True on a bar line. */
  isBar: boolean;
}

export interface WaveformData {
  bucketCount: number;
  /** Seconds represented by one bucket. */
  secondsPerBucket: number;
  buckets: WaveformBucket[];
  markers: BeatMarker[];
  /** Largest peak across all buckets, for normalisation by the renderer. */
  maxPeak: number;
}

export interface WaveformOptions {
  bucketCount?: number;
  /** Band edges in Hz; defaults match the stem splitter. */
  lowCrossoverHz?: number;
  highCrossoverHz?: number;
}

const DEFAULT_BUCKETS = 512;

/**
 * One-pole magnitude estimator.
 *
 * A full FFT per bucket would be exact and pointless: this is a picture, drawn at
 * a few hundred pixels wide, and one pole per band is two multiplies per sample.
 */
function bandEnergies(
  channel: Float32Array,
  from: number,
  to: number,
  sampleRate: number,
  lowCrossoverHz: number,
  highCrossoverHz: number,
): { low: number; mid: number; high: number; peak: number; rms: number } {
  const lowAlpha = Math.min(1, (2 * Math.PI * lowCrossoverHz) / sampleRate);
  const highAlpha = Math.min(1, (2 * Math.PI * highCrossoverHz) / sampleRate);
  let lowState = 0;
  let midState = 0;
  let lowSum = 0;
  let midSum = 0;
  let highSum = 0;
  let peak = 0;
  let sumSquares = 0;
  const length = Math.max(0, to - from);
  if (length === 0) return { low: 0, mid: 0, high: 0, peak: 0, rms: 0 };

  for (let index = from; index < to; index += 1) {
    const value = channel[index] ?? 0;
    // Low band: slow follower. Mid band: the difference of two followers.
    lowState += lowAlpha * (value - lowState);
    midState += highAlpha * (value - midState);
    const low = lowState;
    const mid = midState - lowState;
    const high = value - midState;
    lowSum += low * low;
    midSum += mid * mid;
    highSum += high * high;
    sumSquares += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const norm = 1 / Math.sqrt(length);
  return {
    low: Math.sqrt(lowSum) * norm,
    mid: Math.sqrt(midSum) * norm,
    high: Math.sqrt(highSum) * norm,
    peak,
    rms: Math.sqrt(sumSquares) * norm,
  };
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function buildWaveformData(
  channels: readonly Float32Array[],
  sampleRate: number,
  grid: BeatGrid | null,
  options: WaveformOptions = {},
): WaveformData {
  const bucketCount = Math.max(1, options.bucketCount ?? DEFAULT_BUCKETS);
  const lowCrossover = options.lowCrossoverHz ?? 180;
  const highCrossover = options.highCrossoverHz ?? 2_500;
  const length = channels[0]?.length ?? 0;
  const secondsPerBucket = length > 0 && sampleRate > 0 ? length / sampleRate / bucketCount : 0;
  const buckets: WaveformBucket[] = [];
  const samplesPerBucket = Math.max(1, Math.floor(length / bucketCount));

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const from = bucket * samplesPerBucket;
    const to = Math.min(length, bucket === bucketCount - 1 ? length : from + samplesPerBucket);
    let low = 0;
    let mid = 0;
    let high = 0;
    let peak = 0;
    let rms = 0;
    for (const channel of channels) {
      const band = bandEnergies(channel, from, to, sampleRate, lowCrossover, highCrossover);
      low = Math.max(low, band.low);
      mid = Math.max(mid, band.mid);
      high = Math.max(high, band.high);
      peak = Math.max(peak, band.peak);
      rms = Math.max(rms, band.rms);
    }
    buckets.push({ low: round4(low), mid: round4(mid), high: round4(high), peak: round4(peak), rms: round4(rms) });
  }

  const markers = grid ? buildMarkers(grid, length / sampleRate, bucketCount, secondsPerBucket) : [];
  const maxPeak = buckets.reduce((best, bucket) => Math.max(best, bucket.peak), 0);
  return {
    bucketCount,
    secondsPerBucket: Math.round(secondsPerBucket * 1e6) / 1e6,
    buckets,
    markers,
    maxPeak: round4(maxPeak),
  };
}

/**
 * Beat markers for the renderer.
 *
 * Downsampled so a 512-pixel waveform of a 6-minute track does not carry 800
 * markers: at most one per bucket, and never both a bar line and its own beat.
 */
export function buildMarkers(
  grid: BeatGrid,
  durationSeconds: number,
  bucketCount: number,
  secondsPerBucket: number,
): BeatMarker[] {
  const beatLength = 60 / grid.bpm;
  if (!Number.isFinite(beatLength) || beatLength <= 0 || durationSeconds <= 0 || secondsPerBucket <= 0) return [];

  // Beat 0 *is* the first beat of the grid (firstBeatSeconds is its file
  // position), so the walk starts there. Adding the offset again would push every
  // marker a beat and a half late.
  const markers: BeatMarker[] = [];
  const seenBuckets = new Set<number>();
  for (let beat = 0; ; beat += 1) {
    const seconds = grid.firstBeatSeconds + beat * beatLength;
    if (seconds >= durationSeconds) break;
    const bucket = Math.min(bucketCount - 1, Math.floor(seconds / secondsPerBucket));
    const isBar = beat % grid.beatsPerBar === 0;
    // A bar line outranks a plain beat that shares its bucket.
    if (seenBuckets.has(bucket)) {
      if (!isBar) continue;
      const existing = markers.findIndex((marker) => marker.bucket === bucket);
      if (existing >= 0) markers.splice(existing, 1);
    }
    seenBuckets.add(bucket);
    markers.push({ bucket, seconds: Math.round(seconds * 1000) / 1000, beat, isBar });
    if (markers.length >= bucketCount) break;
  }
  return markers;
}

/** Colour for a bucket, as a 0..1 weight per band. The renderer owns the palette. */
export function bucketWeights(bucket: WaveformBucket): { low: number; mid: number; high: number } {
  const total = bucket.low + bucket.mid + bucket.high;
  if (total <= 1e-9) return { low: 0, mid: 0, high: 0 };
  return {
    low: Math.round((bucket.low / total) * 1000) / 1000,
    mid: Math.round((bucket.mid / total) * 1000) / 1000,
    high: Math.round((bucket.high / total) * 1000) / 1000,
  };
}

/** Where the loudest bucket sits, 0..1 through the track. Handy for "jump to peak". */
export function loudestPosition(data: WaveformData): number {
  if (data.buckets.length === 0) return 0;
  let bestIndex = 0;
  let best = -1;
  data.buckets.forEach((bucket, index) => {
    if (bucket.rms > best) {
      best = bucket.rms;
      bestIndex = index;
    }
  });
  return Math.round((bestIndex / data.buckets.length) * 1000) / 1000;
}

/** Convenience for the tests and the import screen. */
export function gridFor(bpm: number, firstBeatSeconds = 0): BeatGrid {
  return makeGrid(bpm, firstBeatSeconds, 'analysis', 0.8);
}
