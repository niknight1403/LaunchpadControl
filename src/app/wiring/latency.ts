import { LatencyGovernor, governorSampleFrom } from '../../engine/LatencyGovernor';
import { PerfMonitor } from '../../diagnostics/PerfMonitor';
import type { StudioContext, StudioPlugin } from '../Studio';

export interface LatencyWiring {
  /** Current recommendation in frames, or null before the first sample. */
  recommended(): number | null;
  report(): string;
  /** Forces the ladder back to its starting point (used after a device change). */
  reset(frames?: number): void;
}

export function latencyPlugin(): StudioPlugin & { wiring: LatencyWiring | null } {
  const plugin: StudioPlugin & { wiring: LatencyWiring | null } = {
    name: 'latency',
    sprint: 18,
    wiring: null,
    install(ctx: StudioContext) {
      const governor = new LatencyGovernor({});
      const monitor = new PerfMonitor({});

      const unsubscribe = ctx.engine.onTelemetry((telemetry) => {
        const report = monitor.sample({
          cpuLoad: telemetry.cpuLoad,
          xruns: telemetry.xruns,
          latencyMs: telemetry.latencyMs,
          framesPerBuffer: telemetry.framesPerBuffer,
          sampleRate: telemetry.sampleRate,
        } as never);

        const decision = governor.observe(
          governorSampleFrom(telemetry.cpuLoad, telemetry.xruns, telemetry.latencyMs),
        );

        if (decision.framesPerBuffer !== telemetry.framesPerBuffer) {
          ctx.state.recommendedBufferFrames = decision.framesPerBuffer;
          // Applying a buffer size means rebuilding the stream. An engine that cannot
          // do that (or a running recording) gets the recommendation, not a restart:
          // silently dropping audio mid-take is worse than one more buffer of latency.
          if (ctx.engine.setBufferFrames && !ctx.state.recording) {
            ctx.engine.setBufferFrames(decision.framesPerBuffer);
            ctx.log('latency', `buffer ${telemetry.framesPerBuffer} → ${decision.framesPerBuffer} frames (${decision.reason})`);
          } else {
            ctx.log('latency', `recommend ${decision.framesPerBuffer} frames (${decision.reason}), engine keeps ${telemetry.framesPerBuffer}`);
          }
          ctx.notify();
        }

        if (report.verdict === 'fail') {
          ctx.log('latency', monitor.format(report));
        }
      });

      const wiring: LatencyWiring = {
        recommended: () => ctx.state.recommendedBufferFrames,
        report: () => monitor.format(monitor.evaluate({
          cpuLoad: 0,
          xruns: 0,
          latencyMs: 0,
          framesPerBuffer: governor.framesPerBuffer,
          sampleRate: ctx.engine.sampleRate,
        } as never)),
        reset: (frames) => {
          governor.reset(frames);
          ctx.state.recommendedBufferFrames = governor.framesPerBuffer;
          ctx.notify();
        },
      };
      plugin.wiring = wiring;

      ctx.provide('latencyRecommended', wiring.recommended);
      ctx.provide('latencyReport', wiring.report);
      ctx.provide('resetLatencyGovernor', wiring.reset);
      plugin.dispose = () => unsubscribe();
    },
    dispose() {
      /* replaced in install */
    },
  };
  return plugin;
}
