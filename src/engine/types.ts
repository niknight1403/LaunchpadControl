/**
 * Shared contracts between the TypeScript control plane and the C++ realtime core.
 *
 * Numeric values are used for decks, pads, stems and FX parameters on purpose:
 * they cross the JSI boundary as int32 and never allocate.
 */

export type DeckId = 0 | 1 | 2 | 3;
export const DECK_IDS: readonly DeckId[] = [0, 1, 2, 3];
export const DECK_COUNT = 4;

/** 8x8 main matrix plus a side column of scene/control buttons. */
export const GRID_SIZE = 8;
export const PAD_COUNT = GRID_SIZE * GRID_SIZE;

export type StemId = 'drums' | 'bass' | 'synth' | 'vocals';
export const STEM_IDS: readonly StemId[] = ['drums', 'bass', 'synth', 'vocals'];

/** Stem index as used by the native core (must match AudioCommand.hpp). */
export const STEM_INDEX: Record<StemId, number> = {
  drums: 0,
  bass: 1,
  synth: 2,
  vocals: 3,
};

/** FX parameters are addressed by index, not by string, inside the callback. */
export enum FxParam {
  FilterCutoff = 0,
  FilterResonance = 1,
  FilterMode = 2,
  StutterRate = 3,
  StutterMix = 4,
  DelayMix = 5,
  DelayFeedback = 6,
  DelayDrift = 7,
  Drive = 8,
}

export const FX_PARAM_NAMES: Record<FxParam, string> = {
  [FxParam.FilterCutoff]: 'Cutoff',
  [FxParam.FilterResonance]: 'Resonanz',
  [FxParam.FilterMode]: 'Filter-Modus',
  [FxParam.StutterRate]: 'Stutter-Rate',
  [FxParam.StutterMix]: 'Stutter-Mix',
  [FxParam.DelayMix]: 'Delay-Mix',
  [FxParam.DelayFeedback]: 'Feedback',
  [FxParam.DelayDrift]: 'Tape-Drift',
  [FxParam.Drive]: 'Drive',
};

export interface EngineConfig {
  /** 48000 is the only rate worth targeting for club latency. */
  sampleRate: number;
  /** 128 frames @ 48 kHz = 2.67 ms per quantum. */
  framesPerBuffer: number;
  /** Pre-allocated delay tail in seconds (no allocation in the callback, ever). */
  maxDelaySeconds?: number;
}

export interface EngineTelemetry {
  running: boolean;
  sampleRate: number;
  framesPerBuffer: number;
  /** Measured stream latency reported by Oboe, not a constant. */
  latencyMs: number;
  /** Smoothed callback load 0..1. Above 0.8 the UI must warn. */
  cpuLoad: number;
  /** Dropped commands / underruns since start. */
  xruns: number;
  activeVoices: number;
  masterPeak: number;
  transportBeats: number;
}

export interface PadTrigger {
  deck: DeckId;
  pad: number;
  velocity: number;
}

export type EngineEventType =
  | { type: 'voiceEnded'; deck: DeckId; pad: number }
  | { type: 'commandDropped'; code: number }
  | { type: 'underrun' };

/**
 * The JSI host object installed by `JsiAudioBindings.cpp`.
 * Every method is synchronous and allocation-free at call time.
 */
export interface NativeAudioCore {
  start(sampleRate: number, framesPerBuffer: number, maxDelaySeconds: number): boolean;
  stop(): void;

  loadClip(deck: number, path: string, bpm: number): number;
  unloadClip(deck: number, clipId: number): void;

  triggerPad(deck: number, pad: number, velocity: number): void;
  stopDeck(deck: number): void;

  setDeckGain(deck: number, gain: number): void;
  setStemGain(deck: number, stem: number, gain: number): void;
  setFx(deck: number, param: number, value: number): void;
  setMasterGain(gain: number): void;

  setTransport(bpm: number, phaseBeats: number): void;
  setCrossfader(value: number): void;

  /** Loop between two source frames (sample accurate, applied in the callback). */
  setLoop(deck: number, startFrame: number, endFrame: number): void;
  clearLoop(deck: number): void;
  /** Playback rate multiplier for beatmatching. */
  setDeckRate(deck: number, rate: number): void;
  seek(deck: number, frame: number): void;

  startRecording(path: string): boolean;
  stopRecording(): void;
  recordedFrames(): number;
  recordedDrops(): number;

  /** Drains the lock-free event ring. Returns one flat number[] per event. */
  pollEvents(): number[][];

  latencyMs(): number;
  cpuLoad(): number;
  xruns(): number;
  activeVoices(): number;
  masterPeak(): number;
  transportBeats(): number;
}

declare global {
  // Installed by the native module; undefined until start() is possible.
  // eslint-disable-next-line no-var
  var __AURAGRID_CORE__: NativeAudioCore | undefined;
}
