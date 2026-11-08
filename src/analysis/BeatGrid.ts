/**
 * Beat grid: the difference between a track that drops in and one that stumbles.
 *
 * Analysis gives a BPM with a confidence, tap tempo gives a human correction, and
 * both end up as one grid: a tempo plus a first-beat offset. Everything the UI and
 * the agent schedule is expressed through this object, so a manually nudged grid
 * immediately moves the cue points, the loop and the quantise targets together.
 */

export type GridSource = 'analysis' | 'tap' | 'manual';

export interface BeatGrid {
  bpm: number;
  /** Seconds from the start of the file to the first downbeat. */
  firstBeatSeconds: number;
  source: GridSource;
  /** 0..1; 1 means the grid was confirmed by tapping or by a clean analysis. */
  confidence: number;
  beatsPerBar: number;
}

export interface TapResult {
  bpm: number;
  taps: number;
  confidence: number;
  /** True when the tap series restarted because of a long pause. */
  restarted: boolean;
}

export interface TapTempoOptions {
  now?: () => number;
  /** A pause longer than this restarts the series. */
  resetAfterMs?: number;
  /** A tap closer than this to the previous one is a bounce, not a tempo. */
  minIntervalMs?: number;
  /** How many taps to average over. */
  window?: number;
}

export function makeGrid(bpm: number, firstBeatSeconds = 0, source: GridSource = 'manual', confidence = 1, beatsPerBar = 4): BeatGrid {
  return {
    bpm: Math.max(20, Math.min(300, bpm)),
    firstBeatSeconds: Math.max(0, firstBeatSeconds),
    source,
    confidence: Math.min(1, Math.max(0, confidence)),
    beatsPerBar,
  };
}

export function beatSeconds(grid: BeatGrid): number {
  return 60 / grid.bpm;
}

/** Beat index (can be fractional or negative) to file position in seconds. */
export function beatToSeconds(grid: BeatGrid, beat: number): number {
  return grid.firstBeatSeconds + beat * beatSeconds(grid);
}

/** File position to beat index. */
export function secondsToBeat(grid: BeatGrid, seconds: number): number {
  return (seconds - grid.firstBeatSeconds) / beatSeconds(grid);
}

export type Division = 1 | 2 | 4 | 8;

export interface SnapResult {
  seconds: number;
  beat: number;
  /** Distance the input had to move, in seconds. Positive = moved later. */
  deltaSeconds: number;
}

/** Snaps to the nearest note division (1 = beat, 4 = sixteenth). */
export function snapToDivision(grid: BeatGrid, seconds: number, division: Division = 1): SnapResult {
  const beat = secondsToBeat(grid, seconds);
  const step = 1 / division;
  const snappedBeat = Math.round(beat / step) * step;
  const snapped = beatToSeconds(grid, snappedBeat);
  return { seconds: snapped, beat: snappedBeat, deltaSeconds: snapped - seconds };
}

/** Position inside the bar, 0..1. */
export function barPhase(grid: BeatGrid, seconds: number): number {
  const beat = secondsToBeat(grid, seconds);
  const inBar = ((beat % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar;
  return inBar / grid.beatsPerBar;
}

export function currentBar(grid: BeatGrid, seconds: number): number {
  const beat = secondsToBeat(grid, seconds);
  return Math.floor(beat / grid.beatsPerBar);
}

export function nextBarSeconds(grid: BeatGrid, seconds: number): number {
  const beat = secondsToBeat(grid, seconds);
  const bar = Math.ceil(beat / grid.beatsPerBar + 1e-9);
  return beatToSeconds(grid, bar * grid.beatsPerBar);
}

/**
 * Fits the first-beat offset to detected onsets.
 *
 * The BPM is taken as given (it is the reliable half of the estimate); the phase
 * is what actually goes wrong, so the offset is fitted with a circular mean: a
 * plain average would put a grid straddling midnight exactly between two beats.
 */
export function refineGridOffset(grid: BeatGrid, onsetSeconds: readonly number[]): BeatGrid {
  if (onsetSeconds.length === 0) return grid;
  const beatLen = beatSeconds(grid);
  let sumSin = 0;
  let sumCos = 0;
  for (const onset of onsetSeconds) {
    const phase = (((onset - grid.firstBeatSeconds) / beatLen) % 1) * 2 * Math.PI;
    sumSin += Math.sin(phase);
    sumCos += Math.cos(phase);
  }
  const meanPhase = Math.atan2(sumSin / onsetSeconds.length, sumCos / onsetSeconds.length);
  // A positive mean phase means the onsets sit after our beat lines, so the grid
  // has to move later by that fraction of a beat.
  const shift = (meanPhase / (2 * Math.PI)) * beatLen;
  const refined: BeatGrid = {
    ...grid,
    firstBeatSeconds: Math.max(0, grid.firstBeatSeconds + shift),
    source: grid.source === 'analysis' ? 'analysis' : grid.source,
  };
  return refined;
}

/** Mean absolute distance of onsets to their nearest grid line, in ms. */
export function gridDriftMs(grid: BeatGrid, onsetSeconds: readonly number[]): number {
  if (onsetSeconds.length === 0) return 0;
  const beatLen = beatSeconds(grid);
  const total = onsetSeconds.reduce((sum, onset) => {
    const beat = secondsToBeat(grid, onset);
    const distance = Math.abs(beat - Math.round(beat)) * beatLen;
    return sum + distance;
  }, 0);
  return Math.round((total / onsetSeconds.length) * 1000 * 10) / 10;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/**
 * Tap tempo with a rolling window and outlier rejection.
 *
 * Drummers tap ahead, phones lag, and the third tap of a series is always
 * nervous. The median interval ignores all of that better than a mean does.
 */
export class TapTempo {
  private taps: number[] = [];
  private now: () => number;
  private resetAfterMs: number;
  private minIntervalMs: number;
  private window: number;

  constructor(options: TapTempoOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.resetAfterMs = options.resetAfterMs ?? 2_500;
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.window = options.window ?? 8;
  }

  get tapCount(): number {
    return this.taps.length;
  }

  clear(): void {
    this.taps = [];
  }

  tap(atMs?: number): TapResult {
    const moment = atMs ?? this.now();
    const last = this.taps[this.taps.length - 1];

    // A bounce lands milliseconds after a real tap. Dropping the interval is not
    // enough: the bounce would still break the *next* interval in half, so the
    // tap itself has to be ignored.
    if (last !== undefined && moment - last < this.minIntervalMs) {
      return this.compute(false);
    }

    let restarted = false;
    if (last !== undefined && moment - last > this.resetAfterMs) {
      this.taps = [];
      restarted = true;
    }
    this.taps.push(moment);
    if (this.taps.length > this.window + 1) this.taps.shift();
    return this.compute(restarted);
  }

  private compute(restarted: boolean): TapResult {
    const intervals: number[] = [];
    for (let index = 1; index < this.taps.length; index += 1) {
      const interval = this.taps[index]! - this.taps[index - 1]!;
      if (interval >= this.minIntervalMs) intervals.push(interval);
    }
    if (intervals.length === 0) {
      return { bpm: 0, taps: this.taps.length, confidence: 0, restarted };
    }

    const middle = median(intervals);
    const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
    const spread = Math.sqrt(variance) / mean;
    // Confidence grows with the number of intervals and shrinks with their spread.
    const count = Math.min(1, intervals.length / 4);
    const confidence = Math.max(0, Math.min(1, count * (1 - Math.min(1, spread * 2))));
    return {
      bpm: Math.round((60_000 / middle) * 100) / 100,
      taps: this.taps.length,
      confidence: Math.round(confidence * 1000) / 1000,
      restarted,
    };
  }
}
