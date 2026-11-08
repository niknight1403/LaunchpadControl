import { DEFAULT_BUDGET, PerfMonitor, type CoreStats } from '../../src/diagnostics/PerfMonitor';
import { check, near, section } from './harness';

function stats(overrides: Partial<CoreStats> = {}): CoreStats {
  return {
    cpuLoad: 0.3,
    xruns: 0,
    latencyMs: 12,
    sampleRate: 48000,
    framesPerBuffer: 128,
    framesRendered: 48000 * 30,
    ...overrides,
  };
}

export async function run(): Promise<void> {
  section('Perf monitor');
  let clock = 1_000_000;
  const monitor = new PerfMonitor({ now: () => clock });

  const healthy = monitor.evaluate(stats());
  check('a healthy sample is ok', healthy.verdict === 'ok', healthy.verdict);
  check('no findings on a healthy sample', healthy.findings.length === 0);

  // 30 s of runtime, then a hot callback.
  clock += 30_000;
  const hot = monitor.evaluate(stats({ cpuLoad: 0.78 }));
  check('an over-budget load warns', hot.verdict === 'warn');
  check('the finding names the metric', hot.findings[0]?.metric === 'cpuLoad');
  check('the message quotes both numbers', (hot.findings[0]?.message ?? '').includes('78.0'), hot.findings[0]?.message);

  const veryHot = monitor.evaluate(stats({ cpuLoad: 0.95 }));
  check('far over budget fails', veryHot.verdict === 'fail');

  const laggy = monitor.evaluate(stats({ latencyMs: 90 }));
  check('high latency fails', laggy.verdict === 'fail' && laggy.findings.some((finding) => finding.metric === 'latencyMs'));

  const xrunny = monitor.evaluate(stats({ xruns: 40 }));
  check('xruns are reported per minute', xrunny.findings.some((finding) => finding.metric === 'xruns'));
  check('too many xruns fail', xrunny.verdict === 'fail');

  const thin = monitor.evaluate(stats({ framesPerBuffer: 32, sampleRate: 48000 }));
  check('a too-short buffer warns', thin.findings.some((finding) => finding.metric === 'buffer'));

  const silent = monitor.evaluate(stats({ framesRendered: 0 }));
  check('an engine that renders nothing fails', silent.verdict === 'fail' && silent.findings.some((finding) => finding.metric === 'stopped'));

  section('Perf monitor: listeners and averages');
  let reports = 0;
  monitor.onReport(() => {
    reports += 1;
  });
  monitor.sample(stats(), 2);
  monitor.sample(stats(), 2);
  check('listener fires on the requested cadence', reports === 1, String(reports));
  monitor.sample(stats(), 2);
  check('and again on the next cadence', reports === 2);

  const averaging = new PerfMonitor({ now: () => clock });
  averaging.sample(stats({ cpuLoad: 0.2, latencyMs: 10 }));
  averaging.sample(stats({ cpuLoad: 0.4, latencyMs: 20 }));
  const average = averaging.rollingAverage();
  check('rolling average of load', near(average.cpuLoad, 0.3, 1e-9), String(average.cpuLoad));
  check('rolling average of latency', near(average.latencyMs, 15, 1e-9));
  averaging.reset();
  check('reset clears the samples', averaging.rollingAverage().cpuLoad === 0);

  section('Perf monitor: report format');
  const report = monitor.evaluate(stats({ cpuLoad: 0.9, xruns: 30 }));
  const text = monitor.format(report);
  check('report names the app', text.includes('AuraGrid diagnostics'));
  check('report states the verdict', text.includes('FAIL'));
  check('report includes the buffer configuration', text.includes('48000 Hz') && text.includes('128 frames'));
  check('report lists each finding', text.split('\n').length >= 4);

  section('Perf monitor: configurable budget');
  const strict = new PerfMonitor({ budget: { cpuLoad: 0.1 }, now: () => clock });
  clock += 30_000;
  check('a stricter budget rejects the same sample', strict.evaluate(stats({ cpuLoad: 0.3 })).verdict === 'warn');
  const lenient = new PerfMonitor({ budget: { cpuLoad: 0.99, maxLatencyMs: 200 }, now: () => clock });
  check('a looser budget accepts it', lenient.evaluate(stats({ cpuLoad: 0.3, latencyMs: 90 })).verdict === 'ok');
  check('default budget is documented in code', DEFAULT_BUDGET.cpuLoad === 0.7 && DEFAULT_BUDGET.minBufferMs > 0);
}
