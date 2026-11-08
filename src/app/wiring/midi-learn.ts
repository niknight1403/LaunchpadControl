import { MidiMap, type Mapping, type MappingTarget } from '../../midi/MidiMap';
import { asDeck, type StudioContext, type StudioPlugin } from '../Studio';
import { FxParam } from '../../engine/types';

/**
 * Sprint 12 wiring: MIDI learn reaches the engine.
 *
 * The map knew how to learn, curve and serialise a binding. What it could not do on its
 * own is turn a binding into sound — that needs the engine, and for transport actions
 * the commands the other sprints provide.
 */
export interface MidiLearnWiring {
  beginLearn(target: MappingTarget): void;
  cancel(): void;
  bindings(): Mapping[];
  exportJson(): string;
  importJson(text: string): { applied: number; warnings: string[] };
}

const STORAGE_KEY = 'auragrid.midimap';

export function midiLearnPlugin(): StudioPlugin & { wiring: MidiLearnWiring | null } {
  const plugin: StudioPlugin & { wiring: MidiLearnWiring | null } = {
    name: 'midi-learn',
    sprint: 12,
    wiring: null,
    install(ctx: StudioContext) {
      const midi = ctx.midi;

      let map = new MidiMap({ now: ctx.now });
      const stored = ctx.storage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = safeParse(stored);
        const restored = MidiMap.fromJSON(parsed, { now: ctx.now });
        restored.warnings.forEach((warning) => ctx.log('midi', warning));
        if (restored.map.bindings().length > 0) {
          map = restored.map;
          ctx.log('midi', `${map.bindings().length} mappings restored`);
        }
      }

      const persist = () => ctx.storage.setItem(STORAGE_KEY, JSON.stringify(map.toJSON()));

      const unsubscribe = midi ? midi.subscribe((message) => {
        const result = map.handle({
          type: message.type,
          channel: message.channel,
          number: message.number,
          // Hardware sends 0..127; the map expects 0..1 and would silently clamp a raw
          // velocity of 100 to "full".
          value: message.value > 1 ? message.value / 127 : message.value,
        });
        if (result.kind === 'learned') {
          persist();
          ctx.log('midi', `learned ${message.type} ${message.number} → ${describe(result.mapping.target)}`);
          return;
        }
        if (result.kind !== 'value') return;
        apply(ctx, result.mapping.target, result.value);
      }) : () => {};
      if (!midi) {
        // The learn buttons must still exist on a phone with no hardware in reach;
        // starting a learn that can never receive a message would be the lie.
        ctx.log('midi', 'no controller attached, learn waits for hardware');
      }


      const wiring: MidiLearnWiring = {
        beginLearn: (target) => {
          map.beginLearn(target);
          ctx.log('midi', `learning for ${describe(target)}`);
        },
        cancel: () => map.cancelLearn(),
        bindings: () => map.bindings(),
        exportJson: () => JSON.stringify(map.toJSON()),
        importJson: (text) => {
          const restored = MidiMap.fromJSON(safeParse(text), { now: ctx.now });
          restored.warnings.forEach((warning) => ctx.log('midi', warning));
          // Replace only when the file actually parsed into something usable, so a
          // corrupt file cannot wipe a working mapping.
          if (restored.map.bindings().length > 0) {
            map = restored.map;
            persist();
            ctx.notify();
          }
          return { applied: restored.map.bindings().length, warnings: restored.warnings };
        },
      };
      plugin.wiring = wiring;

      ctx.provide('beginLearn', wiring.beginLearn);
      ctx.provide('cancelLearn', wiring.cancel);
      ctx.provide('midiBindings', wiring.bindings);
      ctx.provide('exportMidiMap', wiring.exportJson);
      ctx.provide('importMidiMap', wiring.importJson);

      plugin.dispose = () => unsubscribe();
    },
    dispose() {
      /* replaced in install when a controller is present */
    },
  };
  return plugin;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One binding, applied to the engine or forwarded to the command another sprint owns. */
function apply(ctx: StudioContext, target: MappingTarget, value: number): void {
  if (target.kind === 'fx') {
    const param = resolveFxParam(target.param);
    if (param === null) {
      // A mapping can name anything; an unknown name must not be silently dropped onto
      // whichever enum value happens to be first.
      ctx.log('midi', `unknown fx parameter "${target.param}"`);
      return;
    }
    ctx.engine.setFx(asDeck(target.deck), param, value);
    const deckState = ctx.state.decks[target.deck];
    if (deckState) deckState.filter = value;
    ctx.notify();
    return;
  }

  if (target.kind === 'transport') {
    const command = ctx.commands.get(`transport:${target.action}`);
    if (command) {
      command();
      return;
    }
    if (target.action === 'stop') {
      ctx.state.decks.forEach((_, index) => ctx.engine.stopDeck(asDeck(index)));
      ctx.notify();
      return;
    }
    ctx.log('midi', `transport ${target.action} has no handler yet`);
    return;
  }

  // A press fires above the midpoint, so a fader mapped to a button does not retrigger
  // on release.
  if (value <= 0.5) return;
  const deck = asDeck(target.deck);
  switch (target.action) {
    case 'play':
      ctx.engine.triggerPad(deck, 0, 1);
      break;
    default: {
      const command = ctx.commands.get(`deck:${target.action}`);
      if (command) command(deck);
      else ctx.log('midi', `deck ${target.action} has no handler yet`);
      break;
    }
  }
  ctx.notify();
}

/** Mapping targets carry a readable name; the engine wants the enum. */
export function resolveFxParam(name: string): FxParam | null {
  const normalized = name.trim().toLowerCase();
  const table: Record<string, FxParam> = {
    filter: FxParam.FilterCutoff,
    cutoff: FxParam.FilterCutoff,
    filtercutoff: FxParam.FilterCutoff,
    resonance: FxParam.FilterResonance,
    filterresonance: FxParam.FilterResonance,
    filtermode: FxParam.FilterMode,
    stutterrate: FxParam.StutterRate,
    stuttermix: FxParam.StutterMix,
    delaymix: FxParam.DelayMix,
    delayfeedback: FxParam.DelayFeedback,
    delaydrift: FxParam.DelayDrift,
    drive: FxParam.Drive,
  };
  return table[normalized] ?? table[normalized.replace(/[^a-z]/g, '')] ?? null;
}

function describe(target: MappingTarget): string {
  if (target.kind === 'fx') return `deck ${target.deck} fx ${target.param}`;
  if (target.kind === 'deck') return `deck ${target.deck} ${target.action}`;
  return `transport ${target.action}`;
}
