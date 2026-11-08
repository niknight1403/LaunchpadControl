import { MidiMap, targetKey, type MidiMessage } from '../../src/midi/MidiMap';
import { check, near, section } from './harness';

const cc = (number: number, value: number, channel = 0): MidiMessage => ({ type: 'cc', channel, number, value });
const note = (number: number, value: number, channel = 0): MidiMessage => ({ type: 'note', channel, number, value });

export async function run(): Promise<void> {
  section('MIDI map: learn');
  let clock = 1_000;
  const map = new MidiMap({ now: () => clock });
  const target = { kind: 'fx', deck: 0, param: 'filterCutoff' } as const;

  check('nothing is bound yet', map.bindings().length === 0);
  check('a message with no binding is ignored', map.handle(cc(74, 0.5)).kind === 'ignored');

  map.beginLearn(target);
  check('learn mode is active', map.isLearning && map.learningTarget !== null);
  const learned = map.handle(cc(74, 0.42));
  check('learn captures the message', learned.kind === 'learned');
  check('learn leaves learn mode', !map.isLearning);
  check('the binding is stored', map.bindings().length === 1);
  check('the binding points at the target', targetKey(map.bindings()[0]!.target) === 'fx:0:filterCutoff');
  check('the binding has an id', typeof map.bindings()[0]!.id === 'string' && map.bindings()[0]!.id.length > 0);

  section('MIDI map: values');
  const value = map.handle(cc(74, 0.5));
  check('the bound message resolves', value.kind === 'value');
  check('a linear binding passes the value through', value.kind === 'value' && near(value.value, 0.5, 1e-3));
  check('values are clamped at the top', (map.handle(cc(74, 3)) as { value: number }).value === 1);
  check('values are clamped at the bottom', (map.handle(cc(74, -2)) as { value: number }).value === 0);

  const mappingId = map.bindings()[0]!.id;
  map.reconfigure(mappingId, { min: 0.2, max: 1 });
  check('a range is applied', near((map.handle(cc(74, 0.5)) as { value: number }).value, 0.6, 1e-3));
  check('the range clamps to the minimum', near((map.handle(cc(74, 0)) as { value: number }).value, 0.2, 1e-3));
  check('an inverted range is rejected', map.reconfigure(mappingId, { min: 1, max: 0 }) === null);

  map.reconfigure(mappingId, { curve: 'quadratic', min: 0, max: 1 });
  check('quadratic curves weight the low end', near((map.handle(cc(74, 0.5)) as { value: number }).value, 0.25, 1e-3));
  map.reconfigure(mappingId, { curve: 'sqrt' });
  check('sqrt curves lift the low end', (map.handle(cc(74, 0.25)) as { value: number }).value > 0.25);
  check('curves are monotonic', (() => {
    map.reconfigure(mappingId, { curve: 'quadratic' });
    const low = (map.handle(cc(74, 0.25)) as { value: number }).value;
    const high = (map.handle(cc(74, 0.75)) as { value: number }).value;
    return high > low;
  })());

  section('MIDI map: message identity');
  check('a different CC does not match', map.handle(cc(75, 0.5)).kind === 'ignored');
  check('a different channel does not match', map.handle(cc(74, 0.5, 3)).kind === 'ignored');
  check('a note is not a CC', map.handle(note(74, 0.5)).kind === 'ignored');

  const channelFiltered = new MidiMap({ channel: 2 });
  channelFiltered.beginLearn({ kind: 'transport', action: 'play' });
  channelFiltered.handle(note(36, 1, 2));
  check('a channel filter is respected', channelFiltered.bindings().length === 1);
  const blocked = channelFiltered.handle(note(36, 1, 5));
  check('messages on other channels are ignored', blocked.kind === 'ignored' && blocked.reason.includes('filtered'));

  section('MIDI map: conflicts');
  const before = map.bindings().length;
  map.beginLearn({ kind: 'fx', deck: 1, param: 'delayMix' });
  const relearned = map.handle(cc(74, 0.1));
  check('re-learning a used message replaces the binding', relearned.kind === 'learned' && relearned.replaced !== null);
  check('the binding count stays the same', map.bindings().length === before);
  check('the message now points at the new target', targetKey(map.bindings()[0]!.target) === 'fx:1:delayMix');

  // Learn a *second* message onto a target that is already bound: a serious
  // controller (and a worn-out one) does this, so it must be visible, not merged.
  map.beginLearn({ kind: 'fx', deck: 1, param: 'delayMix' });
  map.handle(cc(11, 0.5));
  const conflicting = map.forTarget({ kind: 'fx', deck: 1, param: 'delayMix' });
  check('two bindings can share a target', conflicting.length === 2);
  check('conflicts are reported', map.conflicts().length === 2);

  section('MIDI map: persistence');
  const serialised = JSON.parse(JSON.stringify(map.toJSON()));
  check('export is an array', Array.isArray(serialised) && serialised.length === map.bindings().length);
  const { map: reimported, warnings } = MidiMap.fromJSON(serialised);
  check('import restores the same count', reimported.bindings().length === map.bindings().length);
  check('import is warning-free for valid data', warnings.length === 0, warnings.join(','));
  check('imported curve survives', reimported.bindings()[0]!.curve === map.bindings()[0]!.curve);
  const resolved = reimported.handle(cc(11, 0.5));
  check('imported bindings still resolve', resolved.kind === 'value');

  const junk = MidiMap.fromJSON([{ message: { number: 1 } }, 42, null, { message: { number: 5, channel: 0, type: 'cc' }, target: { kind: 'transport', action: 'stop' } }]);
  check('junk entries are skipped', junk.map.bindings().length === 1);
  check('junk is reported', junk.warnings.length === 3, junk.warnings.join('|'));
  const notAnArray = MidiMap.fromJSON({ nope: true });
  check('a non-array file is reported', notAnArray.warnings.length === 1 && notAnArray.map.bindings().length === 0);

  section('MIDI map: removal');
  const victim = map.bindings()[0]!.id;
  check('a binding can be removed', map.remove(victim));
  check('removing twice returns false', !map.remove(victim));
  check('the removed message no longer resolves', map.handle(cc(74, 0.5)).kind === 'ignored');
  map.cancelLearn();
  check('cancel leaves learn mode', !map.isLearning);
}
