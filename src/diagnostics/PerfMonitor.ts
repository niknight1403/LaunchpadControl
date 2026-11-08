/**
 * Performance monitor: turns core telemetry into a verdict.
 *
 * A DAW that drops buffers is not "a bit glitchy", it is broken. This module
 * exists so the app can say that out loud — in the UI, in the log and in CI-style
 * reports — instead of blaming the phone.
 *
 * Budgets are configurable because they differ per device: a 2019 midrange phone
 * at 48 kHz / 128 frames has ~2.6 ms per callback.
 */

export interface CoreStats {
  /** Share of the callback budget used, 0..1+ */
  cpuLoad: number;
  /** Buffer underruns since start. */
  xruns: number;
  /** Output latency reported by the driver, ms. */
  latencyMs: number;
  /** Sample rate and buffer size, for the report. */
  sampleRate: number;
  framesPerBuffer: number;
  /** Frames rendered since start, for a "is it actually running" check. */
  framesRendered: number;
}

export interface Budget {
  /** Maximum sustainable callback load before the verdict fails. */
  cpuLoad: number;
  /** Lowest acceptable latency in ms (higher is worse). */
  maxLatencyMs: number;
  /** Xruns tolerated per minute of runtime. */
  xrunsPerMinute: number;
  /** Lowest acceptable buffered audio in ms; below this, dropouts are likely. */
  minBufferMs: number;
}

export type Verdict = 'ok' | 'warn' | 'fail';

export interface Finding {
  metric: 'cpuLoad' | 'latencyMs' | 'xruns' | 'buffer' | 'stopped';
  verdict: Verdict;
  message: string;
  value: number;
  budget: number;
}

export interface PerfReport {
  verdict: Verdict;
  findings: Finding[];
  stats: CoreStats;
  runtimeSeconds: number;
  checkedAt: number;
}

export interface PerfMonitorOptions {
  budget?: Partial<Budget>;
  now?: () => number;
}

export const DEFAULT_BUDGET: Budget = {
  cpuLoad: 0.7,
  maxLatencyMs: 45,
  xrunsPerMinute: 0.5,
  minBufferMs: 2.6,
};

export class PerfMonitor {
  private budget: Budget;
  private now: () => number;
  private startedAt: number;
  private samples: CoreStats[] = [];
  private listeners = new Set<(report: PerfReport) => void>();
  private everyNth: number;
  private counter = 0;

  constructor(options: PerfMonitorOptions = {}) {
    this.budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.everyNth = 1;
  }

  /** Feeds a telemetry sample. Thin wrapper: listeners fire at most every n samples. */
  sample(stats: CoreStats, everyNth = 1): PerfReport {
    this.samples.push(stats);
    // Keep the last 600 samples: enough for a rolling view, bounded for memory.
    if (this.samples.length > 600) this.samples.shift();
    this.everyNth = Math.max(1, everyNth);
    const report = this.evaluate(stats);
    this.counter += 1;
    if (this.counter % this.everyNth === 0) {
      for (const listener of this.listeners) listener(report);
    }
    return report;
  }

  onReport(listener: (report: PerfReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pure verdict for one sample. */
  evaluate(stats: CoreStats): PerfReport {
    const findings: Finding[] = [];
    const runtimeSeconds = Math.max(0.001, (this.now() - this.startedAt) / 1000);
    const bufferMs = stats.sampleRate > 0 ? (stats.framesPerBuffer / stats.sampleRate) * 1000 : 0;

    if (stats.cpuLoad > this.budget.cpuLoad) {
      findings.push({
        metric: 'cpuLoad',
        verdict: stats.cpuLoad > this.budget.cpuLoad * 1.25 ? 'fail' : 'warn',
        message: `callback load ${(stats.cpuLoad * 100).toFixed(1)} % above the ${(this.budget.cpuLoad * 100).toFixed(0)} % budget`,
        value: round(stats.cpuLoad),
        budget: this.budget.cpuLoad,
      });
    }

    if (stats.latencyMs > this.budget.maxLatencyMs) {
      findings.push({
        metric: 'latencyMs',
        verdict: stats.latencyMs > this.budget.maxLatencyMs * 1.6 ? 'fail' : 'warn',
        message: `output latency ${stats.latencyMs.toFixed(1)} ms above the ${this.budget.maxLatencyMs} ms budget`,
        value: round(stats.latencyMs),
        budget: this.budget.maxLatencyMs,
      });
    }

    const xrunsPerMinute = stats.xruns / (runtimeSeconds / 60);
    if (xrunsPerMinute > this.budget.xrunsPerMinute) {
      findings.push({
        metric: 'xruns',
        verdict: stats.xruns > 10 ? 'fail' : 'warn',
        message: `${stats.xruns} xruns in ${runtimeSeconds.toFixed(0)} s`,
        value: round(xrunsPerMinute),
        budget: this.budget.xrunsPerMinute,
      });
    }

    if (bufferMs > 0 && bufferMs < this.budget.minBufferMs) {
      findings.push({
        metric: 'buffer',
        verdict: 'warn',
        message: `buffer holds only ${bufferMs.toFixed(1)} ms of audio`,
        value: round(bufferMs),
        budget: this.budget.minBufferMs,
      });
    }

    // A stopped engine looks perfect: zero load, zero xruns. Say so.
    if (stats.framesRendered === 0 && runtimeSeconds > 1) {
      findings.push({
        metric: 'stopped',
        verdict: 'fail',
        message: 'no frames rendered — the audio engine is not running',
        value: 0,
        budget: 1,
      });
    }

    const verdict: Verdict = findings.some((finding) => finding.verdict === 'fail')
      ? 'fail'
      : findings.some((finding) => finding.verdict === 'warn')
        ? 'warn'
        : 'ok';

    return {
      verdict,
      findings,
      stats,
      runtimeSeconds: Math.round(runtimeSeconds * 10) / 10,
      checkedAt: this.now(),
    };
  }

  /** Mean of the recent samples, for a UI badge. */
  rollingAverage(window = 30): { cpuLoad: number; xruns: number; latencyMs: number } {
    const slice = this.samples.slice(-window);
    if (slice.length === 0) return { cpuLoad: 0, xruns: 0, latencyMs: 0 };
    const sum = slice.reduce(
      (accumulator, entry) => ({
        cpuLoad: accumulator.cpuLoad + entry.cpuLoad,
        xruns: accumulator.xruns + entry.xruns,
        latencyMs: accumulator.latencyMs + entry.latencyMs,
      }),
      { cpuLoad: 0, xruns: 0, latencyMs: 0 },
    );
    return {
      cpuLoad: round(sum.cpuLoad / slice.length),
      xruns: Math.round(sum.xruns / slice.length),
      latencyMs: round(sum.latencyMs / slice.length),
    };
  }

  /** Human-readable report; this is what Support gets asked to send. */
  format(report: PerfReport): string {
    const lines = [
      `AuraGrid diagnostics — ${report.verdict.toUpperCase()}`,
      `runtime ${report.runtimeSeconds} s · ${report.stats.sampleRate} Hz · ${report.stats.framesPerBuffer} frames`,
      `cpu ${(report.stats.cpuLoad * 100).toFixed(1)} % · latency ${report.stats.latencyMs.toFixed(1)} ms · xruns ${report.stats.xruns}`,
    ];
    for (const finding of report.findings) lines.push(`[${finding.verdict}] ${finding.message}`);
    return lines.join('\n');
  }

  reset(): void {
    this.samples = [];
    this.startedAt = this.now();
    this.counter = 0;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
