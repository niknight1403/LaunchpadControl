import * as FileSystem from 'expo-file-system';

import type { StemId } from '../engine/types';

export interface StemSet {
  drums: string;
  bass: string;
  synth: string;
  vocals: string;
}

export interface StemJob {
  id: string;
  sourcePath: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  stems?: StemSet;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type StemProgressListener = (job: StemJob) => void;

/**
 * Native separator contract.
 *
 * `android/app/src/main/java/com/auragrid/launchpad/StemModule.kt` is expected
 * to wrap ONNX Runtime Mobile with a 4-stem model. The model file is *not* in
 * this repository: it is hundreds of megabytes and a licensing question, not a
 * code question. Until a model is dropped in, `separate()` throws a clear error
 * and the agent falls back to full-mix playback instead of pretending.
 */
interface StemNativeModule {
  separate(sourcePath: string, outputDir: string): Promise<StemSet>;
  cancel(jobId: string): Promise<void>;
}

const nativeStems = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__AURAGRID_STEMS__ ?? ((globalThis as any).NativeModules?.AuraStems as StemNativeModule | undefined)
) as StemNativeModule | undefined;

/**
 * Job runner for on-device stem separation.
 *
 * Serial by design: separation is thermally expensive, and running two jobs on
 * a phone in a club means thermal throttling right before the set matters.
 */
export class StemSeparator {
  private jobs = new Map<string, StemJob>();
  private queue: string[] = [];
  private running = false;
  private listeners = new Set<StemProgressListener>();
  private counter = 0;

  get isAvailable(): boolean {
    return nativeStems !== undefined;
  }

  enqueue(sourcePath: string): StemJob {
    this.counter += 1;
    const job: StemJob = {
      id: `stem-${Date.now()}-${this.counter}`,
      sourcePath,
      status: 'queued',
      progress: 0,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.emit(job);
    void this.pump();
    return job;
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const wasRunning = job.status === 'running';
    this.queue = this.queue.filter((id) => id !== jobId);
    job.status = 'cancelled';
    this.emit(job);
    if (wasRunning) void nativeStems?.cancel(jobId);
  }

  getJob(jobId: string): StemJob | undefined {
    return this.jobs.get(jobId);
  }

  list(): StemJob[] {
    return [...this.jobs.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  onProgress(listener: StemProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job || job.status !== 'queued') {
      void this.pump();
      return;
    }

    this.running = true;
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit(job);

    try {
      if (!nativeStems) {
        throw new Error(
          'Kein Stem-Modell installiert. ONNX-Runtime-Mobile + 4-Stem-Modell einbinden (siehe docs/BUILD.md), sonst bleibt der Agent auf dem Vollmix.',
        );
      }
      const outputDir = `${FileSystem.cacheDirectory}stems/${job.id}/`;
      const dir = await FileSystem.getInfoAsync(outputDir);
      if (!dir.exists) await FileSystem.makeDirectoryAsync(outputDir, { intermediates: true });

      job.progress = 0.1;
      this.emit(job);
      const stems = await nativeStems.separate(job.sourcePath, outputDir);
      job.stems = stems;
      job.progress = 1;
      job.status = 'done';
      job.finishedAt = Date.now();
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
    } finally {
      this.emit(job);
      this.running = false;
      void this.pump();
    }
  }

  private emit(job: StemJob): void {
    for (const listener of this.listeners) listener({ ...job });
  }

  /** Which stems can be mixed independently for this deck. */
  static allStems(): StemId[] {
    return ['drums', 'bass', 'synth', 'vocals'];
  }
}
