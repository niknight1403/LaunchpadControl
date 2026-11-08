import type { MeshPacket, MeshTransport, PeerId } from './MeshTransport';

/**
 * UDP mesh transport: the swarm over a real network.
 *
 * `MeshBus` proves the protocol; this carries it between two phones on a club
 * Wi-Fi (or a phone's hotspot, which is the sane setup). The design keeps the
 * socket behind a tiny interface so the framing, dedupe and peer bookkeeping are
 * testable without opening a port.
 *
 * Packets are length-prefixed JSON with a magic and a version. A wrong-version or
 * truncated datagram is dropped and counted, never thrown: on a busy network a
 * listener gets junk from other apps on the same port.
 */

export const MESH_MAGIC = 0x4147_5244; // "AGRD", all four bytes used
export const MESH_VERSION = 1;
const HEADER_BYTES = 12;

export interface UdpSocketLike {
  bind(port: number, onMessage: (data: Uint8Array, from: PeerId) => void): void;
  send(data: Uint8Array, port: number, address: string): void;
  close(): void;
}

export interface MeshEnvelope {
  version: number;
  seq: number;
  packet: MeshPacket;
}

export interface UdpTransportOptions {
  port?: number;
  /** Peers to broadcast to. Empty means "wait for inbound traffic". */
  peers?: { id: PeerId; address: string; port: number }[];
  /** Datagrams larger than this are refused before they are sent. */
  maxPacketBytes?: number;
}

export interface TransportStats {
  sent: number;
  received: number;
  droppedMalformed: number;
  droppedDuplicate: number;
  droppedTooLarge: number;
}

/** Encodes a packet into a datagram: magic, version, length, sequence, json. */
export function encodeDatagram(packet: MeshPacket, sequence: number): Uint8Array {
  const payload = JSON.stringify(packet);
  const bytes = new TextEncoder().encode(payload);
  const buffer = new Uint8Array(HEADER_BYTES + bytes.length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, MESH_MAGIC, false);
  view.setUint8(4, MESH_VERSION);
  view.setUint8(5, 0); // reserved
  view.setUint16(6, bytes.length, false);
  view.setUint32(8, sequence, false);
  buffer.set(bytes, HEADER_BYTES);
  return buffer;
}

export interface DecodeResult {
  ok: boolean;
  reason?: string;
  envelope?: MeshEnvelope;
}

/** Decodes a datagram, reporting why it was refused. */
export function decodeDatagram(data: Uint8Array): DecodeResult {
  if (data.length < HEADER_BYTES) return { ok: false, reason: 'too short' };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, false) !== MESH_MAGIC) return { ok: false, reason: 'bad magic' };
  const version = view.getUint8(4);
  if (version !== MESH_VERSION) return { ok: false, reason: `version ${version}` };
  const length = view.getUint16(6, false);
  if (HEADER_BYTES + length > data.length) return { ok: false, reason: 'truncated payload' };
  const sequence = view.getUint32(8, false);
  const payload = data.subarray(HEADER_BYTES, HEADER_BYTES + length);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as MeshPacket;
    if (!parsed || typeof parsed.topic !== 'string' || typeof parsed.from !== 'string') {
      return { ok: false, reason: 'payload is not a mesh packet' };
    }
    return { ok: true, envelope: { version, seq: sequence, packet: parsed } };
  } catch {
    return { ok: false, reason: 'payload is not json' };
  }
}

export class UdpMeshTransport implements MeshTransport {
  private socket: UdpSocketLike;
  private options: Required<Pick<UdpTransportOptions, 'port' | 'maxPacketBytes'>> & UdpTransportOptions;
  private handler: ((packet: MeshPacket) => void) | null = null;
  private selfId: PeerId = 'local';
  private peerList: { id: PeerId; address: string; port: number }[] = [];
  private sequence = 0;
  private seen = new Map<string, number>();
  private counters: TransportStats = { sent: 0, received: 0, droppedMalformed: 0, droppedDuplicate: 0, droppedTooLarge: 0 };

  constructor(socket: UdpSocketLike, options: UdpTransportOptions = {}) {
    this.socket = socket;
    this.options = { port: options.port ?? 41_000, maxPacketBytes: options.maxPacketBytes ?? 1_200, ...options };
    this.peerList = options.peers ?? [];
  }

  get stats(): TransportStats {
    return { ...this.counters };
  }

  async start(selfId: PeerId, onPacket: (packet: MeshPacket) => void): Promise<void> {
    this.selfId = selfId;
    this.handler = onPacket;
    this.socket.bind(this.options.port, (data, from) => this.handleDatagram(data, from));
  }

  async stop(): Promise<void> {
    this.handler = null;
    this.socket.close();
  }

  peers(): PeerId[] {
    return this.peerList.map((peer) => peer.id).filter((id) => id !== this.selfId);
  }

  /** Learns a peer from inbound traffic: no discovery protocol needed on a LAN. */
  addPeer(id: PeerId, address: string, port = this.options.port): void {
    if (id === this.selfId) return;
    if (this.peerList.some((peer) => peer.id === id)) return;
    this.peerList = [...this.peerList, { id, address, port }];
  }

  send(packet: MeshPacket): void {
    this.sequence += 1;
    const datagram = encodeDatagram(packet, this.sequence);
    if (datagram.length > this.options.maxPacketBytes) {
      // Large preset payloads must be split by the caller; silently fragmenting
      // would make a 1500-byte packet vanish on some links only.
      this.counters.droppedTooLarge += 1;
      return;
    }
    const targets = packet.to === '*' ? this.peerList : this.peerList.filter((peer) => peer.id === packet.to);
    for (const target of targets) {
      this.socket.send(datagram, target.port, target.address);
      this.counters.sent += 1;
    }
  }

  private handleDatagram(data: Uint8Array, from: PeerId): void {
    this.counters.received += 1;
    const decoded = decodeDatagram(data);
    if (!decoded.ok || !decoded.envelope) {
      this.counters.droppedMalformed += 1;
      return;
    }
    const { seq, packet } = decoded.envelope;

    // Wi-Fi multicast and rebroadcasts deliver duplicates; a repeated "stop" is
    // harmless, a repeated launch is not.
    const key = `${packet.from}:${seq}`;
    const previous = this.seen.get(key);
    if (previous !== undefined) {
      this.counters.droppedDuplicate += 1;
      return;
    }
    this.seen.set(key, 1);
    if (this.seen.size > 512) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    if (from !== packet.from) this.addPeer(packet.from, from);
    this.handler?.(packet);
  }
}

/** Socket stand-in for the tests and the desktop simulator. */
export class FakeUdpSocket implements UdpSocketLike {
  private handler: ((data: Uint8Array, from: PeerId) => void) | null = null;
  readonly sent: { data: Uint8Array; port: number; address: string }[] = [];
  closed = false;
  boundPort: number | null = null;

  bind(port: number, onMessage: (data: Uint8Array, from: PeerId) => void): void {
    this.boundPort = port;
    this.handler = onMessage;
  }

  send(data: Uint8Array, port: number, address: string): void {
    this.sent.push({ data, port, address });
  }

  close(): void {
    this.closed = true;
    this.handler = null;
  }

  /** Simulates an inbound datagram. */
  deliver(data: Uint8Array, from: PeerId): void {
    this.handler?.(data, from);
  }

  get isBound(): boolean {
    return this.handler !== null;
  }
}
