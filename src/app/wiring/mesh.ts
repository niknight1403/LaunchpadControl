import { MeshClockSync } from '../../agent/MeshClockSync';
import { MeshSyncEngine } from '../../agent/MeshSyncEngine';
import { MeshSwarm, type SwarmPreset } from '../../agent/MeshSwarm';
import { UdpMeshTransport, type UdpSocketLike } from '../../agent/UdpTransport';
import { asDeck, type StudioContext, type StudioPlugin } from '../Studio';

/**
 * Sprint 17 wiring: the swarm becomes a driver.
 *
 * Transport, clock, swarm and sync engine each existed; nobody owned the lifecycle that
 * joins them, and nothing turned a sync plan into engine calls. That is this plugin —
 * plus the one decision that matters on stage: when the link is gone, the local deck
 * keeps playing and the state says so, instead of freezing on a lost master.
 */
export interface MeshWiring {
  status(): { peers: number; isMaster: boolean; qualityMs: number; masterId: string };
  /** Publishes the current tempo/key as the shared reference. */
  publish(bpm: number, camelot: string): SwarmPreset | null;
  /** Applies the sync plan for a deck: rate correction now, phase nudge if needed. */
  syncDeck(deck: number): { tempoShiftPercent: number; phaseNudgeMs: number; applied: boolean };
  stats(): Record<string, number>;
}

export interface MeshPluginOptions {
  socket?: UdpSocketLike;
  selfId?: string;
  port?: number;
  masterBpm?: number;
  masterCamelot?: string;
}

export function meshPlugin(options: MeshPluginOptions = {}): StudioPlugin & { wiring: MeshWiring | null } {
  const plugin: StudioPlugin & { wiring: MeshWiring | null } = {
    name: 'mesh',
    sprint: 17,
    wiring: null,
    install(ctx: StudioContext) {
      // Without a socket there is no swarm. That is a normal single-device boot, so it
      // is logged and the rest of the app continues.
      if (!options.socket) {
        ctx.log('mesh', 'no socket provided, running standalone');
        return;
      }

      const transport = new UdpMeshTransport(options.socket, { port: options.port ?? 41_000 });
      const clock = new MeshClockSync({});
      const selfId = options.selfId ?? 'local';
      clock.setSelfId(selfId);
      const swarm = new MeshSwarm(clock, { selfId });
      const syncEngine = new MeshSyncEngine(clock, {
        masterBpm: options.masterBpm ?? ctx.state.bpm,
        masterCamelot: options.masterCamelot,
      });

      void clock.attach(transport);
      void swarm.attach(transport);
      clock.start([]);

      swarm.onPreset((preset) => {
        syncEngine.setMasterReference({ bpm: preset.bpm, camelot: preset.camelot });
        ctx.state.mesh = { peers: swarm.peers().length, isMaster: clock.isMaster(), qualityMs: clock.qualityMs(clock.masterId()) };
        ctx.log('mesh', `preset from ${preset.publisher}: ${preset.bpm} BPM ${preset.camelot ?? ''}`.trim());
        ctx.notify();
      });

      const wiring: MeshWiring = {
        status: () => ({
          peers: swarm.peers().length,
          isMaster: clock.isMaster(),
          qualityMs: clock.qualityMs(clock.masterId()),
          masterId: clock.masterId(),
        }),
        publish: (bpm, camelot) => {
          const preset = swarm.publishPreset({ bpm, camelot, trackId: null, masterGain: ctx.engine.masterGainValue });
          syncEngine.setMasterReference({ bpm, camelot });
          ctx.log('mesh', preset ? `published ${bpm} BPM ${camelot}` : 'publish refused, not master');
          return preset;
        },
        syncDeck: (deck) => {
          const deckState = ctx.state.decks[deck];
          const plan = syncEngine.planFor({
            bpm: deckState?.bpm ?? ctx.state.bpm,
            positionMs: (deckState?.positionSeconds ?? 0) * 1000,
            camelot: deckState?.camelot,
            isPlaying: true,
          });
          const usable = plan.warnings.every((warning) => !/untrusted|frozen/.test(warning));
          if (usable) {
            // Rate first, then phase: correcting phase against the un-corrected rate
            // lands on the wrong beat as soon as the tempo moves.
            ctx.engine.setDeckRate(asDeck(deck), 1 + plan.tempoShiftPercent / 100);
            if (plan.phaseNudgeMs > 1) {
              const rate = Math.max(1, ctx.engine.sampleRate);
              const targetFrames = Math.round(((deckState?.positionSeconds ?? 0) + plan.phaseNudgeMs / 1000) * rate);
              ctx.engine.seek(asDeck(deck), targetFrames);
            }
            ctx.log('mesh', `deck ${deck}: ${plan.summary}`);
          } else {
            ctx.log('mesh', `deck ${deck}: sync not applied (${plan.warnings.join('; ')})`);
          }
          ctx.notify();
          return { tempoShiftPercent: plan.tempoShiftPercent, phaseNudgeMs: plan.phaseNudgeMs, applied: usable };
        },
        stats: () => ({ ...transport.stats } as unknown as Record<string, number>),
      };
      plugin.wiring = wiring;

      ctx.provide('meshStatus', wiring.status);
      ctx.provide('publishMeshPreset', wiring.publish);
      ctx.provide('syncDeckFromMesh', wiring.syncDeck);
      ctx.provide('meshStats', wiring.stats);
      ctx.provide('deck:sync', (deck: number) => wiring.syncDeck(deck));

      ctx.state.mesh = { peers: 0, isMaster: clock.isMaster(), qualityMs: 0 };
      plugin.dispose = () => {
        clock.stop();
        void transport.stop();
      };
    },
    dispose() {
      /* replaced in install when a socket is present */
    },
  };
  return plugin;
}
