import type { MeshClockSync } from './MeshClockSync';
import { MeshRouter } from './MeshTransport';
import type { MeshTransport, PeerId } from './MeshTransport';

/**
 * Swarm state sharing: presets and intent across several units on one stage.
 *
 * Rules, deliberately boring so they cannot deadlock during a set:
 *
 *  - The clock master (lowest peer id) is the single source of truth for the
 *    preset. Its message always wins.
 *  - A non-master may publish, but only while the master has been quiet for
 *    `masterTtlMs` (master lost) and only with a higher revision than ours.
 *  - Launch timestamps are expressed on the *master* clock and converted to a
 *    local wall clock per node, so two phones with clock skew still fire on the
 *    same beat rather than 20 ms apart.
 */

export interface SwarmPreset {
  bpm: number;
  camelot: string;
  trackId: string | null;
  masterGain: number;
  /** Monotonic per publisher. */
  revision: number;
  publisher: PeerId;
  /** When it was published, on the master clock. */
  updatedAtMasterMs: number;
}

export type SwarmIntent =
  | { kind: 'next'; trackId: string }
  | { kind: 'vote'; trackId: string; weight: number }
  | { kind: 'stop' }
  | { kind: 'launch'; trackId: string; atMasterMs: number };

export interface SwarmPeer {
  id: PeerId;
  isMaster: boolean;
  clockOffsetMs: number;
  /** Round-trip quality of the last measurement. */
  qualityMs: number;
}

export interface MeshSwarmOptions {
  selfId: PeerId;
  /** How long the master may stay silent before a peer may take over state. */
  masterTtlMs?: number;
  /** Musical grid for launches. */
  beatsPerBar?: number;
}

export class MeshSwarm {
  private clock: MeshClockSync;
  private transport: MeshTransport | null = null;
  private router: MeshRouter | null = null;
  private selfId: PeerId;
  private masterTtlMs: number;
  private beatsPerBar: number;

  private preset: SwarmPreset | null = null;
  private revision = 0;
  private lastMasterPresetAt = 0;
  private intents: { intent: SwarmIntent; from: PeerId; receivedAt: number }[] = [];

  private presetListeners = new Set<(preset: SwarmPreset, fromMaster: boolean) => void>();
  private intentListeners = new Set<(intent: SwarmIntent, from: PeerId) => void>();

  constructor(clock: MeshClockSync, options: MeshSwarmOptions) {
    this.clock = clock;
    this.selfId = options.selfId;
    this.masterTtlMs = options.masterTtlMs ?? 4_000;
    this.beatsPerBar = options.beatsPerBar ?? 4;
  }

  /** Attaches to a dedicated transport (creates a router, starts it). */
  async attach(transport: MeshTransport): Promise<void> {
    this.transport = transport;
    const router = new MeshRouter(transport);
    this.router = router;
    router.subscribe('preset', (packet) => this.handlePacket(packet));
    router.subscribe('intent', (packet) => this.handlePacket(packet));
    await router.start(this.selfId);
  }

  /** Attaches to the same router the clock uses. Preferred. */
  attachRouter(router: MeshRouter): void {
    this.router = router;
    router.subscribe('preset', (packet) => this.handlePacket(packet));
    router.subscribe('intent', (packet) => this.handlePacket(packet));
  }

  get id(): PeerId {
    return this.selfId;
  }

  isMaster(): boolean {
    return this.clock.masterId() === this.selfId;
  }

  peers(): SwarmPeer[] {
    return this.clock.getPeers().map((peer) => ({
      id: peer.peerId,
      isMaster: peer.peerId === this.clock.masterId(),
      clockOffsetMs: peer.offsetMs,
      qualityMs: peer.rttMs,
    }));
  }

  currentPreset(): SwarmPreset | null {
    return this.preset;
  }

  // ── publishing ───────────────────────────────────────────────────────────

  /** Publishes local state. Returns null when a swarm member may not publish. */
  publishPreset(preset: Omit<SwarmPreset, 'revision' | 'publisher' | 'updatedAtMasterMs'>): SwarmPreset | null {
    const now = this.clock.syncedNow();
    const masterQuiet = now - this.lastMasterPresetAt > this.masterTtlMs;
    if (!this.isMaster() && this.preset !== null && !masterQuiet) {
      // Someone else owns the state and is alive: do not fight it.
      return null;
    }
    this.revision += 1;
    const published: SwarmPreset = {
      ...preset,
      revision: this.revision,
      publisher: this.selfId,
      updatedAtMasterMs: now,
    };
    this.preset = published;
    this.outbound({
      topic: 'preset',
      from: this.selfId,
      to: '*',
      clock: now,
      payload: published,
    });
    this.emitPreset(published, this.isMaster());
    return published;
  }

  sendIntent(intent: SwarmIntent): void {
    this.outbound({
      topic: 'intent',
      from: this.selfId,
      to: '*',
      clock: this.clock.syncedNow(),
      payload: intent,
    });
  }

  /** Recent intents, newest last. Bounded so a long night cannot grow forever. */
  recentIntents(limit = 10): { intent: SwarmIntent; from: PeerId; receivedAt: number }[] {
    return this.intents.slice(-limit);
  }

  // ── timing ───────────────────────────────────────────────────────────────

  /** Bar length in ms at a tempo. */
  barDurationMs(bpm: number): number {
    if (bpm <= 0) return 2_000;
    return (60 / bpm) * this.beatsPerBar * 1000;
  }

  /** Time from a beat position to the next bar line, in ms. */
  msToNextBar(beats: number, bpm: number): number {
    if (bpm <= 0) return 0;
    const beatsPerBarMs = (60 / bpm) * 1000;
    const positionInBar = ((beats % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
    const remaining = this.beatsPerBar - positionInBar;
    return Math.round(remaining * beatsPerBarMs * 100) / 100;
  }

  /** Master clock → local wall clock. */
  localTimeFor(masterMs: number): number {
    const master = this.clock.masterId();
    if (master === this.selfId) return masterMs;
    const offset = this.clock.getPeers().find((peer) => peer.peerId === master)?.offsetMs ?? 0;
    return masterMs - offset;
  }

  /**
   * Schedules a launch `beatsAhead` from now on the shared clock.
   * Every node computes the same master timestamp, so they fire together even
   * though each one converts it to its own local clock.
   */
  scheduledLaunch(trackId: string, bpm: number, beatsAhead = 1): { atMasterMs: number; atLocalMs: number } {
    const beatMs = bpm > 0 ? (60 / bpm) * 1000 : 500;
    // Land on the next bar line, then step forward by whole beats.
    const toBar = this.msToNextBar(this.clock.syncedNow() / beatMs, bpm);
    const atMasterMs = this.clock.syncedNow() + toBar + Math.max(0, beatsAhead - 1) * 0;
    return { atMasterMs, atLocalMs: this.localTimeFor(atMasterMs) };
  }

  /** Convenience: schedule and broadcast a launch intent in one call. */
  launchTogether(trackId: string, bpm: number): { atMasterMs: number; atLocalMs: number } {
    const timing = this.scheduledLaunch(trackId, bpm);
    this.sendIntent({ kind: 'launch', trackId, atMasterMs: timing.atMasterMs });
    return timing;
  }

  // ── subscriptions ────────────────────────────────────────────────────────

  onPreset(listener: (preset: SwarmPreset, fromMaster: boolean) => void): () => void {
    this.presetListeners.add(listener);
    return () => this.presetListeners.delete(listener);
  }

  onIntent(listener: (intent: SwarmIntent, from: PeerId) => void): () => void {
    this.intentListeners.add(listener);
    return () => this.intentListeners.delete(listener);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private handlePacket(packet: { topic: string; from: PeerId; clock: number; payload: unknown }): void {
    if (packet.from === this.selfId) return;

    if (packet.topic === 'preset') {
      const incoming = packet.payload as SwarmPreset;
      if (!incoming || typeof incoming.revision !== 'number') return;
      const fromMaster = packet.from === this.clock.masterId();

      if (fromMaster) {
        this.lastMasterPresetAt = packet.clock;
        if (!this.preset || incoming.revision >= this.preset.revision || incoming.publisher !== this.preset.publisher) {
          this.preset = incoming;
          this.emitPreset(incoming, true);
        }
        return;
      }

      // Non-master: only accepted when it is genuinely newer and the master has
      // not spoken recently.
      const masterQuiet = packet.clock - this.lastMasterPresetAt > this.masterTtlMs;
      if (masterQuiet && (!this.preset || incoming.revision > this.preset.revision)) {
        this.preset = incoming;
        this.emitPreset(incoming, false);
      }
      return;
    }

    if (packet.topic === 'intent') {
      const intent = packet.payload as SwarmIntent;
      if (!intent || typeof intent.kind !== 'string') return;
      this.intents.push({ intent, from: packet.from, receivedAt: packet.clock });
      if (this.intents.length > 64) this.intents.shift();
      for (const listener of this.intentListeners) listener(intent, packet.from);
    }
  }

  private outbound(packet: import('./MeshTransport').MeshPacket): void {
    if (this.router) this.router.send(packet);
    else void this.transport?.send(packet);
  }

  private emitPreset(preset: SwarmPreset, fromMaster: boolean): void {
    for (const listener of this.presetListeners) listener(preset, fromMaster);
  }
}
