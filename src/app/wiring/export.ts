import { buildExportBundle, peakDb } from '../../recording/PostProcess';
import type { StudioContext, StudioPlugin } from '../Studio';

/**
 * Sprint 16 wiring: a finished take becomes a file the DJ can use.
 *
 * The post-processing knew how to normalise, fade and trim. What was missing is the
 * handover: decide *when* a take is done, write it somewhere, and keep a manifest the UI
 * can show without re-reading the audio.
 *
 * Two defaults are chosen here rather than left to callers, because they are the ones
 * that make a phone recording usable: normalise towards -1 dBFS (headroom, not clipping)
 * and trim relative silence at both ends.
 */
export interface ExportWiring {
  /** Starts or stops the engine recorder. Returns the recording state after the call. */
  toggleRecord(path?: string): { recording: boolean; path: string | null };
  /** Post-processes a finished buffer and writes it through the supplied sink. */
  exportTake(
    deck: number,
    channels: readonly Float32Array[],
    sampleRate: number,
    name?: string,
  ): { manifest: { name: string; peakDb: number; durationSeconds: number; channels: number }; wav: Uint8Array; cueSheet: string };
  describe(): string;
}

export interface ExportPluginOptions {
  /** Where the bytes go. Defaults to keeping them in memory for the UI to preview. */
  writeFile?: (name: string, bytes: Uint8Array) => void;
  targetPeakDb?: number;
  fadeSeconds?: number;
}

export function exportPlugin(options: ExportPluginOptions = {}): StudioPlugin & { wiring: ExportWiring | null } {
  const plugin: StudioPlugin & { wiring: ExportWiring | null } = {
    name: 'export',
    sprint: 16,
    wiring: null,
    install(ctx: StudioContext) {
      let takeCounter = 0;

      const wiring: ExportWiring = {
        toggleRecord: (path) => {
          if (ctx.state.recording) {
            ctx.engine.stopRecording();
            ctx.state.recording = false;
            const frames = ctx.engine.recordedFrames;
            ctx.log('export', `recording stopped after ${frames} frames`);
            ctx.notify();
            return { recording: false, path: ctx.state.recordingPath };
          }
          const target = path ?? `auragrid-take-${takeCounter += 1}.wav`;
          const started = ctx.engine.startRecording(target);
          ctx.state.recording = started;
          ctx.state.recordingPath = started ? target : null;
          ctx.log('export', started ? `recording to ${target}` : 'recording refused by the engine');
          ctx.notify();
          return { recording: started, path: ctx.state.recordingPath };
        },
        exportTake: (deck, channels, sampleRate, name) => {
          const label = name ?? `Deck ${deck} Take ${takeCounter += 1}`;
          const bundle = buildExportBundle(channels, {
            name: label,
            createdAt: ctx.now(),
            sampleRate,
            targetPeakDb: options.targetPeakDb ?? -1,
            fadeSeconds: options.fadeSeconds ?? 0.005,
            trim: true,
          });
          options.writeFile?.(`${label}.wav`, bundle.wav);
          ctx.storage.setItem(`auragrid.export.${label}.cue`, bundle.cueSheet);
          ctx.storage.setItem(`auragrid.export.${label}.json`, JSON.stringify(bundle.manifest));
          ctx.state.lastExport = {
            name: label,
            frames: Math.round(bundle.manifest.durationSeconds * sampleRate),
            peakDb: bundle.manifest.peakDb,
          };
          ctx.log('export', `${label}: ${bundle.manifest.durationSeconds.toFixed(2)} s at ${bundle.manifest.peakDb.toFixed(1)} dBFS`);
          ctx.notify();
          return bundle;
        },
        describe: () => {
          const last = ctx.state.lastExport;
          if (!last) return 'no take exported yet';
          return `${last.name}: ${(last.frames / 48_000).toFixed(1)} s, peak ${peakDb([new Float32Array(1)]) > -999 ? last.peakDb.toFixed(1) : ''} dBFS`;
        },
      };
      plugin.wiring = wiring;

      ctx.provide('toggleRecord', wiring.toggleRecord);
      ctx.provide('exportTake', wiring.exportTake);
      ctx.provide('transport:record', () => wiring.toggleRecord());
    },
    dispose() {
      /* the engine owns the recorder */
    },
  };
  return plugin;
}
