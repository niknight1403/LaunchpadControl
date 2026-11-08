import { MeshClockSync } from '../../src/agent/MeshClockSync';
import { LoopbackMeshTransport } from '../../src/agent/MeshTransport';
import { check, section, sleep } from './harness';

export async function run(): Promise<void> {
  section('Mesh clock sync');
  const transport = new LoopbackMeshTransport({ peers: ['peer-a'], latencyMs: 4 });
  const sync = new MeshClockSync({ pingIntervalMs: 40 });
  sync.setSelfId('local');
  await sync.attach(transport);
  sync.start(['peer-a']);
  await sleep(150);
  sync.stop();

  const peers = sync.getPeers();
  check('a peer was measured', peers.length === 1, `peers=${peers.length}`);
  check('round trip measured in ms', (peers[0]?.rttMs ?? -1) >= 0);
  check('local node is master (lowest id)', sync.masterId() === 'local', sync.masterId());
  check('synced clock is finite', Number.isFinite(sync.syncedNow()));
}
