import type { DeckControlTarget } from '../engine/DeckController';
import type { DeckId } from '../engine/types';
import type { Translator } from '../i18n/strings';
import type { BeatGrid } from '../analysis/BeatGrid';
import type { WaveformData } from '../analysis/WaveformData';

/**
 * Studio: the composition root.
 *
 * The ten sprint modules were each correct on their own, and none of them was
 * connected to the app — which is a quiet way of shipping nothing. This file is the
 * single place where they meet the engine, and each `src/app/wiring/*` module is one
 * sprint's adapter, installed in order and disposed in reverse.
 *
 * Everything here talks to *narrow interfaces*, never to the native module. That is
 * what lets the wiring be tested in Node in milliseconds: the tests hand in a fake
 * engine and assert on the calls it received.
 */

export type DeckIndex = DeckId;

/** Deck ids are a union of 0..3; state arrays are indexed numerically. */
export function asDeck(index: number): DeckId {
  return Math.max(0, Math.min(3, Math.trunc(index))) as DeckId;
}

/** The engine surface the wiring may use. Mirrors AudioEngine without importing it. */
export interface StudioEngine extends DeckControlTarget {
  readonly sampleRate: number;
  readonly currentBpm: number;
  readonly transportBeats: number;
  readonly beatPhase: number;
  readonly crossfaderValue: number;
  readonly masterGainValue: number;
  readonly recordedFrames: number;
  setDeckGain(deck: DeckIndex, gain: number): void;
  setStemGain(deck: DeckIndex, stem: string, gain: number): void;
  setFx(deck: DeckIndex, param: string, value: number): void;
  setFilterMode(deck: DeckIndex, mode: 'lowpass' | 'highpass'): void;
  setMasterGain(gain: number): void;
  setCrossfader(value: number): void;
  triggerPad(deck: DeckIndex, pad: number, velocity?: number): void;
  stopDeck(deck: DeckIndex): void;
  setBpm(bpm: number): void;
  startRecording(path: string): boolean;
  stopRecording(): void;
  onTelemetry(listener: (telemetry: StudioTelemetry) => void): () => void;
  /** Optional: only an engine that can rebuild its stream offers this. */
  setBufferFrames?(frames: number): void;
}

export interface StudioTelemetry {
  running: boolean;
  sampleRate: number;
  framesPerBuffer: number;
  latencyMs: number;
  cpuLoad: number;
  xruns: number;
}

/** What the MIDI layer hands to the wiring, already normalised. */
export interface StudioMidiMessage {
  type: 'cc' | 'note';
  channel: number;
  number: number;
  value: number;
}

export interface StudioMidi {
  subscribe(listener: (message: StudioMidiMessage) => void): () => void;
  /** Present when the hardware can draw: used for stem-row indication. */
  setPad?(row: number, col: number, color: { r: number; g: number; b: number }, mode?: 'static' | 'pulse' | 'flash'): void;
  flush?(): void;
}

export interface StudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStudioStorage implements StudioStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export interface DeckWiringState {
  bpm: number;
  camelot?: string;
  /** Song identity, so a restore knows what to reload. */
  trackId?: string | null;
  /** Playhead in seconds; kept by the wiring, not read back from the engine. */
  positionSeconds?: number;
  rate?: number;
  filter?: number;
  gain?: number;
  grid?: BeatGrid;
  /** Stem gains by name, 0..1. Absent means "no stems, full mix". */
  stemGains: Record<string, number>;
  waveform?: WaveformData;
  loop: { startFrame: number; endFrame: number } | null;
}

export interface StudioEvent {
  at: number;
  kind: string;
  message: string;
}

export interface StudioState {
  bpm: number;
  selectedDeck: DeckIndex;
  language: 'de' | 'en';
  decks: DeckWiringState[];
  recording: boolean;
  recordingPath: string | null;
  lastExport: { name: string; frames: number; peakDb: number } | null;
  recommendedBufferFrames: number | null;
  mesh: { peers: number; isMaster: boolean; qualityMs: number } | null;
  a11y: { failures: number; worstRatio: number } | null;
  events: StudioEvent[];
}

export type StudioCommand = (...args: never[]) => unknown;

export interface StudioContext {
  engine: StudioEngine;
  midi: StudioMidi | null;
  storage: StudioStorage;
  translator: Translator;
  state: StudioState;
  now(): number;
  /** Appends to the capped event log and notifies subscribers. */
  log(kind: string, message: string): void;
  /** Publishes a callable to the UI (e.g. `triggerQuantized`). */
  provide(name: string, command: StudioCommand): void;
  /** Marks state as changed so the UI re-reads it. */
  notify(): void;
  /** Registers a change listener; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  deck(index: DeckIndex): DeckWiringState;
}

export interface StudioPlugin {
  name: string;
  /** Sprint this plugin wires, for the diagnostics screen and the commit trail. */
  sprint: number;
  install(ctx: StudioContext): void | Promise<void>;
  dispose(): void;
}

export interface StudioInit {
  engine: StudioEngine;
  translator: Translator;
  storage?: StudioStorage;
  midi?: StudioMidi | null;
  deckCount?: number;
  now?: () => number;
}

const MAX_EVENTS = 200;

export class Studio {
  readonly ctx: StudioContext;
  readonly commands = new Map<string, StudioCommand>();
  private plugins: StudioPlugin[] = [];
  private listeners = new Set<() => void>();

  constructor(init: StudioInit) {
    const deckCount = init.deckCount ?? 4;
    const now = init.now ?? (() => Date.now());
    const decks: DeckWiringState[] = Array.from({ length: deckCount }, () => ({
      bpm: 0,
      stemGains: {},
      loop: null,
    }));
    const state: StudioState = {
      bpm: 120,
      selectedDeck: 0,
      language: init.translator.current,
      decks,
      recording: false,
      recordingPath: null,
      lastExport: null,
      recommendedBufferFrames: null,
      mesh: null,
      a11y: null,
      events: [],
    };

    this.ctx = {
      engine: init.engine,
      midi: init.midi ?? null,
      storage: init.storage ?? new MemoryStudioStorage(),
      translator: init.translator,
      state,
      now,
      log: (kind, message) => {
        state.events.push({ at: now(), kind, message });
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        this.notify();
      },
      provide: (name, command) => {
        this.commands.set(name, command);
      },
      notify: () => this.notify(),
      subscribe: (listener) => this.subscribe(listener),
      deck: (index) => {
        const deck = state.decks[Number(index)];
        if (!deck) throw new Error(`deck ${index} does not exist`);
        return deck;
      },
    };
  }

  /** Installs one sprint's wiring. Throws if the same name is installed twice. */
  async install(plugin: StudioPlugin): Promise<void> {
    if (this.plugins.some((existing) => existing.name === plugin.name)) {
      throw new Error(`plugin ${plugin.name} already installed`);
    }
    await plugin.install(this.ctx);
    this.plugins.push(plugin);
    this.ctx.log('boot', `sprint ${plugin.sprint}: ${plugin.name}`);
  }

  async boot(plugins: StudioPlugin[]): Promise<Studio> {
    for (const plugin of plugins) await this.install(plugin);
    return this;
  }

  /** Disposes in reverse install order, so dependents go before their base. */
  async shutdown(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        plugin.dispose();
      } catch (error) {
        this.ctx.log('error', `dispose ${plugin.name}: ${String(error)}`);
      }
    }
    this.plugins = [];
    this.notify();
  }

  get installed(): { name: string; sprint: number }[] {
    return this.plugins.map((plugin) => ({ name: plugin.name, sprint: plugin.sprint }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
