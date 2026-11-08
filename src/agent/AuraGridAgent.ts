import type { AudioEngine } from '../engine/AudioEngine';
import { FxParam, type DeckId } from '../engine/types';
import type { LaunchpadMidiManager } from '../midi/LaunchpadMidiManager';
import type { PadLed } from '../midi/types';
import { aura } from '../theme/aura';

import {
  describeKeyMove,
  estimateKey,
  harmonicCompatibility,
  makeKey,
  nextKeyCandidates,
  requiredTempoShift,
  tempoMatchScore,
  type MusicalKey,
} from './harmonic';
import { MeshClockSync } from './MeshClockSync';
import type { MeshTransport } from './MeshTransport';
import { StemSeparator } from './StemSeparator';
import { LookaheadTimeline } from './Timeline';

export interface Track {
  id: string;
  title: string;
  artist?: string;
  /** Absolute file path or content URI the engine can load. */
  path: string;
  bpm: number;
  key: MusicalKey;
  /** 0..1 perceived energy, used by the co-pilot to shape the arc of a set. */
  energy: number;
  stems?: { drums: string; bass: string; synth: string; vocals: string };
}

export interface AgentSuggestion {
  track: Track;
  score: number;
  harmonicScore: number;
  tempoScore: number;
  energyScore: number;
  /** Beatmatch nudge in percent, e.g. 0.021 = +2.1 %. */
  tempoShift: number;
  reason: string;
}

export interface AgentStatus {
  running: boolean;
  coPilot: boolean;
  meshSynced: boolean;
  meshPeers: number;
  masterId: string;
  clockQualityMs: number;
  activeDeck: DeckId;
  bpm: number;
  key: MusicalKey | null;
  energy: number;
  suggestion: AgentSuggestion | null;
  transitionRunning: boolean;
  /** Human-readable last decision, shown in the UI ticker. */
  lastAction: string;
}

export interface AgentOptions {
  /** Length of an autonomous transition in bars. */
  transitionBars?: number;
  /** 0..1: how much the agent is allowed to do without a human. */
  autonomy?: number;
}

const EMPTY_KEY = makeKey(9, 'minor'); // A minor / 8A, a safe default

/**
 * AuraGrid agent.
 *
 * Three responsibilities, deliberately no more:
 *  1. Suggest the next track (harmonic × tempo × energy).
 *  2. Execute a musically timed transition when asked (or when autonomous).
 *  3. Keep the swarm clock and preset exchange together.
 *
 * It never touches audio buffers. Every action is a control-plane call on a
 * lookahead timeline, so nothing it does can cause an audio dropout.
 */
export class AuraGridAgent {
  private engine: AudioEngine;
  private midi: LaunchpadMidiManager;
  private timeline = new LookaheadTimeline({ tickMs: 16, lookaheadMs: 120 });
  private clockSync = new MeshClockSync();
  readonly stems = new StemSeparator();

  private library: Track[] = [];
  private current: Track | null = null;
  private activeDeck: DeckId = 0;
  private coPilot = false;
  private running = false;
  private transitionRunning = false;
  private lastAction = 'Agent bereit';
  private suggestion: AgentSuggestion | null = null;
  private energy = 0.5;
  private options: Required<AgentOptions>;

  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusListeners = new Set<(status: AgentStatus) => void>();
  private unsubscribers: (() => void)[] = [];

  constructor(engine: AudioEngine, midi: LaunchpadMidiManager, options: AgentOptions = {}) {
    this.engine = engine;
    this.midi = midi;
    this.options = {
      transitionBars: options.transitionBars ?? 8,
      autonomy: options.autonomy ?? 0.5,
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timeline.start();

    this.unsubscribers.push(
      this.midi.onControl((hit) => {
        if (!hit.pressed) return;
        this.handleControl(hit.area, hit.index);
      }),
    );
    this.unsubscribers.push(
      this.midi.onPad((hit) => {
        if (!hit.pressed) return;
        this.noteHumanActivity();
      }),
    );

    this.statusTimer = setInterval(() => {
      this.refreshSuggestion();
      this.tick();
      void this.publishStatus();
    }, 500);

    this.paintControlLeds();
    void this.publishStatus();
  }

  stop(): void {
    this.running = false;
    this.timeline.stop();
    this.clockSync.stop();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  // ── library & selection ──────────────────────────────────────────────────

  setLibrary(tracks: Track[]): void {
    this.library = tracks;
    this.refreshSuggestion();
  }

  setCurrent(track: Track, deck: DeckId = this.activeDeck): void {
    this.current = track;
    this.activeDeck = deck;
    this.energy = track.energy;
    this.engine.setBpm(track.bpm);
    this.engine.loadClip(deck, track.path, track.bpm);
    this.lastAction = `Geladen: ${track.title} · ${track.bpm} BPM · ${track.key.camelot}`;
    void this.publishStatus();
  }

  /** Score every library track against the current one. */
  rankCandidates(limit = 5): AgentSuggestion[] {
    if (!this.current) return [];
    return this.library
      .filter((track) => track.id !== this.current?.id)
      .map((track) => this.scoreTrack(this.current as Track, track))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private scoreTrack(from: Track, to: Track): AgentSuggestion {
    const harmonicScore = harmonicCompatibility(from.key, to.key);
    const tempoScore = tempoMatchScore(from.bpm, to.bpm);
    // Energy: reward a gentle climb, punish a cliff.
    const energyDelta = to.energy - from.energy;
    const energyScore = Math.max(0, 1 - Math.abs(energyDelta) * 1.8);

    const score = harmonicScore * 0.5 + tempoScore * 0.3 + energyScore * 0.2;
    return {
      track: to,
      score: round(score),
      harmonicScore: round(harmonicScore),
      tempoScore: round(tempoScore),
      energyScore: round(energyScore),
      tempoShift: requiredTempoShift(from.bpm, to.bpm),
      reason: describeKeyMove(from.key, to.key),
    };
  }

  private refreshSuggestion(): void {
    if (!this.current || this.library.length === 0) {
      this.suggestion = null;
      return;
    }
    this.suggestion = this.rankCandidates(1)[0] ?? null;
  }

  getSuggestion(): AgentSuggestion | null {
    return this.suggestion;
  }

  // ── transitions ──────────────────────────────────────────────────────────

  /**
   * Blend the current track into the suggested one over `bars` bars.
   *
   * Musical order matters: filter the outgoing deck *before* the stem swap, so
   * the crowd never hears two kick drums fight. Everything is scheduled on the
   * timeline, which means the transition survives a dropped frame.
   */
  performTransition(target?: Track, bars = this.options.transitionBars): void {
    const next = target ?? this.suggestion?.track;
    if (!next || this.transitionRunning) return;

    const incomingDeck = ((this.activeDeck + 1) % 4) as DeckId;
    const outgoingDeck = this.activeDeck;
    const secondsPerBeat = 60 / (this.current?.bpm ?? this.engine.currentBpm);
    const totalMs = bars * 4 * secondsPerBeat * 1000;
    const now = this.clockSync.syncedNow();
    const tag = `transition:${outgoingDeck}->${incomingDeck}`;

    this.transitionRunning = true;
    this.lastAction = `Transition: ${next.title} über ${bars} Bars`;
    this.engine.loadClip(incomingDeck, next.path, next.bpm);
    this.timeline.cancelTag(tag);

    // 1. Incoming deck: start filtered, tails only.
    this.engine.setFilterMode(incomingDeck, 'lowpass');
    this.engine.setFx(incomingDeck, FxParam.FilterCutoff, 0.18);
    this.engine.setDeckGain(incomingDeck, 0);
    this.timeline.schedule(`${tag}:start`, now + 30, () => {
      this.engine.triggerPad(incomingDeck, 0, 0.85);
      this.engine.setDeckGain(incomingDeck, 0.9);
    }, tag);

    // 2. Crossfader + filter sweep across the whole transition.
    this.timeline.ramp(`${tag}:fade`, totalMs * 0.85, 24, (progress) => {
      this.engine.setCrossfader(progress);
      this.engine.setFx(outgoingDeck, FxParam.FilterCutoff, 1 - progress * 0.55);
      this.engine.setFx(incomingDeck, FxParam.FilterCutoff, 0.18 + progress * 0.82);
    }, now + 30, tag);

    // 3. Stem swap at the halfway point: drop the outgoing drums, then bass.
    this.timeline.schedule(`${tag}:stems`, now + totalMs * 0.5, () => {
      this.engine.setStemGain(outgoingDeck, 'drums', 0);
      this.engine.setStemGain(outgoingDeck, 'bass', 0.25);
    }, tag);

    // 4. Tempo glide so the incoming beat settles on the new BPM.
    const targetBpm = next.bpm;
    const startBpm = this.current?.bpm ?? this.engine.currentBpm;
    this.timeline.ramp(`${tag}:bpm`, totalMs * 0.7, 16, (progress) => {
      this.engine.setBpm(startBpm + (targetBpm - startBpm) * progress);
    }, now + 30, tag);

    // 5. Land it: stop the outgoing deck, open the incoming filter fully.
    this.timeline.schedule(`${tag}:land`, now + totalMs, () => {
      this.engine.setFx(incomingDeck, FxParam.FilterCutoff, 1);
      this.engine.stopDeck(outgoingDeck);
      this.engine.setCrossfader(0);
      this.engine.setBpm(targetBpm);
      this.activeDeck = incomingDeck;
      this.current = next;
      this.energy = next.energy;
      this.transitionRunning = false;
      this.lastAction = `Übergeben: ${next.title} · ${next.key.camelot}`;
      this.paintControlLeds();
      void this.publishStatus();
    }, tag);

    void this.publishStatus();
  }

  /** Abort whatever the agent scheduled, leaving audio where it is. */
  abortTransition(): void {
    this.timeline.cancelTag('transition');
    for (const deck of [0, 1, 2, 3] as DeckId[]) this.timeline.cancelTag(`transition:${deck}`);
    this.transitionRunning = false;
    this.lastAction = 'Transition abgebrochen';
    void this.publishStatus();
  }

  /**
   * Autonomous co-pilot loop. Called on every agent tick; decisions are cheap
   * and reversible, and a human touch always wins over the agent.
   */
  private maybeActAutonomously(): void {
    if (!this.coPilot || this.transitionRunning) return;
    if (this.midi.msSinceLastHit < 8_000) return; // human is on the surface
    if (!this.suggestion || this.suggestion.score < 0.62) return;

    const beatsToBar = 4 - (this.engine.transportBeats % 4);
    if (beatsToBar > 0.25) return; // only launch on a bar line

    if (this.suggestion.score >= 0.8 || this.options.autonomy > 0.7) {
      this.performTransition(this.suggestion.track);
    } else {
      this.lastAction = `Vorschlag: ${this.suggestion.track.title} (${this.suggestion.reason})`;
    }
  }

  // ── analysis ─────────────────────────────────────────────────────────────

  /** Feed a chroma vector from the engine's analyser; returns and stores the key. */
  analyseChroma(chroma: number[]): MusicalKey | null {
    const estimate = estimateKey(chroma);
    if (!estimate || estimate.confidence < 0.45) return null;
    if (this.current) {
      this.current = { ...this.current, key: makeKey(estimate.root, estimate.mode) };
    }
    return estimate;
  }

  /** Next key moves for the UI's "harmonic next" chips. */
  harmonicOptions(): { key: MusicalKey; score: number; reason: string }[] {
    return nextKeyCandidates(this.current?.key ?? EMPTY_KEY);
  }

  // ── mesh swarm ───────────────────────────────────────────────────────────

  async attachMesh(transport: MeshTransport, selfId: string): Promise<void> {
    this.clockSync.setSelfId(selfId);
    await this.clockSync.attach(transport);
    this.clockSync.start();
    this.lastAction = 'Mesh verbunden';
    void this.publishStatus();
  }

  get mesh(): MeshClockSync {
    return this.clockSync;
  }

  /** Share the current preset/bpm/key with the swarm. */
  broadcastPreset(): void {
    const transport = this.clockSync.mesh;
    if (!transport || !this.current) return;
    void transport.send({
      topic: 'preset',
      from: this.clockSync.masterId(),
      to: '*',
      clock: this.clockSync.syncedNow(),
      payload: {
        bpm: this.engine.currentBpm,
        key: this.current.key.camelot,
        trackId: this.current.id,
        stems: this.current.stems ?? null,
      },
    });
    this.lastAction = 'Preset an Mesh gesendet';
  }

  // ── surface feedback ─────────────────────────────────────────────────────

  private noteHumanActivity(): void {
    if (this.coPilot) this.lastAction = 'Manuell übernommen, Agent pausiert';
  }

  private handleControl(area: 'top' | 'right', index: number): void {
    if (area === 'top') {
      if (index === 7) {
        this.coPilot = !this.coPilot;
        this.lastAction = this.coPilot ? 'Co-Pilot aktiv' : 'Co-Pilot aus';
        this.paintControlLeds();
      } else if (index === 6) {
        this.performTransition();
      } else if (index < 4) {
        this.activeDeck = index as DeckId;
        this.lastAction = `Deck ${index + 1} aktiv`;
      }
    } else if (index === 7) {
      this.broadcastPreset();
    }
    void this.publishStatus();
  }

  /** Side strips: deck indicators on the top row, state column on the right. */
  private paintControlLeds(): void {
    for (let i = 0; i < 4; i += 1) {
      const isActive = i === this.activeDeck;
      const led: PadLed = isActive
        ? { ...aura.pad.playing, mode: 'static' }
        : { ...aura.pad.idle };
      this.midi.setControl('top', i, led);
    }
    this.midi.setControl('top', 6, { ...aura.pad.queued, mode: this.transitionRunning ? 'pulse' : 'static' });
    this.midi.setControl('top', 7, { ...aura.pad.agent, mode: this.coPilot ? 'pulse' : 'static' });
    this.midi.setControl('right', 7, {
      ...(this.clockSync.getPeers().length > 0 ? aura.pad.agent : aura.pad.idle),
    });
    this.midi.flush();
  }

  // ── status ───────────────────────────────────────────────────────────────

  getStatus(): AgentStatus {
    const peers = this.clockSync.getPeers();
    return {
      running: this.running,
      coPilot: this.coPilot,
      meshSynced: peers.length > 0,
      meshPeers: peers.length,
      masterId: this.clockSync.masterId(),
      clockQualityMs: peers.length > 0 ? Math.min(...peers.map((p) => p.rttMs)) : 0,
      activeDeck: this.activeDeck,
      bpm: this.engine.currentBpm,
      key: this.current?.key ?? null,
      energy: this.energy,
      suggestion: this.suggestion,
      transitionRunning: this.transitionRunning,
      lastAction: this.lastAction,
    };
  }

  onStatus(listener: (status: AgentStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  setCoPilot(enabled: boolean): void {
    this.coPilot = enabled;
    this.lastAction = enabled ? 'Co-Pilot aktiv' : 'Co-Pilot aus';
    this.paintControlLeds();
    void this.publishStatus();
  }

  isCoPilot(): boolean {
    return this.coPilot;
  }

  private async publishStatus(): Promise<void> {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }

  /** Ticked by the UI (or by the 500 ms status loop) to keep the agent alive. */
  tick(): void {
    this.maybeActAutonomously();
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
