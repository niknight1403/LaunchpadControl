/**
 * Transport abstraction for the P2P swarm.
 *
 * The protocol in `MeshClockSync.ts` only needs three things: a broadcast, a
 * unicast, and an id. That keeps the audio side of the swarm independent of
 * whether packets travel over UDP (react-native-udp, LAN multicast) or WebRTC
 * data channels (react-native-webrtc, works across NAT).
 *
 * No server is involved: peers find each other, elect a clock master and share
 * presets over the same channel.
 */

export type PeerId = string;

export interface MeshPacket {
  /** Logical channel: clock sync, preset sharing, agent intent. */
  topic: 'clock' | 'preset' | 'intent';
  from: PeerId;
  /** Target peer, or '*' for broadcast. */
  to: PeerId | '*';
  /** Monotonic ms on the sender's clock. */
  clock: number;
  payload: unknown;
}

export interface MeshTransport {
  start(selfId: PeerId, onPacket: (packet: MeshPacket) => void): Promise<void>;
  stop(): Promise<void>;
  send(packet: MeshPacket): void | Promise<void>;
  peers(): PeerId[];
}

/**
 * In-process transport with two virtual peers.
 * Used by the agent's self-test and by the desktop simulator.
 */
export class LoopbackMeshTransport implements MeshTransport {
  private selfId: PeerId = 'local';
  private handler: ((packet: MeshPacket) => void) | null = null;
  private peerList: PeerId[] = [];
  private readonly latencyMs: number;

  constructor(options: { peers?: PeerId[]; latencyMs?: number } = {}) {
    this.peerList = options.peers ?? ['peer-a'];
    this.latencyMs = options.latencyMs ?? 3;
  }

  async start(selfId: PeerId, onPacket: (packet: MeshPacket) => void): Promise<void> {
    this.selfId = selfId;
    this.handler = onPacket;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  peers(): PeerId[] {
    return [...this.peerList];
  }

  /**
   * Simulates the peer answering a clock ping with its own clock, offset by
   * `latencyMs` one way. Enough to validate the offset maths end to end.
   */
  send(packet: MeshPacket): void {
    if (packet.topic !== 'clock') return;
    const payload = packet.payload as { kind?: string; t0?: number } | undefined;
    if (payload?.kind !== 'ping' || !this.handler) return;
    const offset = 7; // simulated clock skew of the remote peer
    const replyDelay = this.latencyMs * 2;
    setTimeout(() => {
      this.handler?.({
        topic: 'clock',
        from: packet.to === '*' ? (this.peerList[0] ?? 'peer-a') : packet.to,
        to: this.selfId,
        clock: (payload.t0 ?? 0) + offset + replyDelay,
        payload: { kind: 'pong', t0: payload.t0 ?? 0, offset },
      });
    }, replyDelay);
  }
}

/**
 * Topic router: lets several subsystems share one transport.
 *
 * The clock sync and the swarm both need inbound packets. Without a router the
 * second `start()` call steals the first one's handler — a bug that only shows up
 * with two nodes and looks like "the mesh just does not work".
 */
export class MeshRouter {
  private transport: MeshTransport;
  private subs = new Map<MeshPacket['topic'], Set<(packet: MeshPacket) => void>>();
  private started = false;
  private selfId: PeerId = 'local';

  constructor(transport: MeshTransport) {
    this.transport = transport;
  }

  async start(selfId: PeerId): Promise<void> {
    this.selfId = selfId;
    if (this.started) return;
    await this.transport.start(selfId, (packet) => this.dispatch(packet));
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.transport.stop();
    this.started = false;
    this.subs.clear();
  }

  subscribe(topic: MeshPacket['topic'], handler: (packet: MeshPacket) => void): () => void {
    const set = this.subs.get(topic) ?? new Set();
    set.add(handler);
    this.subs.set(topic, set);
    return () => set.delete(handler);
  }

  send(packet: MeshPacket): void {
    void this.transport.send(packet);
  }

  peers(): PeerId[] {
    return this.transport.peers();
  }

  get id(): PeerId {
    return this.selfId;
  }

  get isStarted(): boolean {
    return this.started;
  }

  private dispatch(packet: MeshPacket): void {
    const handlers = this.subs.get(packet.topic);
    if (!handlers) return;
    for (const handler of handlers) handler(packet);
  }
}

/**
 * In-process message bus: connects several transports so a multi-node swarm can
 * be exercised on one machine.
 *
 * This is what the mesh tests run on, and it is genuinely useful on stage during
 * a soundcheck: two phones, same protocol, no network between them yet.
 */
export class MeshBus {
  private handlers = new Map<PeerId, (packet: MeshPacket) => void>();

  register(id: PeerId, handler: (packet: MeshPacket) => void): void {
    this.handlers.set(id, handler);
  }

  unregister(id: PeerId): void {
    this.handlers.delete(id);
  }

  ids(): PeerId[] {
    return [...this.handlers.keys()];
  }

  /** Delivers to the addressed peer, or to everyone except the sender. */
  route(packet: MeshPacket): number {
    let delivered = 0;
    if (packet.to === '*') {
      for (const [id, handler] of this.handlers) {
        if (id === packet.from) continue;
        handler(packet);
        delivered += 1;
      }
      return delivered;
    }
    const handler = this.handlers.get(packet.to);
    if (handler && packet.to !== packet.from) {
      handler(packet);
      delivered = 1;
    }
    return delivered;
  }
}

/** A transport bound to one id on a `MeshBus`. */
export class BusTransport implements MeshTransport {
  private bus: MeshBus;
  private selfId: PeerId = 'node';
  private handler: ((packet: MeshPacket) => void) | null = null;

  constructor(bus: MeshBus) {
    this.bus = bus;
  }

  async start(selfId: PeerId, onPacket: (packet: MeshPacket) => void): Promise<void> {
    this.selfId = selfId;
    this.handler = onPacket;
    this.bus.register(selfId, onPacket);
  }

  async stop(): Promise<void> {
    this.bus.unregister(this.selfId);
    this.handler = null;
  }

  peers(): PeerId[] {
    return this.bus.ids().filter((id) => id !== this.selfId);
  }

  send(packet: MeshPacket): void {
    this.bus.route({ ...packet, from: this.selfId });
  }

  get id(): PeerId {
    return this.selfId;
  }

  get hasHandler(): boolean {
    return this.handler !== null;
  }
}
