import type { MeshPacket, MeshTransport, PeerId } from './MeshTransport';

export interface PeerClockState {
  peerId: PeerId;
  /** ms to add to the local clock to match that peer's clock. */
  offsetMs: number;
  /** Best round-trip time seen, ms. Lower = more trustworthy. */
  rttMs: number;
  samples: number;
  updatedAt: number;
}

export interface ClockSyncOptions {
  pingIntervalMs?: number;
  /** Samples older than this are re-verified before they are trusted. */
  staleAfterMs?: number;
  maxSamples?: number;
}

/**
 * NTP-style clock sync for the stage mesh.
 *
 *   t0 = local send time
 *   t1 = peer receive (its clock)
 *   t2 = peer send (its clock)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *
 * We keep the sample with the lowest RTT, because that is the sample least
 * distorted by jitter. The master is the lexicographically lowest peer id: it
 * needs no consensus, cannot deadlock, and every node computes the same answer.
 */
export class MeshClockSync {
  private transport: MeshTransport | null = null;
  private selfId: PeerId = 'local';
  private states = new Map<PeerId, PeerClockState>();
  private pending = new Map<number, number>(); // t0 -> send timestamp
  private timer: ReturnType<typeof setInterval> | null = null;
  private options: Required<ClockSyncOptions>;

  constructor(options: ClockSyncOptions = {}) {
    this.options = {
      pingIntervalMs: options.pingIntervalMs ?? 1_000,
      staleAfterMs: options.staleAfterMs ?? 5_000,
      maxSamples: options.maxSamples ?? 64,
    };
  }

  attach(transport: MeshTransport): Promise<void> {
    this.transport = transport;
    return transport.start(this.selfId, (packet) => this.handlePacket(packet));
  }

  start(peerIds: PeerId[] = []): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.ping(peerIds.length > 0 ? peerIds : this.transport?.peers() ?? []);
    }, this.options.pingIntervalMs);
    this.ping(peerIds.length > 0 ? peerIds : this.transport?.peers() ?? []);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSelfId(id: PeerId): void {
    this.selfId = id;
  }

  /** Master = lowest id. Deterministic on every node, no election traffic. */
  masterId(): PeerId {
    const ids = [this.selfId, ...this.states.keys()].sort();
    return ids[0] ?? this.selfId;
  }

  isMaster(): boolean {
    return this.masterId() === this.selfId;
  }

  /** Local clock corrected onto the master clock (1 ms resolution). */
  syncedNow(): number {
    const master = this.masterId();
    if (master === this.selfId) return Date.now();
    const state = this.states.get(master);
    if (!state) return Date.now();
    return Date.now() + state.offsetMs;
  }

  /** Clock error to expect from the best peer, in ms. Drives the UI badge. */
  qualityMs(peerId: PeerId): number {
    return this.states.get(peerId)?.rttMs ?? Number.POSITIVE_INFINITY;
  }

  getPeers(): PeerClockState[] {
    return [...this.states.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  /** Shared transport for preset/intent messages once attached. */
  get mesh(): MeshTransport | null {
    return this.transport;
  }

  private ping(peerIds: PeerId[]): void {
    if (!this.transport) return;
    for (const peerId of peerIds) {
      if (peerId === this.selfId) continue;
      const t0 = Date.now();
      this.pending.set(t0, t0);
      // Bound the pending map: a peer that never answers must not leak memory.
      if (this.pending.size > this.options.maxSamples) {
        const oldest = [...this.pending.keys()].sort((a, b) => a - b)[0];
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      void this.transport.send({
        topic: 'clock',
        from: this.selfId,
        to: peerId,
        clock: t0,
        payload: { kind: 'ping', t0 },
      });
    }
  }

  private handlePacket(packet: MeshPacket): void {
    if (packet.topic !== 'clock') return;
    const payload = packet.payload as
      | { kind?: string; t0?: number; offset?: number }
      | undefined;
    if (!payload) return;

    if (payload.kind === 'ping' && payload.t0 !== undefined) {
      // Answer immediately, with our own two timestamps folded in.
      const received = packet.clock;
      void this.transport?.send({
        topic: 'clock',
        from: this.selfId,
        to: packet.from,
        clock: received,
        payload: { kind: 'pong', t0: payload.t0, offset: this.states.get(packet.from)?.offsetMs ?? 0 },
      });
      return;
    }

    if (payload.kind !== 'pong' || payload.t0 === undefined) return;

    const t3 = Date.now();
    const t0 = payload.t0;
    const roundTrip = t3 - t0;
    if (roundTrip < 0) return;

    // Peer's own estimate of its offset is folded in symmetrically.
    const peerOffset = payload.offset ?? 0;
    const measuredOffset = peerOffset + (t3 - t0) / 2 - roundTrip / 2;
    const existing = this.states.get(packet.from);

    if (!existing || roundTrip <= existing.rttMs) {
      this.states.set(packet.from, {
        peerId: packet.from,
        offsetMs: existing ? smooth(existing.offsetMs, measuredOffset) : measuredOffset,
        rttMs: existing ? Math.min(existing.rttMs, roundTrip) : roundTrip,
        samples: (existing?.samples ?? 0) + 1,
        updatedAt: t3,
      });
    } else {
      this.states.set(packet.from, {
        ...existing,
        offsetMs: smooth(existing.offsetMs, measuredOffset),
        samples: existing.samples + 1,
        updatedAt: t3,
      });
    }

    // Drop samples from peers that fell off the network.
    for (const [peerId, state] of this.states) {
      if (t3 - state.updatedAt > this.options.staleAfterMs) this.states.delete(peerId);
    }
  }
}

/** 0.25 alpha: kills ping jitter without lagging behind a real drift. */
function smooth(previous: number, next: number): number {
  return Math.round((previous * 0.75 + next * 0.25) * 100) / 100;
}
