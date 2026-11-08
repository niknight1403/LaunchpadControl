import type { DeckId } from './types';

/**
 * Deck controller: all the musical arithmetic a deck needs, in beats.
 *
 * The core knows frames and samples. It must not know what a beat is. This class
 * converts musical intent (a 4-beat loop from bar 2, sync to 128 BPM) into frames
 * and rates, and keeps the local view of what the deck is currently doing.
 */
export interface DeckControlTarget {
  readonly sampleRate: number;
  readonly currentBpm: number;
  setLoop(deck: DeckId, startFrame: number, endFrame: number): void;
  clearLoop(deck: DeckId): void;
  setDeckRate(deck: DeckId, rate: number): void;
  seek(deck: DeckId, frame: number): void;
}

export interface LoopSpec {
  startBeat: number;
  lengthBeats: number;
}

export interface DeckControllerState {
  clipBpm: number;
  cueBeat: number;
  cueFrame: number;
  loop: LoopSpec | null;
  loopFrames: { startFrame: number; endFrame: number } | null;
  rate: number;
  /** True when the deck rate differs from unity by more than 0.1 %. */
  beatmatched: boolean;
}

export interface DeckControllerOptions {
  clipBpm?: number;
  /** Loop lengths the double/halve buttons are allowed to reach. */
  minLoopBeats?: number;
  maxLoopBeats?: number;
}

export class DeckController {
  private target: DeckControlTarget;
  private deck: DeckId;
  private clipBpm: number;
  private cueBeat = 0;
  private loop: LoopSpec | null = null;
  private rate = 1;
  private minLoopBeats: number;
  private maxLoopBeats: number;

  constructor(target: DeckControlTarget, deck: DeckId, options: DeckControllerOptions = {}) {
    this.target = target;
    this.deck = deck;
    this.clipBpm = options.clipBpm && options.clipBpm > 0 ? options.clipBpm : 120;
    this.minLoopBeats = options.minLoopBeats ?? 0.25;
    this.maxLoopBeats = options.maxLoopBeats ?? 32;
  }

  // ── beat maths ───────────────────────────────────────────────────────────

  /** Source frames for a musical duration in beats at the deck's own tempo. */
  beatFrames(beats: number): number {
    if (this.clipBpm <= 0) return 0;
    return Math.round((60 / this.clipBpm) * beats * this.target.sampleRate);
  }

  framesToBeats(frames: number): number {
    return (frames / this.target.sampleRate) * (this.clipBpm / 60);
  }

  setClipBpm(bpm: number): void {
    if (bpm > 0) this.clipBpm = bpm;
  }

  get state(): DeckControllerState {
    const loopFrames = this.loop
      ? {
          startFrame: this.beatFrames(this.loop.startBeat),
          endFrame: this.beatFrames(this.loop.startBeat + this.loop.lengthBeats),
        }
      : null;
    return {
      clipBpm: this.clipBpm,
      cueBeat: this.cueBeat,
      cueFrame: this.beatFrames(this.cueBeat),
      loop: this.loop ? { ...this.loop } : null,
      loopFrames,
      rate: this.rate,
      beatmatched: Math.abs(this.rate - 1) > 0.001,
    };
  }

  // ── cue ──────────────────────────────────────────────────────────────────

  setCuePoint(beat: number): number {
    this.cueBeat = Math.max(0, beat);
    return this.beatFrames(this.cueBeat);
  }

  /** Jumps to the cue. Uses the core's seek, so it is sample accurate. */
  jumpToCue(): number {
    const frame = this.beatFrames(this.cueBeat);
    this.target.seek(this.deck, frame);
    return frame;
  }

  /** Jumps to an arbitrary beat, e.g. a drop marker. */
  jumpToBeat(beat: number): number {
    const frame = this.beatFrames(Math.max(0, beat));
    this.target.seek(this.deck, frame);
    return frame;
  }

  // ── loops ────────────────────────────────────────────────────────────────

  setLoop(startBeat: number, lengthBeats: number): LoopSpec {
    const length = Math.max(this.minLoopBeats, Math.min(this.maxLoopBeats, lengthBeats));
    const spec: LoopSpec = { startBeat: Math.max(0, startBeat), lengthBeats: length };
    this.applyLoop(spec);
    return spec;
  }

  /** Half-bar loop from the start: the workhorse transition move. */
  setLoopBars(startBar: number, bars = 1, beatsPerBar = 4): LoopSpec {
    return this.setLoop(startBar * beatsPerBar, bars * beatsPerBar);
  }

  halveLoop(): LoopSpec | null {
    if (!this.loop) return null;
    return this.setLoop(this.loop.startBeat, this.loop.lengthBeats / 2);
  }

  doubleLoop(): LoopSpec | null {
    if (!this.loop) return null;
    return this.setLoop(this.loop.startBeat, this.loop.lengthBeats * 2);
  }

  clearLoop(): void {
    this.loop = null;
    this.target.clearLoop(this.deck);
  }

  get loopActive(): boolean {
    return this.loop !== null;
  }

  private applyLoop(spec: LoopSpec): void {
    this.loop = spec;
    const startFrame = this.beatFrames(spec.startBeat);
    const endFrame = this.beatFrames(spec.startBeat + spec.lengthBeats);
    this.target.setLoop(this.deck, startFrame, endFrame);
  }

  // ── beatmatching ─────────────────────────────────────────────────────────

  /**
   * Syncs the deck to a master tempo. Returns the rate actually applied.
   * Half/double time is chosen if it lands closer: 87 against 174 is a match.
   */
  syncTo(masterBpm: number): number {
    if (masterBpm <= 0 || this.clipBpm <= 0) return this.rate;
    const candidates = [masterBpm / this.clipBpm, masterBpm / (this.clipBpm * 2), (masterBpm * 2) / this.clipBpm];
    let best = candidates[0] ?? 1;
    for (const candidate of candidates) {
      if (Math.abs(candidate - 1) < Math.abs(best - 1)) best = candidate;
    }
    const clamped = Math.max(0.5, Math.min(2, best));
    this.rate = Math.round(clamped * 10000) / 10000;
    this.target.setDeckRate(this.deck, this.rate);
    return this.rate;
  }

  /** Temporary rate offset while a finger holds the jog wheel. */
  nudge(percent: number): number {
    const next = Math.max(0.5, Math.min(2, this.rate * (1 + percent)));
    this.rate = Math.round(next * 10000) / 10000;
    this.target.setDeckRate(this.deck, this.rate);
    return this.rate;
  }

  resetRate(): number {
    this.rate = 1;
    this.target.setDeckRate(this.deck, 1);
    return 1;
  }

  /** Effective tempo after the rate multiplier. */
  effectiveBpm(): number {
    return Math.round(this.clipBpm * this.rate * 100) / 100;
  }

  reset(): void {
    this.cueBeat = 0;
    this.loop = null;
    this.rate = 1;
    this.target.clearLoop(this.deck);
    this.target.setDeckRate(this.deck, 1);
  }
}
