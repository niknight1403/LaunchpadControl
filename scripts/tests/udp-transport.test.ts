import {
  FakeUdpSocket,
  MESH_MAGIC,
  MESH_VERSION,
  UdpMeshTransport,
  decodeDatagram,
  encodeDatagram,
} from '../../src/agent/UdpTransport';
import type { MeshPacket } from '../../src/agent/MeshTransport';
import { check, near, section } from './harness';

const packet = (overrides: Partial<MeshPacket> = {}): MeshPacket => ({
  topic: 'preset',
  from: 'a',
  to: '*',
  clock: 1_000,
  payload: { bpm: 128, camelot: '8A' },
  ...overrides,
});

export async function run(): Promise<void> {
  section('UDP mesh: framing');
  const datagram = encodeDatagram(packet(), 7);
  check('a datagram has a header plus payload', datagram.length > 12);
  const decoded = decodeDatagram(datagram);
  check('a valid datagram decodes', decoded.ok);
  check('the sequence survives', decoded.envelope?.seq === 7);
  check('the version is stamped', decoded.envelope?.version === MESH_VERSION);
  check('the packet survives intact', (decoded.envelope?.packet.payload as { bpm: number }).bpm === 128);
  check('the topic survives', decoded.envelope?.packet.topic === 'preset');

  section('UDP mesh: rejecting junk');
  check('an empty datagram is refused', !decodeDatagram(new Uint8Array(0)).ok);
  check('a short datagram is refused', !decodeDatagram(new Uint8Array(8)).ok);
  const wrongMagic = encodeDatagram(packet(), 1);
  wrongMagic[0] = 0;
  check('a foreign magic is refused', decodeDatagram(wrongMagic).reason === 'bad magic');
  const wrongVersion = encodeDatagram(packet(), 1);
  wrongVersion[4] = 99;
  check('a different version is refused', (decodeDatagram(wrongVersion).reason ?? '').includes('version'));
  const truncated = encodeDatagram(packet(), 1).slice(0, 14);
  check('a truncated payload is refused', (decodeDatagram(truncated).reason ?? '').includes('truncated'));
  const badJson = new Uint8Array(12 + 5);
  const view = new DataView(badJson.buffer);
  view.setUint32(0, MESH_MAGIC, false);
  view.setUint8(4, MESH_VERSION);
  view.setUint16(6, 5, false);
  badJson.set([0x7b, 0x7b, 0x7b, 0x7b, 0x7b], 12); // '{{{{{'
  check('broken json is refused', decodeDatagram(badJson).reason === 'payload is not json');
  const notAPacket = new Uint8Array(12 + 2);
  new DataView(notAPacket.buffer).setUint32(0, MESH_MAGIC, false);
  new DataView(notAPacket.buffer).setUint8(4, MESH_VERSION);
  new DataView(notAPacket.buffer).setUint16(6, 2, false);
  notAPacket.set([0x7b, 0x7d], 12); // '{}'
  check('valid json that is not a packet is refused', decodeDatagram(notAPacket).reason === 'payload is not a mesh packet');

  section('UDP mesh: transport');
  const socket = new FakeUdpSocket();
  const transport = new UdpMeshTransport(socket, {
    port: 42_000,
    peers: [
      { id: 'b', address: '10.0.0.2', port: 42_000 },
      { id: 'c', address: '10.0.0.3', port: 42_000 },
    ],
  });
  const inbound: MeshPacket[] = [];
  await transport.start('a', (incoming) => inbound.push(incoming));
  check('the socket is bound', socket.isBound && socket.boundPort === 42_000);
  check('peers are listed without self', transport.peers().length === 2 && !transport.peers().includes('a'));

  transport.send(packet());
  check('a broadcast reaches every peer', socket.sent.length === 2, String(socket.sent.length));
  check('the datagram is addressed correctly', socket.sent[0]!.address === '10.0.0.2' && socket.sent[0]!.port === 42_000);
  check('the sent datagram is decodable', decodeDatagram(socket.sent[0]!.data).ok);
  check('sent stats are counted', transport.stats.sent === 2);

  socket.sent.length = 0;
  transport.send(packet({ to: 'b' }));
  check('a unicast reaches one peer', socket.sent.length === 1 && socket.sent[0]!.address === '10.0.0.2');
  transport.send(packet({ to: 'unknown' }));
  check('an unknown target sends nothing', socket.sent.length === 1);

  section('UDP mesh: inbound');
  socket.deliver(encodeDatagram(packet({ from: 'b', payload: { bpm: 124 } }), 1), '10.0.0.2');
  check('a valid packet reaches the handler', inbound.length === 1);
  check('the payload arrives unchanged', (inbound[0]!.payload as { bpm: number }).bpm === 124);
  check('received stats are counted', transport.stats.received === 1);

  socket.deliver(encodeDatagram(packet({ from: 'b' }), 1), '10.0.0.2');
  check('a duplicate sequence is dropped', transport.stats.droppedDuplicate === 1 && inbound.length === 1);
  socket.deliver(encodeDatagram(packet({ from: 'b' }), 2), '10.0.0.2');
  check('a new sequence is not a duplicate', inbound.length === 2);

  socket.deliver(new Uint8Array([1, 2, 3]), '10.0.0.2');
  check('junk from the network is dropped, not thrown', transport.stats.droppedMalformed === 1);

  section('UDP mesh: size limit');
  const big = new UdpMeshTransport(new FakeUdpSocket(), { peers: [{ id: 'b', address: '10.0.0.2', port: 1 }], maxPacketBytes: 200 });
  await big.start('a', () => undefined);
  big.send(packet({ payload: { blob: 'x'.repeat(500) } }));
  check('an oversized packet is refused', big.stats.droppedTooLarge === 1 && big.stats.sent === 0);
  big.send(packet({ payload: { small: 1 } }));
  check('a small packet still goes out', big.stats.sent === 1);

  section('UDP mesh: peer learning');
  const learnerSocket = new FakeUdpSocket();
  const learner = new UdpMeshTransport(learnerSocket, { port: 43_000 });
  await learner.start('a', () => undefined);
  check('a transport can start without peers', learner.peers().length === 0);
  learnerSocket.deliver(encodeDatagram(packet({ from: 'd' }), 5), '10.0.0.9');
  check('a peer is learned from inbound traffic', learner.peers().includes('d'));
  learner.send(packet({ to: 'd' }));
  check('the learned peer is addressable', learnerSocket.sent.length === 1 && learnerSocket.sent[0]!.address === '10.0.0.9');
  learner.addPeer('a', '10.0.0.1');
  check('a transport never adds itself', !learner.peers().includes('a'));
  learner.addPeer('d', '10.0.0.10');
  check('a known peer is not added twice', learner.peers().length === 1);

  section('UDP mesh: shutdown');
  await transport.stop();
  check('stopping unbinds the socket', socket.closed && !socket.isBound);
  const afterStop = inbound.length;
  socket.deliver(encodeDatagram(packet({ from: 'b' }), 55), '10.0.0.2');
  check('no packets after stop', inbound.length === afterStop);
  check('stats are still readable after stop', near(transport.stats.received, 4, 1));
}
