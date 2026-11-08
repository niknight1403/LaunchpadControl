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
