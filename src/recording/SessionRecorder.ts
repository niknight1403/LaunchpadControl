/**
 * Session recorder: turns the core's live capture into a documented take.
 *
 * The heavy lifting is native (a writer thread drains a lock-free ring into a
 * WAV). This class owns the *narrative*: when it started, which markers the DJ
 * set, and how long the take ran — the things you actually need when you listen
 * back the next morning.
 */

export interface RecordingEngine {
  startRecording(path: string): boolean;
  stopRecording(): void;
  /** Frames captured so far. A getter, matching AudioEngine's shape. */
  readonly recordedFrames: number;
  readonly sampleRate: number;
}

export interface RecordingPaths {
  /** Returns a writable absolute path for a take name. */
  preparePath(takeName: string): string;
}

export interface RecordingMarker {
  label: string;
  /** Transport position when the marker was dropped, if known. */
  beats: number | null;
  /** Wall clock, matching the timeline of the take. */
  atMs: number;
  /** Offset from the start of the take. */
  offsetSeconds: number;
}

export interface StartedTake {
  id: string;
  name: string;
  path: string;
  startedAt: number;
}

export interface Take {
  id: string;
  name: string;
  path: string;
  startedAt: number;
  stoppedAt: number;
  frames: number;
  durationSeconds: number;
  sampleRate: number;
  markers: RecordingMarker[];
  /** True when the ring overflowed: audio was lost. */
  dropped: boolean;
}

export interface SessionRecorderOptions {
  now?: () => number;
  sampleRate?: number;
}

export class SessionRecorder {
  private engine: RecordingEngine;
  private paths: RecordingPaths;
  private now: () => number;
  private sampleRate: number;

  private current: StartedTake | null = null;
  private markers: RecordingMarker[] = [];
  private takes: Take[] = [];
  private beatClock: (() => number) | null = null;

  constructor(engine: RecordingEngine, paths: RecordingPaths, options: SessionRecorderOptions = {}) {
    this.engine = engine;
    this.paths = paths;
    this.now = options.now ?? (() => Date.now());
    this.sampleRate = options.sampleRate ?? engine.sampleRate ?? 48000;
  }

  /** Feeds transport position into markers; optional. */
  attachTransport(beatClock: () => number): void {
    this.beatClock = beatClock;
  }

  get isRecording(): boolean {
    return this.current !== null;
  }

  get activeName(): string | null {
    return this.current?.name ?? null;
  }

  /** Starts a take. Returns null when a take is already running or the core refused. */
  start(name?: string, id?: string): StartedTake | null {
    if (this.current) return null;
    const timestamp = this.now();
    const takeName = name ?? `Set ${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')}`;
    const path = this.paths.preparePath(takeName);
    if (!this.engine.startRecording(path)) return null;

    const started: StartedTake = {
      id: id ?? `take-${timestamp.toString(36)}`,
      name: takeName,
      path,
      startedAt: timestamp,
    };
    this.current = started;
    this.markers = [];
    return started;
  }

  /** Drops a marker at the current position. */
  addMarker(label: string): RecordingMarker | null {
    if (!this.current) return null;
    const atMs = this.now();
    const marker: RecordingMarker = {
      label,
      beats: this.beatClock ? Math.round(this.beatClock() * 1000) / 1000 : null,
      atMs,
      offsetSeconds: Math.round(((atMs - this.current.startedAt) / 1000) * 100) / 100,
    };
    this.markers.push(marker);
    return marker;
  }

  /** Stops the take and returns it with markers and duration. */
  stop(): Take | null {
    if (!this.current) return null;
    const stoppedAt = this.now();
    this.engine.stopRecording();
    const frames = this.engine.recordedFrames;
    const take: Take = {
      id: this.current.id,
      name: this.current.name,
      path: this.current.path,
      startedAt: this.current.startedAt,
      stoppedAt,
      frames,
      durationSeconds: this.sampleRate > 0 ? Math.round((frames / this.sampleRate) * 100) / 100 : 0,
      sampleRate: this.sampleRate,
      markers: [...this.markers],
      dropped: false,
    };
    this.takes.push(take);
    this.current = null;
    this.markers = [];
    return take;
  }

  /** All takes from this session, newest last. */
  history(): Take[] {
    return [...this.takes];
  }

  /** Markers as a cue sheet, the format a DAW and a human both accept. */
  cueSheet(take: Take): string {
    const lines = [`# ${take.name}`, `# ${take.durationSeconds}s @ ${take.sampleRate} Hz`, ''];
    for (const marker of take.markers) {
      const minutes = Math.floor(marker.offsetSeconds / 60);
      const seconds = (marker.offsetSeconds % 60).toFixed(2).padStart(5, '0');
      lines.push(`${String(minutes).padStart(2, '0')}:${seconds}  ${marker.label}`);
    }
    return lines.join('\n');
  }
}
