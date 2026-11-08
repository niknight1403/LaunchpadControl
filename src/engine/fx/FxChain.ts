import { LookaheadTimeline } from '../../agent/Timeline';
import { FxParam, type DeckId } from '../types';

/**
 * Per-deck FX chain with LFO automation.
 *
 * Two things this gets right that a naive `setInterval` does not:
 *
 *  1. Values are computed from the *scheduled* time, not from the moment the
 *     timer fired. A late tick therefore produces the right value, not a jump.
 *  2. Ticks are scheduled on the lookahead timeline, so a busy JS frame cannot
 *     leave a hole in the modulation.
 */

export interface FxTarget {
  setFx(deck: DeckId, param: FxParam, value: number): void;
}

export type LfoShape = 'sine' | 'triangle' | 'square';

export interface LfoConfig {
  /** Peak deviation from the base value, 0..1. */
  depth?: number;
  /** Period in beats: 4 = one bar at 4/4. */
  beats?: number;
  shape?: LfoShape;
  /** Starting phase 0..1. */
  phase?: number;
}

export interface MacroBinding {
  param: FxParam;
  /** Value at macro 0. */
  from: number;
  /** Value at macro 1. */
  to: number;
}

interface Node {
  base: number;
  lfo: Required<LfoConfig> | null;
}

export interface FxChainOptions {
  bpm?: number;
  /** Automation tick. 16 ms is one frame at 60 Hz. */
  tickMs?: number;
  timeline?: LookaheadTimeline;
  now?: () => number;
  deck?: DeckId;
}

const DEFAULT_LFO: Required<LfoConfig> = { depth: 0.35, beats: 8, shape: 'sine', phase: 0 };

export class FxChain {
  private target: FxTarget;
  private deck: DeckId;
  private nodes = new Map<FxParam, Node>();
  private timeline: LookaheadTimeline;
  private bpm: number;
  private tickMs: number;
  private now: () => number;
  private running = false;
  private originMs = 0;
  private scheduledTicks = 0;
  private lastTickMs = 0;
  /** True when we created the timeline ourselves and therefore must stop it. */
  private readonly ownsTimeline: boolean;

  constructor(target: FxTarget, deck: DeckId, options: FxChainOptions = {}) {
    this.target = target;
    this.deck = deck;
    this.bpm = options.bpm && options.bpm > 0 ? options.bpm : 124;
    this.tickMs = options.tickMs ?? 16;
    this.now = options.now ?? (() => Date.now());
    this.ownsTimeline = options.timeline === undefined;
    this.timeline = options.timeline ?? new LookaheadTimeline({ tickMs: 16, lookaheadMs: 120 });
  }

  // ── parameters ───────────────────────────────────────────────────────────

  setParam(param: FxParam, value: number): void {
    const clamped = clamp01(value);
    const node = this.node(param);
    node.base = clamped;
    // Without automation the value goes straight out; with automation the tick
    // writes it, so a manual move must not be overwritten immediately.
    if (!node.lfo) this.target.setFx(this.deck, param, clamped);
  }

  getParam(param: FxParam): number {
    return this.nodes.get(param)?.base ?? 0;
  }

  getDeck(): DeckId {
    return this.deck;
  }

  setDeck(deck: DeckId): void {
    this.deck = deck;
  }

  setBpm(bpm: number): void {
    if (bpm > 0) this.bpm = bpm;
  }

  // ── automation ───────────────────────────────────────────────────────────

  attachLfo(param: FxParam, config: LfoConfig = {}): void {
    const node = this.node(param);
    node.lfo = {
      depth: clamp01(config.depth ?? DEFAULT_LFO.depth),
      beats: Math.max(0.25, config.beats ?? DEFAULT_LFO.beats),
      shape: config.shape ?? DEFAULT_LFO.shape,
      phase: clamp01(config.phase ?? 0),
    };
  }

  detachLfo(param: FxParam): void {
    const node = this.nodes.get(param);
    if (!node) return;
    node.lfo = null;
    this.target.setFx(this.deck, param, node.base);
  }

  hasLfo(param: FxParam): boolean {
    return Boolean(this.nodes.get(param)?.lfo);
  }

  /** Writes all parameter values once, without starting automation. */
  flush(): void {
    for (const [param, node] of this.nodes) {
      this.target.setFx(this.deck, param, node.lfo ? this.evaluate(param, this.beatsNow()) : node.base);
    }
  }

  /**
   * Current value of a parameter at a musical position, in beats.
   * Pure: this is what the tests pin down.
   */
  evaluate(param: FxParam, beats: number): number {
    const node = this.nodes.get(param);
    if (!node) return 0;
    if (!node.lfo) return node.base;
    const { depth, beats: period, shape, phase } = node.lfo;
    const cycles = beats / period + phase;
    const unit = shapeValue(shape, cycles);
    // unit is 0..1; map to base ± depth.
    return clamp01(node.base + (unit * 2 - 1) * depth);
  }

  beatsNow(): number {
    const elapsedMs = this.now() - this.originMs;
    return (elapsedMs / 1000) * (this.bpm / 60);
  }

  // ── macros ───────────────────────────────────────────────────────────────

  /**
   * One control, several parameters: the XY pad's real job.
   * Values are interpolated and written immediately (no automation, no LFO).
   */
  setMacro(bindings: readonly MacroBinding[], value: number): void {
    const position = clamp01(value);
    for (const binding of bindings) {
      const mapped = binding.from + (binding.to - binding.from) * position;
      const node = this.node(binding.param);
      node.base = clamp01(mapped);
      if (!node.lfo) this.target.setFx(this.deck, binding.param, node.base);
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.originMs = this.now();
    this.lastTickMs = this.originMs;
    this.timeline.start();
    this.scheduleTick(this.originMs + this.tickMs);
  }

  stop(): void {
    this.running = false;
    this.timeline.cancelTag(`fx:${this.deck}`);
    // A leaked interval keeps the JS timer alive forever; own it and stop it.
    if (this.ownsTimeline) this.timeline.stop();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Number of automation writes performed — used by the perf monitor. */
  get tickCount(): number {
    return this.scheduledTicks;
  }

  snapshot(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const param of this.nodes.keys()) out[param] = this.evaluate(param, this.beatsNow());
    return out;
  }

  private scheduleTick(atMs: number): void {
    if (!this.running) return;
    this.timeline.schedule(
      `fx:${this.deck}:${atMs}`,
      atMs,
      () => {
        if (!this.running) return;
        this.lastTickMs = atMs;
        this.scheduledTicks += 1;
        // Evaluate at the intended time, not at the delayed execution time.
        const elapsedMs = atMs - this.originMs;
        const beats = (elapsedMs / 1000) * (this.bpm / 60);
        for (const [param, node] of this.nodes) {
          if (!node.lfo) continue;
          this.target.setFx(this.deck, param, this.evaluate(param, beats));
        }
        this.scheduleTick(atMs + this.tickMs);
      },
      `fx:${this.deck}`,
    );
  }

  private node(param: FxParam): Node {
    const existing = this.nodes.get(param);
    if (existing) return existing;
    const created: Node = { base: 0.5, lfo: null };
    this.nodes.set(param, created);
    return created;
  }
}

/** Shape function on the unit interval; `cycles` may be fractional. */
export function shapeValue(shape: LfoShape, cycles: number): number {
  const phase = cycles - Math.floor(cycles);
  switch (shape) {
    case 'triangle':
      return phase < 0.5 ? phase * 2 : 2 - phase * 2;
    case 'square':
      return phase < 0.5 ? 1 : 0;
    case 'sine':
    default:
      return 0.5 + 0.5 * Math.sin(phase * 2 * Math.PI);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
