import type { EngineConfig, NativeAudioCore } from './types';

/**
 * Resolves the native JSI core, or a transport-accurate silent stand-in.
 *
 * Why a fallback: without it, every UI/MIDI/agent iteration requires an NDK
 * build. The fallback keeps time (so the agent's scheduling really runs) but
 * produces no sound. It is explicit about it through `isSilent`.
 */

export interface CoreHandle {
  core: NativeAudioCore;
  isSilent: boolean;
  reason: string;
}

function nativeCore(): NativeAudioCore | undefined {
  const candidate = (globalThis as { __AURAGRID_CORE__?: NativeAudioCore }).__AURAGRID_CORE__;
  if (!candidate) return undefined;
  // Probe one cheap call: a half-installed host object must not crash the app.
  try {
    candidate.latencyMs();
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Silent bridge. Keeps a monotonic clock running at the requested quantum so
 * agent look-ahead and transport maths behave exactly as on device.
 */
class SilentCore implements NativeAudioCore {
  private running = false;
  private startedAt = 0;
  private bpm = 120;
  private phase = 0;
  private gains = new Map<string, number>();
  private events: number[][] = [];
  private voices = 0;
  private crossfader = 0.5;
  private loops = new Map<number, { startFrame: number; endFrame: number }>();
  private rates = new Map<number, number>();
  private seeks = new Map<number, number>();
  private recordingPath: string | null = null;
  private recordStartMs: number | null = null;
  private recorded = 0;

  constructor(private config: EngineConfig) {}

  start(): boolean {
    this.running = true;
    this.startedAt = Date.now();
    return true;
  }

  stop(): void {
    this.running = false;
    this.voices = 0;
    this.events = [];
  }

  loadClip(): number {
    return 1;
  }

  unloadClip(): void {}

  triggerPad(_deck: number, pad: number, velocity: number): void {
    if (!this.running) return;
    this.voices = Math.min(8, this.voices + 1);
    // Model a 2-bar clip tail so voice accounting in the UI is realistic.
    setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
      this.events.push([1, _deck, pad]); // 1 === voiceEnded
    }, 4_000);
    this.gains.set(`pad:${_deck}:${pad}`, velocity);
  }

  stopDeck(deck: number): void {
    this.voices = Math.max(0, this.voices - 1);
    this.events.push([1, deck, -1]);
  }

  setDeckGain(deck: number, gain: number): void {
    this.gains.set(`deck:${deck}`, gain);
  }

  setStemGain(deck: number, stem: number, gain: number): void {
    this.gains.set(`stem:${deck}:${stem}`, gain);
  }

  setFx(_deck: number, _param: number, _value: number): void {}

  setMasterGain(gain: number): void {
    this.gains.set('master', gain);
  }

  setTransport(bpm: number, phaseBeats: number): void {
    this.bpm = bpm;
    this.phase = phaseBeats;
  }

  setCrossfader(value: number): void {
    this.crossfader = value;
  }

  setLoop(deck: number, startFrame: number, endFrame: number): void {
    this.loops.set(deck, { startFrame, endFrame });
  }

  clearLoop(deck: number): void {
    this.loops.delete(deck);
  }

  setDeckRate(deck: number, rate: number): void {
    this.rates.set(deck, rate);
  }

  seek(deck: number, frame: number): void {
    this.seeks.set(deck, frame);
  }

  /** Exposed for tests. */
  getSeek(deck: number): number | undefined {
    return this.seeks.get(deck);
  }

  startRecording(path: string): boolean {
    this.recordingPath = path;
    this.recordStartMs = Date.now();
    this.recorded = 0;
    return true;
  }

  stopRecording(): void {
    this.recorded = this.recordedFrames();
    this.recordingPath = null;
    this.recordStartMs = null;
  }

  recordedFrames(): number {
    // The silent bridge still accounts time, so a rehearsal produces a take of
    // the right length (with no audio) instead of a zero-length file.
    if (!this.recordingPath) return this.recorded;
    const elapsed = (Date.now() - (this.recordStartMs ?? Date.now())) / 1000;
    return Math.round(elapsed * this.config.sampleRate);
  }

  recordedDrops(): number {
    return 0;
  }

  /** Exposed for tests. */
  get recording(): string | null {
    return this.recordingPath;
  }

  /** Exposed for tests: what the silent bridge was told. */
  getLoop(deck: number): { startFrame: number; endFrame: number } | undefined {
    return this.loops.get(deck);
  }

  getRate(deck: number): number {
    return this.rates.get(deck) ?? 1;
  }

  pollEvents(): number[][] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  latencyMs(): number {
    return 0;
  }

  cpuLoad(): number {
    return 0;
  }

  xruns(): number {
    return 0;
  }

  activeVoices(): number {
    return this.voices;
  }

  masterPeak(): number {
    return Math.min(1, this.voices / 8) * (this.gains.get('master') ?? 1);
  }

  transportBeats(): number {
    if (!this.running) return 0;
    const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
    return this.phase + (elapsedSeconds * this.bpm) / 60;
  }

  /** Exposed for diagnostics only. */
  get crossfade(): number {
    return this.crossfader;
  }

  get quantum(): number {
    return this.config.framesPerBuffer / this.config.sampleRate;
  }
}

export function resolveCore(config: EngineConfig): CoreHandle {
  const native = nativeCore();
  if (native) {
    return { core: native, isSilent: false, reason: 'native-jsi' };
  }
  return {
    core: new SilentCore(config),
    isSilent: true,
    reason: 'Native core not installed (no prebuild / simulator). Running the silent transport bridge.',
  };
}
