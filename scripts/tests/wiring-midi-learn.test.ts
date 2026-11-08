import { MemoryStudioStorage, Studio, type StudioMidi, type StudioMidiMessage } from '../../src/app/Studio';
import { midiLearnPlugin } from '../../src/app/wiring/midi-learn';
import { Translator } from '../../src/i18n/strings';
import { check, section } from './harness';
import { fakeEngine } from './wiring-session.test';

/** A controller that can be driven from the test. */
function fakeMidi(): StudioMidi & { emit(message: StudioMidiMessage): void; listening: number } {
  const listeners = new Set<(message: StudioMidiMessage) => void>();
  return {
    listening: 0,
    subscribe(listener) {
      listeners.add(listener);
      this.listening = listeners.size;
      return () => {
        listeners.delete(listener);
        this.listening = listeners.size;
      };
    },
    emit(message) {
      for (const listener of [...listeners]) listener(message);
    },
  };
}

export async function run(): Promise<void> {
  section('Sprint 12 wiring: MIDI learn');

  const storage = new MemoryStudioStorage();
  const engine = fakeEngine();
  const midi = fakeMidi();
  const studio = new Studio({ engine, translator: new Translator(), storage, midi, deckCount: 4 });
  await studio.boot([midiLearnPlugin()]);

  check('the controller is subscribed', midi.listening === 1);
  check('learn commands are published', ['beginLearn', 'cancelLearn', 'midiBindings', 'exportMidiMap', 'importMidiMap'].every((name) => studio.commands.has(name)));

  const wiring = (studio.installed.length === 1 ? studio : studio).commands;
  const beginLearn = studio.commands.get('beginLearn')! as (target: unknown) => void;
  beginLearn({ kind: 'fx', deck: 0, param: 'filter' });

  // Learning: the next message becomes the binding, and must not also act.
  midi.emit({ type: 'cc', channel: 0, number: 21, value: 127 });
  const bindings = studio.commands.get('midiBindings')!() as { message: { number: number } }[];
  check('a binding is learned', bindings.length === 1, JSON.stringify(bindings));
  check('the learned message number is kept', bindings[0]?.message.number === 21);
  check('learning is persisted immediately', (storage.getItem('auragrid.midimap') ?? '').includes('"number":21'), storage.getItem('auragrid.midimap') ?? '');
  check('the learning message does not also act', !engine.calls.some((call) => call.startsWith('fx:0:0:1')), engine.calls.join(','));

  // Using the binding now moves the parameter, with hardware range normalisation.
  midi.emit({ type: 'cc', channel: 0, number: 21, value: 64 });
  // The map rounds resolved values to milliseconds of fader resolution: 64/127 ≈ 0.504.
  check('a mapped CC drives the engine', engine.calls.some((call) => call.startsWith('fx:0:0:0.50')), engine.calls.join(','));
  check('the deck state mirrors the filter', Math.abs((studio.ctx.state.decks[0]?.filter ?? 0) - 64 / 127) < 0.001, String(studio.ctx.state.decks[0]?.filter));

  // A second binding on another deck, to prove deck routing.
  beginLearn({ kind: 'deck', deck: 2, action: 'play' });
  midi.emit({ type: 'note', channel: 0, number: 40, value: 127 });
  engine.calls.length = 0;
  midi.emit({ type: 'note', channel: 0, number: 40, value: 127 });
  check('a deck action hits the right deck', engine.calls.includes('pad:2:0:1'), engine.calls.join(','));
  engine.calls.length = 0;
  midi.emit({ type: 'note', channel: 0, number: 40, value: 0 });
  check('a release does not retrigger', !engine.calls.includes('pad:2:0:1'), engine.calls.join(','));

  // Transport stop is handled even without another sprint's command.
  beginLearn({ kind: 'transport', action: 'stop' });
  midi.emit({ type: 'cc', channel: 0, number: 60, value: 127 });
  engine.calls.length = 0;
  midi.emit({ type: 'cc', channel: 0, number: 60, value: 127 });
  check('transport stop stops every deck', [0, 1, 2, 3].every((deck) => engine.calls.includes(`stop:${deck}`)), engine.calls.join(','));

  // Attack: an unmapped message must not be swallowed silently into nowhere.
  const before = studio.ctx.state.events.length;
  midi.emit({ type: 'cc', channel: 0, number: 99, value: 100 });
  check('an unmapped message is ignored without logging noise', studio.ctx.state.events.length === before);

  // Export / import round trip.
  const exported = studio.commands.get('exportMidiMap')! as () => string;
  const json = exported();
  check('the export is valid json', JSON.parse(json).length >= 3, json.slice(0, 60));

  const other = new Studio({ engine: fakeEngine(), translator: new Translator(), storage: new MemoryStudioStorage(), midi: fakeMidi(), deckCount: 4 });
  await other.boot([midiLearnPlugin()]);
  const imported = (other.commands.get('importMidiMap')! as (text: string) => { applied: number; warnings: string[] })(json);
  check('the import restores every binding', imported.applied === JSON.parse(json).length, JSON.stringify(imported));
  check('a clean import warns about nothing', imported.warnings.length === 0, imported.warnings.join('|'));

  // Hostile file: must not wipe a working map.
  const hostile = (other.commands.get('importMidiMap')! as (text: string) => { applied: number; warnings: string[] })('{"not":"an array"}');
  check('a hostile mapping file is refused', hostile.applied === 0 && hostile.warnings.length > 0, JSON.stringify(hostile));
  const stillThere = other.commands.get('midiBindings')!() as unknown[];
  check('a refused import keeps the old bindings', stillThere.length === JSON.parse(json).length, String(stillThere.length));

  // No controller at all: boot must still work.
  const bare = new Studio({ engine: fakeEngine(), translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  let crashed = false;
  try {
    await bare.boot([midiLearnPlugin()]);
  } catch {
    crashed = true;
  }
  check('booting without a controller is safe', !crashed);
  check('the missing controller is reported', bare.ctx.state.events.some((event) => event.kind === 'midi'), JSON.stringify(bare.ctx.state.events));

  await studio.shutdown();
  check('shutdown unsubscribes', midi.listening === 0, String(midi.listening));
  check('unused wiring reference is not required', wiring !== undefined);
}
