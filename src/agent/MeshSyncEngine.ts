import type { MeshClockSync } from './MeshClockSync';
import type { MeshSwarm } from './MeshSwarm';
import { harmonicCompatibility, parseCamelot, keyFromCamelot, requiredTempoShift, type MusicalKey } from './harmonic';

/**
 * MeshSyncEngine: one object that answers "what must this deck change to be in
 * sync with the swarm?".
 *
 * The pieces exist separately — `MeshClockSync` measures peer clocks, `MeshSwarm`
 * schedules bar-aligned launches, `harmonic` scores key moves. What a performance
 * screen needs is a single, testable answer that combines them, because the three
 * questions are not independent: a tempo nudge changes the phase, and a phase
 * correction that ignores the nudge lands late.
 *
 * Rules that keep this from making things worse during a set:
 *   * a peer whose clock is not solid never becomes the phase reference;
 *   * a tempo nudge is capped, because half a percent is a blend and five percent
 *     is a different track;
 *   * nudges are reported, not applied here: the deck owns its transport, so it can
 *     decide to catch up over one bar instead of jumping.
 */

export interface SyncDeckState {
  /** Deck tempo in BPM. */
  bpm: number;
  /** Playhead in ms, deck-local. */
  positionMs: number;
  /** Camelot code like "8A", if known. */
  camelot?: string;
  isPlaying: boolean;
}

export interface SyncPlan {
  /** Percent tempo change needed to match the master (may be clamped). */
  tempoShiftPercent: number;
  /** True when the shift was clamped, so the UI can say "too far apart". */
  tempoShiftClamped: boolean;
  /** Milliseconds to slip the playhead to land on the master's beat. */
  phaseNudgeMs: number;
  /** Master-clock time of the next bar line, for a scheduled launch. */
  nextBarAtMasterMs: number;
  /** Local-clock equivalent of `nextBarAtMasterMs`. */
  nextBarAtLocalMs: number;
  /** 0..1 harmonic compatibility with the master's key, 1 when unknown. */
  keyScore: number;
  /** Human sentence for the sync button's label. */
  summary: string;
  /** Non-fatal reasons this plan should not be trusted blindly. */
  warnings: string[];
}

export interface MeshSyncEngineOptions {
  /** Largest tempo correction the engine will suggest, in percent. */
  maxTempoShiftPercent?: number;
  /** Clock quality above this makes the master untrustworthy for phase. */
  maxTrustedQualityMs?: number;
  /** Bars to look ahead when scheduling a launch. Default 1. */
  launchBarsAhead?: number;
  /** Master tempo, if the swarm preset has one. */
  masterBpm?: number;
  /** Master key (Camelot), if known. */
  masterCamelot?: string;
  /** Master's first-beat offset in ms on the master clock. */
  masterFirstBeatMs?: number;
}

const DEFAULT_OPTIONS: Required<Omit<MeshSyncEngineOptions, 'masterBpm' | 'masterCamelot' | 'masterFirstBeatMs'>> = {
  maxTempoShiftPercent: 6,
  maxTrustedQualityMs: 12,
  launchBarsAhead: 1,
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Phase of the master's beat grid at a given master-clock time, 0..1.
 *
 * 0 is the beat itself, 0.5 the off-beat. Exposed because the UI draws it and the
 * tests pin it.
 */
export function beatPhaseAt(masterMs: number, bpm: number, firstBeatMs = 0): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  const beatMs = 60_000 / bpm;
  const elapsed = masterMs - firstBeatMs;
  const phase = ((elapsed % beatMs) + beatMs) % beatMs;
  return phase / beatMs;
}

/** Milliseconds from `masterMs` to the next beat (or bar line). */
export function msToNextBeat(masterMs: number, bpm: number, firstBeatMs = 0, beatsPerBar = 4): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  const beatMs = 60_000 / bpm;
  const barMs = beatMs * beatsPerBar;
  const from = masterMs - firstBeatMs;
  const remainder = ((from % barMs) + barMs) % barMs;
  return remainder === 0 ? 0 : barMs - remainder;
}

export class MeshSyncEngine {
  private clock: MeshClockSync;
  private swarm: MeshSwarm | null;
  private options: MeshSyncEngineOptions;
  private frozen = false;

  constructor(clock: MeshClockSync, options: MeshSyncEngineOptions = {}, swarm: MeshSwarm | null = null) {
    this.clock = clock;
    this.options = options;
    this.swarm = swarm;
  }

  /** Master tempo, typically pushed in from the swarm preset. */
  setMasterReference(reference: { bpm?: number; camelot?: string; firstBeatMs?: number }): void {
    this.options = { ...this.options, masterBpm: reference.bpm ?? this.options.masterBpm, masterCamelot: reference.camelot ?? this.options.masterCamelot, masterFirstBeatMs: reference.firstBeatMs ?? this.options.masterFirstBeatMs };
  }

  /** Stops emitting corrections, e.g. while the DJ is beatmatching by hand. */
  freeze(): void {
    this.frozen = true;
  }

  resume(): void {
    this.frozen = false;
  }

  status(): { isMaster: boolean; masterId: string; qualityMs: number; trusted: boolean; frozen: boolean } {
    const masterId = this.clock.masterId();
    const quality = this.clock.qualityMs(masterId);
    return {
      isMaster: this.clock.isMaster(),
      masterId,
      qualityMs: quality,
      trusted: quality <= (this.options.maxTrustedQualityMs ?? DEFAULT_OPTIONS.maxTrustedQualityMs),
      frozen: this.frozen,
    };
  }

  /** Mesh-aligned clock, or the local clock when this node is the master. */
  now(): number {
    return this.clock.syncedNow();
  }

  /**
   * Builds the plan for one deck.
   *
   * Always returns a plan: "do nothing" is a plan with zero shift and zero nudge,
   * which keeps the UI from having to null-check a sync button.
   */
  planFor(deck: SyncDeckState): SyncPlan {
    const state = this.status();
    const warnings: string[] = [];
    const masterBpm = this.options.masterBpm ?? deck.bpm;
    const maxShift = this.options.maxTempoShiftPercent ?? DEFAULT_OPTIONS.maxTempoShiftPercent;

    if (!Number.isFinite(deck.bpm) || deck.bpm <= 0) {
      warnings.push('deck tempo unknown');
    }

    const rawShift = deck.bpm > 0 && masterBpm > 0 ? requiredTempoShift(deck.bpm, masterBpm) * 100 : 0;
    const clamped = Math.abs(rawShift) > maxShift;
    const tempoShiftPercent = round2(clamped ? Math.sign(rawShift) * maxShift : rawShift);
    if (clamped) warnings.push(`tracks are ${Math.abs(round2(rawShift))} % apart, correction capped at ${maxShift} %`);

    // Phase is only meaningful against a clock you can trust. A peer with a bad
    // round trip would otherwise produce a nudge that fights the DJ.
    const trusted = state.trusted && !state.isMaster;
    if (!trusted && !state.isMaster) warnings.push(`clock to ${state.masterId} is ${state.qualityMs} ms, no phase nudge`);
    if (this.frozen) warnings.push('sync is frozen');
    if (!deck.isPlaying) warnings.push('deck is stopped, phase not applied');

    const masterNow = state.isMaster ? this.clock.syncedNow() : this.clock.syncedNow();
    const firstBeat = this.options.masterFirstBeatMs ?? 0;
    const beatsPerBar = 4;
    const toNextBar = msToNextBeat(masterNow, masterBpm, firstBeat, beatsPerBar);
    const launchBars = this.options.launchBarsAhead ?? DEFAULT_OPTIONS.launchBarsAhead;
    const nextBarAtMasterMs = masterNow + toNextBar + (launchBars - 1) * (60_000 / Math.max(1, masterBpm)) * beatsPerBar;

    const phase = beatPhaseAt(masterNow, masterBpm, firstBeat);
    const beatMs = 60_000 / Math.max(1, masterBpm);
    // Correcting backwards is nicer than jumping forwards: a short slip sounds like
    // a nudge, a jump cuts the audio.
    const phaseNudgeMs = round2((phase > 0 ? phase : 0) * beatMs);
    const applicable = trusted && !this.frozen && deck.isPlaying;

    const keyScore = this.keyScore(deck.camelot);
    const summary = applicable
      ? `sync: ${tempoShiftPercent >= 0 ? '+' : ''}${tempoShiftPercent} % · ${Math.round(phaseNudgeMs)} ms`
      : state.isMaster
        ? 'master of the swarm'
        : 'sync unavailable';

    return {
      tempoShiftPercent,
      tempoShiftClamped: clamped,
      phaseNudgeMs: applicable ? phaseNudgeMs : 0,
      nextBarAtMasterMs: Math.round(nextBarAtMasterMs),
      nextBarAtLocalMs: Math.round(this.toLocal(nextBarAtMasterMs)),
      keyScore,
      summary,
      warnings,
    };
  }

  /** 0..1 key compatibility with the master; 1 when either key is unknown. */
  keyScore(deckCamelot?: string): number {
    const masterCamelot = this.options.masterCamelot;
    if (!masterCamelot || !deckCamelot) return 1;
    const from = keyFromCamelot(deckCamelot);
    const to = keyFromCamelot(masterCamelot);
    if (!from || !to) return 1;
    return Math.round(harmonicCompatibility(from, to) * 1000) / 1000;
  }

  /** Converts a master-clock timestamp into local time. */
  toLocal(masterMs: number): number {
    const offset = this.clock.syncedNow() - Date.now();
    return masterMs - offset;
  }

  /** Terrible helper for tests and the debug overlay. */
  describe(): string {
    const state = this.status();
    return state.isMaster
      ? `master (${state.masterId})`
      : `${state.masterId} · ${state.qualityMs} ms · ${state.trusted ? 'trusted' : 'untrusted'}`;
  }
}

/** Parses a Camelot code without throwing; used by the UI before calling the engine. */
export function safeCamelot(code: string | undefined): { number: number; letter: 'A' | 'B' } | null {
  return code ? parseCamelot(code) : null;
}

/** Re-exported so the UI can label a key without importing the harmonic module. */
export type { MusicalKey };
