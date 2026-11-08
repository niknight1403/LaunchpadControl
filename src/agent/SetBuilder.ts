import type { Track } from './AuraGridAgent';
import { harmonicCompatibility, requiredTempoShift, tempoMatchScore, type MusicalKey } from './harmonic';

/**
 * Set builder: turns a library into a playable arc.
 *
 * The agent can pick a single good next track. This builds a whole night: an
 * energy curve, harmonic steps that do not clash, a tempo window narrow enough to
 * beatmatch, and a transition suggestion per handover.
 *
 * Greedy, not optimal — and deliberately so. A greedy walk over harmonic score
 * produces sets that sound intentional, while an optimiser produces sets that
 * look good on paper and jump genres at bar 300.
 */

export type TransitionKind = 'cut' | 'crossfade' | 'loop' | 'filter';

export interface PlannedTransition {
  kind: TransitionKind;
  bars: number;
  /** Signed tempo shift in percent, e.g. +3.1. */
  tempoShiftPercent: number;
  harmonicScore: number;
}

export interface SetPlanEntry {
  trackId: string;
  title: string;
  artist: string;
  bpm: number;
  camelot: string;
  energy: number;
  /** Start offset from the beginning of the set, in seconds. */
  atSeconds: number;
  durationSeconds: number;
  /** Transition into the *next* track, null on the last entry. */
  transitionOut: PlannedTransition | null;
}

export interface SetPlan {
  entries: SetPlanEntry[];
  totalSeconds: number;
  /** Sampled arc the plan was built against, 0..1 per slot. */
  arc: number[];
  /** Mean harmonic score of all handovers, 0..1. */
  harmonicScore: number;
  warnings: string[];
}

export interface BuildSetOptions {
  /** Target set length in minutes. */
  targetMinutes?: number;
  /** Energy to start at, 0..1. */
  startEnergy?: number;
  /** Where the peak sits in the set, 0..1 (0.7 = last third). */
  peakAt?: number;
  /** Allowed tempo deviation from the seed track, as a ratio (0.06 = ±6 %). */
  tempoWindow?: number;
  /** Minimum harmonic score for a handover to be allowed. */
  minHarmonicScore?: number;
  /** Assumed track length when the record has no duration. */
  defaultTrackSeconds?: number;
  /** Seed track id; defaults to the calmest track in the tempo window. */
  seedTrackId?: string;
  /** Hard cap so a bug cannot produce a 400-entry plan. */
  maxTracks?: number;
}

const DEFAULTS = {
  targetMinutes: 60,
  startEnergy: 0.25,
  peakAt: 0.7,
  tempoWindow: 0.06,
  minHarmonicScore: 0.6,
  defaultTrackSeconds: 210,
  maxTracks: 40,
};

/** Energy arc shape: rise to the peak, then a controlled descent. */
export function arcTarget(position: number, startEnergy: number, peakAt: number, peakEnergy = 1): number {
  const clamped = Math.max(0, Math.min(1, position));
  const peak = Math.max(0.05, Math.min(0.95, peakAt));
  if (clamped <= peak) {
    const t = peak === 0 ? 1 : clamped / peak;
    // smoothstep: no dead flat intro, no sudden jump at the peak
    const eased = t * t * (3 - 2 * t);
    return startEnergy + (peakEnergy - startEnergy) * eased;
  }
  const t = (clamped - peak) / (1 - peak);
  const eased = t * t * (3 - 2 * t);
  // End a little above the start: a set should not end in silence.
  return peakEnergy - (peakEnergy - (startEnergy + 0.1)) * eased;
}

function durationOf(track: Track, fallback: number): number {
  const candidate = (track as Track & { durationSeconds?: number }).durationSeconds;
  return typeof candidate === 'number' && candidate > 0 ? candidate : fallback;
}

function keyOf(track: Track): MusicalKey {
  return track.key;
}

/** Picks the transition that fits the size of the jump. */
export function chooseTransition(previous: Track, next: Track): PlannedTransition {
  const harmonicScore = harmonicCompatibility(keyOf(previous), keyOf(next));
  const tempoScore = tempoMatchScore(previous.bpm, next.bpm);
  const energyJump = Math.abs(next.energy - previous.energy);

  // Order matters: a big energy jump wants a filter, a weak harmonic match wants
  // a loop to swap under, and only then does a clean blend or a cut make sense.
  let kind: TransitionKind = 'crossfade';
  if (energyJump > 0.35) kind = 'filter';
  else if (harmonicScore < 0.75) kind = 'loop';
  else if (tempoScore > 0.98 && harmonicScore >= 0.9) kind = 'cut';
  else if (energyJump < 0.1 && tempoScore > 0.9) kind = 'crossfade';

  const bars = kind === 'cut' ? 0 : energyJump > 0.35 ? 8 : 16;
  return {
    kind,
    bars,
    tempoShiftPercent: Math.round(requiredTempoShift(previous.bpm, next.bpm) * 1000) / 10,
    harmonicScore,
  };
}

export function buildSet(tracks: readonly Track[], options: BuildSetOptions = {}): SetPlan {
  const settings = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  if (tracks.length === 0) {
    return { entries: [], totalSeconds: 0, arc: [], harmonicScore: 0, warnings: ['library is empty'] };
  }

  const seed = settings.seedTrackId ? tracks.find((track) => track.id === settings.seedTrackId) : undefined;
  const tempoAnchor = seed?.bpm ?? medianBpm(tracks);
  const lo = tempoAnchor * (1 - settings.tempoWindow);
  const hi = tempoAnchor * (1 + settings.tempoWindow);
  const pool = tracks.filter((track) => track.bpm >= lo && track.bpm <= hi);
  if (pool.length === 0) {
    return { entries: [], totalSeconds: 0, arc: [], harmonicScore: 0, warnings: ['no tracks inside the tempo window'] };
  }
  if (pool.length < tracks.length) {
    warnings.push(`${tracks.length - pool.length} tracks outside the tempo window were excluded`);
  }

  const targetSeconds = settings.targetMinutes * 60;
  // How many slots we need decides the arc resolution.
  const estimatedSlot = settings.defaultTrackSeconds;
  const slotCount = Math.max(1, Math.min(settings.maxTracks, Math.round(targetSeconds / estimatedSlot)));
  const arc = Array.from({ length: slotCount }, (_, index) =>
    Math.round(arcTarget(slotCount === 1 ? peakFor(slotCount, index, settings.peakAt) : index / (slotCount - 1), settings.startEnergy, settings.peakAt) * 1000) /
    1000,
  );

  const remaining = [...pool];
  const chosen: Track[] = [];
  const unusedWarnings: string[] = [];

  // Start from the track closest to the arc's opening energy.
  const firstIndex = pickClosest(remaining, arc[0] ?? settings.startEnergy);
  chosen.push(remaining.splice(firstIndex, 1)[0]!);

  while (chosen.length < slotCount && remaining.length > 0) {
    const slot = chosen.length;
    const targetEnergy = arc[slot] ?? arc[arc.length - 1] ?? settings.startEnergy;
    const previous = chosen[chosen.length - 1]!;

    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const harmonic = harmonicCompatibility(keyOf(previous), keyOf(candidate));
      const tempo = tempoMatchScore(previous.bpm, candidate.bpm);
      const energyFit = 1 - Math.abs(candidate.energy - targetEnergy);
      const score = harmonic * 0.45 + tempo * 0.25 + energyFit * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;
    const picked = remaining[bestIndex]!;
    const harmonic = harmonicCompatibility(keyOf(previous), keyOf(picked));
    if (harmonic < settings.minHarmonicScore) {
      unusedWarnings.push(`${picked.title}: harmonic score ${harmonic.toFixed(2)} below threshold`);
    }
    chosen.push(...remaining.splice(bestIndex, 1));
  }

  // Lay the chosen tracks on the time line.
  const entries: SetPlanEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < chosen.length; index += 1) {
    const track = chosen[index]!;
    const duration = durationOf(track, settings.defaultTrackSeconds);
    entries.push({
      trackId: track.id,
      title: track.title,
      artist: track.artist ?? '',
      bpm: track.bpm,
      camelot: track.key.camelot,
      energy: track.energy,
      atSeconds: Math.round(cursor * 100) / 100,
      durationSeconds: duration,
      transitionOut: null,
    });
    cursor += duration;
  }

  for (let index = 0; index < entries.length - 1; index += 1) {
    entries[index]!.transitionOut = chooseTransition(chosen[index]!, chosen[index + 1]!);
  }

  const transitions = entries
    .map((entry) => entry.transitionOut)
    .filter((transition): transition is PlannedTransition => transition !== null);
  const harmonicScore = transitions.length
    ? Math.round((transitions.reduce((sum, transition) => sum + transition.harmonicScore, 0) / transitions.length) * 1000) / 1000
    : 0;

  const totalSeconds = Math.round(cursor * 100) / 100;
  if (totalSeconds < targetSeconds * 0.85) {
    warnings.push(`plan is shorter than requested: ${Math.round(totalSeconds / 60)} of ${settings.targetMinutes} min`);
  }
  if (transitions.some((transition) => transition.harmonicScore < settings.minHarmonicScore)) {
    warnings.push('at least one handover is harmonically weak');
  }
  warnings.push(...unusedWarnings);

  return { entries, totalSeconds, arc, harmonicScore, warnings };
}

function peakFor(_count: number, index: number, peakAt: number): number {
  return index === 0 ? 0 : peakAt;
}

function pickClosest(tracks: readonly Track[], energy: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < tracks.length; index += 1) {
    const distance = Math.abs((tracks[index]?.energy ?? 0) - energy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function medianBpm(tracks: readonly Track[]): number {
  const sorted = tracks.map((track) => track.bpm).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 124;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 124) + (sorted[middle] ?? 124)) / 2
    : sorted[middle] ?? 124;
}

// ── runner ──────────────────────────────────────────────────────────────────

export interface SetRunnerHooks {
  /** Called when a track should be loaded and started. */
  onTrack: (entry: SetPlanEntry, index: number) => void;
  /** Called `bars` before a handover so the mix can be prepared. */
  onTransition?: (transition: PlannedTransition, from: SetPlanEntry, to: SetPlanEntry) => void;
  onFinish?: () => void;
}

export interface SetRunnerOptions {
  /** Real time per bar; the tests shrink this. */
  msPerBar?: (bpm: number) => number;
  /** Chop track durations down for a fast dry run. */
  speedFactor?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Plays a plan through the hooks. One timer per upcoming action, no polling:
 * a set can run for two hours without a single wasted wakeup.
 */
export class SetRunner {
  private plan: SetPlan | null = null;
  private hooks: SetRunnerHooks | null = null;
  private timers: unknown[] = [];
  private index = 0;
  private options: Required<Pick<SetRunnerOptions, 'speedFactor'>> & SetRunnerOptions;

  constructor(options: SetRunnerOptions = {}) {
    this.options = { speedFactor: options.speedFactor ?? 1, ...options };
  }

  start(plan: SetPlan, hooks: SetRunnerHooks): void {
    this.stop();
    this.plan = plan;
    this.hooks = hooks;
    this.index = 0;
    if (plan.entries.length === 0) {
      hooks.onFinish?.();
      this.stop();
      return;
    }
    this.fire(0);
  }

  /** Skips to the next track immediately. */
  skip(): void {
    if (!this.plan) return;
    const next = this.index + 1;
    this.clearTimers();
    if (next >= this.plan.entries.length) {
      this.hooks?.onFinish?.();
      this.stop();
      return;
    }
    this.fire(next);
  }

  stop(): void {
    this.clearTimers();
    this.plan = null;
    this.hooks = null;
    this.index = 0;
  }

  get current(): SetPlanEntry | null {
    return this.plan?.entries[this.index] ?? null;
  }

  get isRunning(): boolean {
    return this.plan !== null;
  }

  private fire(index: number): void {
    const plan = this.plan;
    const hooks = this.hooks;
    if (!plan || !hooks) return;
    const entry = plan.entries[index];
    if (!entry) {
      hooks.onFinish?.();
      this.stop();
      return;
    }
    this.index = index;
    hooks.onTrack(entry, index);

    const nextEntry = plan.entries[index + 1];
    if (!nextEntry || !entry.transitionOut) {
      this.schedule(() => {
        hooks.onFinish?.();
        this.stop();
      }, this.msFor(entry));
      return;
    }

    const barMs = this.msForBar(entry.bpm);
    const transitionLeadMs = entry.transitionOut.bars * barMs;
    const trackMs = this.msFor(entry);
    const leadAt = Math.max(0, trackMs - transitionLeadMs);
    this.schedule(() => {
      hooks.onTransition?.(entry.transitionOut!, entry, nextEntry);
    }, leadAt);
    this.schedule(() => this.fire(index + 1), trackMs);
  }

  private schedule(handler: () => void, ms: number): void {
    const setFn = this.options.setTimeoutFn ?? ((fn, delay) => setTimeout(fn, delay));
    const handle = setFn(handler, Math.max(0, ms));
    this.timers.push(handle);
  }

  private clearTimers(): void {
    const clearFn = this.options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    for (const timer of this.timers) clearFn(timer);
    this.timers = [];
  }

  private msFor(entry: SetPlanEntry): number {
    return (entry.durationSeconds * 1000) / this.options.speedFactor;
  }

  private msForBar(bpm: number): number {
    const base = this.options.msPerBar ? this.options.msPerBar(bpm) : (60 / Math.max(1, bpm)) * 4 * 1000;
    return base / this.options.speedFactor;
  }
}
