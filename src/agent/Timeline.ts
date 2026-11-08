/**
 * Lookahead timeline for musical scheduling.
 *
 * A 16 ms tick with a 120 ms lookahead window: a dropped JS frame costs nothing
 * because the next window already contains the events that were due. This is how
 * a filter sweep or a stem swap stays on the bar even when React is busy.
 */

interface Task {
  id: string;
  atMs: number;
  fn: (now: number) => void;
  tag?: string;
}

export interface TimelineOptions {
  tickMs?: number;
  lookaheadMs?: number;
  /** Inject the clock so tests and the mesh can drive it. */
  clock?: () => number;
}

export class LookaheadTimeline {
  private tasks = new Map<string, Task>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly lookaheadMs: number;
  private readonly clock: () => number;

  constructor(options: TimelineOptions = {}) {
    this.tickMs = options.tickMs ?? 16;
    this.lookaheadMs = options.lookaheadMs ?? 120;
    this.clock = options.clock ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tasks.clear();
  }

  schedule(id: string, atMs: number, fn: (now: number) => void, tag?: string): void {
    const task: Task = { id, atMs, fn, tag };
    this.tasks.set(id, task);
  }

  /** Convenience for ramps: `steps` evenly spaced calls over `durationMs`. */
  ramp(
    idPrefix: string,
    durationMs: number,
    steps: number,
    fn: (progress: number, now: number) => void,
    startAtMs = this.clock(),
    tag?: string,
  ): void {
    const count = Math.max(1, Math.trunc(steps));
    const stepMs = durationMs / count;
    for (let i = 1; i <= count; i += 1) {
      const progress = i / count;
      this.schedule(`${idPrefix}:${i}`, startAtMs + stepMs * i, (now) => fn(progress, now), tag);
    }
  }

  cancel(id: string): void {
    this.tasks.delete(id);
  }

  cancelTag(tag: string): void {
    for (const [id, task] of this.tasks) {
      if (task.tag === tag) this.tasks.delete(id);
    }
  }

  get pending(): number {
    return this.tasks.size;
  }

  private tick(): void {
    const now = this.clock();
    const horizon = now + this.lookaheadMs;
    const due: Task[] = [];
    for (const [id, task] of this.tasks) {
      if (task.atMs <= horizon) {
        due.push(task);
        this.tasks.delete(id);
      }
    }
    due.sort((a, b) => a.atMs - b.atMs);
    for (const task of due) {
      try {
        task.fn(now);
      } catch {
        // A failing scheduled step must not kill the set. Swallow and continue.
      }
    }
  }
}
