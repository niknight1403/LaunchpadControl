/**
 * Latency governor: picks a buffer size that survives the device it runs on.
 *
 * Buffer size is a trade: smaller means tighter response, bigger means fewer
 * dropouts. Neither is universally right, and the right answer changes with the
 * track, the phone's thermals and whatever else is running. So it is measured and
 * adjusted at runtime, with three protections against the classic failure modes of
 * adaptive systems:
 *
 *  - hysteresis: a decision needs several consecutive samples in the same
 *    direction, so one busy frame does not double the latency;
 *  - a cooldown, so it cannot climb and drop on alternating samples;
 *  - a ceiling, so a warm phone settles for a bigger buffer instead of glitching
 *    forever trying to be fast.
 */

export interface GovernorSample {
  cpuLoad: number;
  xruns: number;
  latencyMs: number;
}

export interface GovernorDecision {
  framesPerBuffer: number;
  changed: boolean;
  direction: 'down' | 'up' | 'hold';
  reason: string;
}

export interface LatencyGovernorOptions {
  /** Allowed buffer sizes, ascending. */
  ladder?: number[];
  /** Load above which the buffer must grow. */
  highLoad?: number;
  /** Load below which a smaller buffer is safe to try. */
  lowLoad?: number;
  /** Consecutive samples required before acting. */
  requiredSamples?: number;
  /** Samples to wait after a change before considering another. */
  cooldownSamples?: number;
  /** Start here if nothing else is known. */
  initialFrames?: number;
}

export const DEFAULT_LADDER = [64, 96, 128, 192, 256, 384, 512];

export class LatencyGovernor {
  private ladder: number[];
  private highLoad: number;
  private lowLoad: number;
  private requiredSamples: number;
  private cooldownSamples: number;
  private index: number;
  private hotStreak = 0;
  private coolStreak = 0;
  private sinceChange = 0;
  private changes = 0;
  private lastReason = 'starting point';

  constructor(options: LatencyGovernorOptions = {}) {
    this.ladder = [...(options.ladder ?? DEFAULT_LADDER)].sort((left, right) => left - right);
    this.highLoad = options.highLoad ?? 0.75;
    this.lowLoad = options.lowLoad ?? 0.35;
    this.requiredSamples = Math.max(1, options.requiredSamples ?? 3);
    this.cooldownSamples = Math.max(0, options.cooldownSamples ?? 8);
    const initial = options.initialFrames ?? 128;
    const index = this.ladder.indexOf(initial);
    this.index = index >= 0 ? index : this.nearestIndex(initial);
  }

  get framesPerBuffer(): number {
    return this.ladder[this.index]!;
  }

  get changeCount(): number {
    return this.changes;
  }

  get reason(): string {
    return this.lastReason;
  }

  /** Feeds one sample and returns the (possibly unchanged) decision. */
  observe(sample: GovernorSample): GovernorDecision {
    this.sinceChange += 1;

    // Xruns are not a load estimate, they are a fact: react immediately and climb
    // two steps, because one step never seems to be enough after a real dropout.
    if (sample.xruns > 0 && this.index < this.ladder.length - 1) {
      const target = Math.min(this.ladder.length - 1, this.index + 2);
      return this.moveTo(target, 'dropouts detected');
    }

    if (sample.cpuLoad >= this.highLoad) {
      this.hotStreak += 1;
      this.coolStreak = 0;
    } else if (sample.cpuLoad <= this.lowLoad) {
      this.coolStreak += 1;
      this.hotStreak = 0;
    } else {
      this.hotStreak = 0;
      this.coolStreak = 0;
    }

    if (this.canAct() && this.hotStreak >= this.requiredSamples) {
      if (this.index >= this.ladder.length - 1) {
        this.hotStreak = 0;
        this.lastReason = 'at the largest buffer; load must be reduced elsewhere';
        return { framesPerBuffer: this.framesPerBuffer, changed: false, direction: 'hold', reason: this.lastReason };
      }
      return this.moveTo(this.index + 1, `load ${(sample.cpuLoad * 100).toFixed(0)} % sustained`);
    }

    if (this.canAct() && this.coolStreak >= this.requiredSamples * 2) {
      // Downgrading needs more evidence than upgrading: a wrong "up" costs
      // responsiveness, a wrong "down" costs a dropout on stage.
      if (this.index === 0) {
        this.coolStreak = 0;
        this.lastReason = 'at the smallest buffer';
        return { framesPerBuffer: this.framesPerBuffer, changed: false, direction: 'hold', reason: this.lastReason };
      }
      return this.moveTo(this.index - 1, `load ${(sample.cpuLoad * 100).toFixed(0)} % with headroom`);
    }

    return { framesPerBuffer: this.framesPerBuffer, changed: false, direction: 'hold', reason: this.lastReason };
  }

  /** Forgets the history, e.g. after the user picks a buffer by hand. */
  reset(framesPerBuffer?: number): void {
    this.hotStreak = 0;
    this.coolStreak = 0;
    this.sinceChange = 0;
    if (framesPerBuffer !== undefined) {
      const index = this.ladder.indexOf(framesPerBuffer);
      this.index = index >= 0 ? index : this.nearestIndex(framesPerBuffer);
      this.lastReason = 'set by hand';
    }
  }

  /** Buffered audio in ms, which is what the player actually feels. */
  bufferMs(sampleRate: number): number {
    return sampleRate > 0 ? Math.round(((this.framesPerBuffer / sampleRate) * 1000 * 10)) / 10 : 0;
  }

  private canAct(): boolean {
    return this.sinceChange >= this.cooldownSamples;
  }

  private moveTo(index: number, reason: string): GovernorDecision {
    const previous = this.framesPerBuffer;
    const bounded = Math.max(0, Math.min(this.ladder.length - 1, index));
    this.index = bounded;
    this.hotStreak = 0;
    this.coolStreak = 0;
    this.sinceChange = 0;
    this.changes += 1;
    this.lastReason = reason;
    const current = this.framesPerBuffer;
    return {
      framesPerBuffer: current,
      changed: current !== previous,
      direction: current > previous ? 'up' : current < previous ? 'down' : 'hold',
      reason,
    };
  }

  private nearestIndex(frames: number): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.ladder.forEach((candidate, index) => {
      const distance = Math.abs(candidate - frames);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }
}

/** Convenience for tests and callers that only have a PerfReport. */
export function governorSampleFrom(cpuLoad: number, xruns = 0, latencyMs = 0): GovernorSample {
  return { cpuLoad, xruns, latencyMs };
}
