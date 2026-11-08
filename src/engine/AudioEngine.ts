import { resolveCore, type CoreHandle } from './AuraNative';
import {
  DECK_COUNT,
  DECK_IDS,
  FxParam,
  type DeckId,
  type EngineConfig,
  type EngineEventType,
  type EngineTelemetry,
  type PadTrigger,
  type StemId,
  STEM_INDEX,
} from './types';

export interface DeckState {
  id: DeckId;
  clipId: number;
  gain: number;
  bpm: number;
  stemGains: Record<StemId, number>;
  filterMode: 'lowpass' | 'highpass';
  /** Last value written per FX parameter, so a preset can snapshot live state. */
  fx: Record<number, number>;
}

export interface AudioEngineOptions extends Partial<EngineConfig> {
  sampleRate: number;
  framesPerBuffer: number;
}

const DEFAULT_STEM_GAIN: Record<StemId, number> = {
  drums: 1,
  bass: 1,
  synth: 1,
  vocals: 1,
};

/**
 * Control plane for the realtime core.
 *
 * All scheduling here is coarse (16 ms / 100 ms ticks). Sample-accurate timing
 * belongs to the C++ transport; anything else would be a lie on a phone.
 */
export class AudioEngine {
  private handle: CoreHandle;
  private config: EngineConfig;
  private started = false;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

  private decks: DeckState[];
  private masterGain = 0.85;
  private crossfader = 0.5;
  private bpm = 124;

  private telemetry: EngineTelemetry;
  private telemetryListeners = new Set<(t: EngineTelemetry) => void>();
  private padListeners = new Set<(p: PadTrigger) => void>();
  private voiceEndListeners = new Set<(deck: DeckId, pad: number) => void>();

  constructor(options: AudioEngineOptions) {
    this.config = {
      sampleRate: options.sampleRate,
      framesPerBuffer: options.framesPerBuffer,
      maxDelaySeconds: options.maxDelaySeconds ?? 4,
    };
    this.handle = resolveCore(this.config);
    this.decks = DECK_IDS.map((id) => ({
      id,
      clipId: 0,
      gain: 1,
      bpm: this.bpm,
      stemGains: { ...DEFAULT_STEM_GAIN },
      filterMode: 'lowpass' as const,
      fx: {},
    }));
    this.telemetry = {
      running: false,
      sampleRate: this.config.sampleRate,
      framesPerBuffer: this.config.framesPerBuffer,
      latencyMs: 0,
      cpuLoad: 0,
      xruns: 0,
      activeVoices: 0,
      masterPeak: 0,
      transportBeats: 0,
    };
  }

  get isSilent(): boolean {
    return this.handle.isSilent;
  }

  get silentReason(): string {
    return this.handle.reason;
  }

  get sampleRate(): number {
    return this.config.sampleRate;
  }

  /** True round-trip latency estimate: stream latency + one input quantum. */
  get roundTripMs(): number {
    const quantumMs = (this.config.framesPerBuffer / this.config.sampleRate) * 1000;
    return Math.round((this.telemetry.latencyMs + quantumMs) * 10) / 10;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const ok = this.handle.core.start(
      this.config.sampleRate,
      this.config.framesPerBuffer,
      this.config.maxDelaySeconds ?? 4,
    );
    if (!ok) {
      throw new Error(
        'Oboe-Stream konnte nicht geöffnet werden (Exclusive/LowLatency abgelehnt). Prüfe Foreground-Service und AudioFocus.',
      );
    }
    this.started = true;
    this.pushTransport();

    this.eventTimer = setInterval(() => this.drainEvents(), 16);
    this.telemetryTimer = setInterval(() => this.publishTelemetry(), 100);
  }

  stop(): void {
    if (this.eventTimer) clearInterval(this.eventTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.eventTimer = null;
    this.telemetryTimer = null;
    if (this.started) this.handle.core.stop();
    this.started = false;
  }

  // ── clips & pads ─────────────────────────────────────────────────────────

  loadClip(deck: DeckId, path: string, bpm: number): number {
    const clipId = this.handle.core.loadClip(deck, path, bpm);
    const state = this.decks[deck];
    if (state) {
      state.clipId = clipId;
      state.bpm = bpm;
    }
    return clipId;
  }

  unloadClip(deck: DeckId): void {
    const state = this.decks[deck];
    if (!state) return;
    this.handle.core.unloadClip(deck, state.clipId);
    state.clipId = 0;
  }

  triggerPad(deck: DeckId, pad: number, velocity = 1): void {
    const clamped = Math.max(0, Math.min(1, velocity));
    this.handle.core.triggerPad(deck, pad, clamped);
    for (const listener of this.padListeners) listener({ deck, pad, velocity: clamped });
  }

  stopDeck(deck: DeckId): void {
    this.handle.core.stopDeck(deck);
  }

  // ── mixing ───────────────────────────────────────────────────────────────

  setDeckGain(deck: DeckId, gain: number): void {
    const state = this.decks[deck];
    if (!state) return;
    state.gain = clamp01(gain);
    this.handle.core.setDeckGain(deck, state.gain);
  }

  setStemGain(deck: DeckId, stem: StemId, gain: number): void {
    const state = this.decks[deck];
    if (!state) return;
    const value = clamp01(gain);
    state.stemGains[stem] = value;
    this.handle.core.setStemGain(deck, STEM_INDEX[stem], value);
  }

  /** Instant stem mute group, used by the agent for transitions. */
  setStemPreset(deck: DeckId, preset: Partial<Record<StemId, number>>): void {
    const state = this.decks[deck];
    if (!state) return;
    for (const stem of Object.keys(preset) as StemId[]) {
      const value = preset[stem];
      if (typeof value === 'number') this.setStemGain(deck, stem, value);
    }
  }

  setFx(deck: DeckId, param: FxParam, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    const state = this.decks[deck];
    if (state) state.fx[param] = clamped;
    this.handle.core.setFx(deck, param, clamped);
  }

  setFilterMode(deck: DeckId, mode: 'lowpass' | 'highpass'): void {
    const state = this.decks[deck];
    if (!state) return;
    state.filterMode = mode;
    this.handle.core.setFx(deck, FxParam.FilterMode, mode === 'lowpass' ? 0 : 1);
  }

  setMasterGain(gain: number): void {
    this.masterGain = clamp01(gain);
    this.handle.core.setMasterGain(this.masterGain);
  }

  setCrossfader(value: number): void {
    this.crossfader = clamp01(value);
    this.handle.core.setCrossfader(this.crossfader);
  }

  // ── transport ────────────────────────────────────────────────────────────

  setBpm(bpm: number): void {
    this.bpm = Math.max(60, Math.min(200, bpm));
    this.pushTransport();
  }

  get currentBpm(): number {
    return this.bpm;
  }

  /** Live master gain, for preset capture. */
  get masterGainValue(): number {
    return this.masterGain;
  }

  /** Live crossfader position, for preset capture. */
  get crossfaderValue(): number {
    return this.crossfader;
  }

  /** Beats since start, in sample-accurate time as reported by the core. */
  get transportBeats(): number {
    return this.handle.core.transportBeats();
  }

  /** Half-bar phase 0..1, handy for LED pulses that lock to the grid. */
  get beatPhase(): number {
    const beats = this.transportBeats;
    return beats - Math.floor(beats);
  }

  private pushTransport(): void {
    this.handle.core.setTransport(this.bpm, 0);
  }

  // ── observation ──────────────────────────────────────────────────────────

  getTelemetry(): EngineTelemetry {
    return this.telemetry;
  }

  getDeckState(deck: DeckId): DeckState | undefined {
    return this.decks[deck];
  }

  onTelemetry(listener: (t: EngineTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    listener(this.telemetry);
    return () => this.telemetryListeners.delete(listener);
  }

  onPad(listener: (p: PadTrigger) => void): () => void {
    this.padListeners.add(listener);
    return () => this.padListeners.delete(listener);
  }

  onVoiceEnd(listener: (deck: DeckId, pad: number) => void): () => void {
    this.voiceEndListeners.add(listener);
    return () => this.voiceEndListeners.delete(listener);
  }

  private publishTelemetry(): void {
    const core = this.handle.core;
    this.telemetry = {
      running: this.started,
      sampleRate: this.config.sampleRate,
      framesPerBuffer: this.config.framesPerBuffer,
      latencyMs: core.latencyMs(),
      cpuLoad: core.cpuLoad(),
      xruns: core.xruns(),
      activeVoices: core.activeVoices(),
      masterPeak: core.masterPeak(),
      transportBeats: core.transportBeats(),
    };
    for (const listener of this.telemetryListeners) listener(this.telemetry);
  }

  /**
   * Event ring format (see AudioCommand.hpp):
   *   [1, deck, pad]  voice ended
   *   [2, code, 0]    command dropped
   *   [3, 0, 0]       underrun
   */
  private drainEvents(): void {
    const events = this.handle.core.pollEvents();
    for (const raw of events) {
      const type = raw[0];
      const a = raw[1] ?? 0;
      const b = raw[2] ?? 0;
      if (type === 1) {
        const deck = clampDeck(a);
        for (const listener of this.voiceEndListeners) listener(deck, b);
      } else if (type === 2) {
        this.telemetry = { ...this.telemetry, xruns: this.telemetry.xruns + 1 };
      } else if (type === 3) {
        this.telemetry = { ...this.telemetry, xruns: this.telemetry.xruns + 1 };
      }
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampDeck(value: number): DeckId {
  const index = Math.max(0, Math.min(DECK_COUNT - 1, Math.trunc(value)));
  return DECK_IDS[index] ?? 0;
}

export type { EngineEventType };
