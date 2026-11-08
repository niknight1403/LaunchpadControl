import { MeshClockSync } from '../../src/agent/MeshClockSync';
import { MeshSwarm } from '../../src/agent/MeshSwarm';
import { BusTransport, MeshBus, MeshRouter } from '../../src/agent/MeshTransport';
import { check, near, section } from './harness';

interface Node {
  id: string;
  clock: MeshClockSync;
  swarm: MeshSwarm;
  transport: BusTransport;
  router: MeshRouter;
  presets: number;
  intents: { kind: string; from: string }[];
}

async function buildNode(bus: MeshBus, id: string): Promise<Node> {
  // Short intervals: the test wants master loss detected in ~100 ms, not 5 s.
  const clock = new MeshClockSync({ pingIntervalMs: 25, staleAfterMs: 90 });
  clock.setSelfId(id);
  const transport = new BusTransport(bus);
  // One router, two subscribers: the clock measures peers, the swarm carries
  // state over the same wire. Attaching both directly would let the second
  // subscriber steal the first one's packets.
  const router = new MeshRouter(transport);
  await router.start(id);
  clock.attachRouter(router);
  clock.start();
  const swarm = new MeshSwarm(clock, { selfId: id, masterTtlMs: 120 });
  swarm.attachRouter(router);
  const node: Node = { id, clock, swarm, transport, router, presets: 0, intents: [] };
  swarm.onPreset(() => {
    node.presets += 1;
  });
  swarm.onIntent((intent, from) => {
    node.intents.push({ kind: intent.kind, from });
  });
  return node;
}

export async function run(): Promise<void> {
  section('Mesh swarm: timing maths');
  const soloClock = new MeshClockSync();
  soloClock.setSelfId('solo');
  const solo = new MeshSwarm(soloClock, { selfId: 'solo' });

  check('a bar at 128 BPM is 1875 ms', near(solo.barDurationMs(128), 1875, 0.01), String(solo.barDurationMs(128)));
  check('a bar at 60 BPM is 4000 ms', near(solo.barDurationMs(60), 4000, 0.01));
  check('beat 0 waits a full bar', near(solo.msToNextBar(0, 120), 2000, 0.01));
  check('beat 1 waits three beats', near(solo.msToNextBar(1, 120), 1500, 0.01));
  check('beat 3.5 waits half a beat', near(solo.msToNextBar(3.5, 120), 250, 0.01));
  check('beat 4 lands exactly on the bar', near(solo.msToNextBar(4, 120), 2000, 0.01));
  // -1 beat is beat 3 of the bar, i.e. one beat from the next bar line.
  check('negative beats wrap correctly', near(solo.msToNextBar(-1, 120), 500, 0.01));

  section('Mesh swarm: two nodes over a bus');
  const bus = new MeshBus();
  const nodeA = await buildNode(bus, 'a');
  const nodeB = await buildNode(bus, 'b');

  // Let the clock settle so master election is decided from measurement, not luck.
  await new Promise((resolve) => setTimeout(resolve, 120));

  check('both nodes see one peer', nodeA.swarm.peers().length === 1 && nodeB.swarm.peers().length === 1);
  check('lowest id is master on both nodes', nodeA.swarm.isMaster() && !nodeB.swarm.isMaster());
  check('both agree on the master', nodeA.clock.masterId() === 'a' && nodeB.clock.masterId() === 'a');

  section('Mesh swarm: preset propagation');
  const published = nodeA.swarm.publishPreset({ bpm: 128, camelot: '8A', trackId: 'aurora', masterGain: 0.85 });
  check('the master may publish', published !== null && published.revision === 1);
  check('the master sees its own preset', nodeA.swarm.currentPreset()?.trackId === 'aurora');
  check('the follower received it', nodeB.swarm.currentPreset()?.trackId === 'aurora');
  check('the follower recorded the preset event', nodeB.presets === 1);
  check('the preset carries the publisher', nodeB.swarm.currentPreset()?.publisher === 'a');

  section('Mesh swarm: conflict rule');
  const followerPublish = nodeB.swarm.publishPreset({ bpm: 124, camelot: '9A', trackId: 'basalt', masterGain: 0.8 });
  check('a follower cannot publish while the master is alive', followerPublish === null);
  check('the master preset still wins', nodeB.swarm.currentPreset()?.trackId === 'aurora');

  // The master speaks again with a higher revision: must always win.
  nodeA.swarm.publishPreset({ bpm: 130, camelot: '8B', trackId: 'cinder', masterGain: 0.9 });
  check('a newer master preset replaces the old one', nodeB.swarm.currentPreset()?.trackId === 'cinder');
  check('revision increments monotonically', nodeA.swarm.currentPreset()?.revision === 2);

  section('Mesh swarm: intents');
  nodeB.swarm.sendIntent({ kind: 'vote', trackId: 'cinder', weight: 0.8 });
  nodeB.swarm.sendIntent({ kind: 'next', trackId: 'cinder' });
  check('the master received both intents', nodeA.intents.length === 2, String(nodeA.intents.length));
  check('intent ordering is preserved', nodeA.intents[0]?.kind === 'vote' && nodeA.intents[1]?.kind === 'next');
  check('intent sender is identified', nodeA.intents[0]?.from === 'b');
  check('the follower does not receive its own intents', nodeB.intents.length === 0);
  check('recent intents are queryable', nodeA.swarm.recentIntents(5).length === 2);

  section('Mesh swarm: synchronised launch');
  const launch = nodeA.swarm.launchTogether('cinder', 128);
  check('launch lands in the future', launch.atMasterMs >= soloClock.syncedNow() - 5);
  check('launch is on a bar boundary', near(launch.atMasterMs - (soloClock.syncedNow()), solo.msToNextBar(soloClock.syncedNow() / (60000 / 128), 128), 60));
  check('a launch intent was broadcast', nodeB.intents.some((intent) => intent.kind === 'launch'));
  check('local time differs only by the measured offset', Math.abs(launch.atLocalMs - launch.atMasterMs) <= 50);

  section('Mesh swarm: master loss takeover');
  await nodeA.transport.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('the surviving node drops the silent peer', nodeB.swarm.peers().length === 0, String(nodeB.swarm.peers().length));
  check('the survivor becomes master', nodeB.swarm.isMaster(), nodeB.clock.masterId());
  const takeover = nodeB.swarm.publishPreset({ bpm: 126, camelot: '8A', trackId: 'encores', masterGain: 0.75 });
  check('the survivor may publish after the master vanished', takeover !== null);
  check('its preset is now current', nodeB.swarm.currentPreset()?.trackId === 'encores');

  nodeA.clock.stop();
  nodeB.clock.stop();
}
