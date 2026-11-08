import { MemoryStudioStorage, Studio } from '../../src/app/Studio';
import { HydratedStudioStorage, type PersistAdapter } from '../../src/app/HydratedStudioStorage';
import { bootStudio } from '../../src/app/studioBoot';
import { Translator } from '../../src/i18n/strings';
import { check, section } from './harness';
import { fakeEngine } from './wiring-session.test';

function fakePersist(initial: string | null = null): PersistAdapter & { writes: string[]; current: string | null } {
  const adapter = {
    current: initial,
    writes: [] as string[],
    async read() {
      return adapter.current;
    },
    async write(text: string) {
      adapter.writes.push(text);
      adapter.current = text;
    },
  };
  return adapter;
}

export async function run(): Promise<void> {
  section('Studio boot: persistence adapter');

  const persist = fakePersist(JSON.stringify({ 'auragrid.test': 'one' }));
  const storage = await HydratedStudioStorage.open(persist, 5);
  check('the document is hydrated before use', storage.getItem('auragrid.test') === 'one');
  check('an unknown key is null', storage.getItem('nope') === null);

  storage.setItem('auragrid.test', 'two');
  storage.setItem('auragrid.second', 'x');
  await storage.flush();
  check('a flush writes once for many changes', persist.writes.length === 1, String(persist.writes.length));
  const written = JSON.parse(persist.current ?? '{}');
  check('every change is in the document', written['auragrid.test'] === 'two' && written['auragrid.second'] === 'x', JSON.stringify(written));

  storage.setItem('auragrid.test', 'two');
  await storage.flush();
  check('an unchanged write is not repeated', persist.writes.length === 2, String(persist.writes.length));

  storage.removeItem('auragrid.second');
  await storage.flush();
  check('a removal is persisted', !('auragrid.second' in JSON.parse(persist.current ?? '{}')), persist.current ?? '');

  const corrupt = await HydratedStudioStorage.open(fakePersist('{not json'), 5);
  check('a corrupt document boot-empty instead of throwing', corrupt.size === 0 && corrupt.getItem('x') === null);

  const hostile = await HydratedStudioStorage.open(fakePersist(JSON.stringify({ a: 1, b: 'ok' })), 5);
  check('non-string values are dropped', hostile.getItem('a') === null && hostile.getItem('b') === 'ok');

  section('Studio boot: all ten sprints');

  const boot = await bootStudio({ engine: fakeEngine(), translator: new Translator(), storage: new MemoryStudioStorage(), deckCount: 4 });
  check('ten sprints are installed', boot.sprints.length === 10, JSON.stringify(boot.sprints));
  check('they are installed in sprint order', JSON.stringify(boot.sprints) === JSON.stringify([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), JSON.stringify(boot.sprints));

  const commands = [...boot.studio.commands.keys()];
  const expected = [
    'flushSession', 'beginLearn', 'setGrid', 'triggerQuantized', 'analyseStems', 'soloStem',
    'buildWaveform', 'toggleRecord', 'exportTake', 'meshStatus', 'syncDeckFromMesh',
    'latencyRecommended', 'exportBackup', 'restoreBackup', 'setLanguage', 't', 'auditContrast',
  ];
  const missing = expected.filter((name) => !boot.studio.commands.has(name));
  check('every sprint publishes what the UI needs', missing.length === 0, missing.join(','));
  check('the command count matches the wiring', commands.length >= expected.length, String(commands.length));

  // The boot must leave a usable state, not just a list of plugins.
  check('the language reaches the state', boot.studio.ctx.state.language === boot.translator.current);
  check('the contrast audit ran at boot', boot.studio.ctx.state.a11y !== null, JSON.stringify(boot.studio.ctx.state.a11y));
  check('the event log records the boot', boot.studio.ctx.state.events.some((event) => event.kind === 'boot'), JSON.stringify(boot.studio.ctx.state.events.slice(0, 2)));

  await boot.studio.shutdown();
  check('shutdown disposes every plugin', boot.studio.installed.length === 0);

  // Booting twice on the same storage must restore, not duplicate.
  const shared = new MemoryStudioStorage();
  const first = await bootStudio({ engine: fakeEngine(), storage: shared, deckCount: 4 });
  first.studio.ctx.state.decks[2]!.gain = 0.35;
  first.studio.commands.get('flushSession')!();
  await first.studio.shutdown();

  const engine2 = fakeEngine();
  const second = await bootStudio({ engine: engine2, storage: shared, deckCount: 4 });
  check('a second boot restores the deck gain', engine2.calls.includes('gain:2:0.35'), engine2.calls.join(','));
  check('a second boot is not a failure', second.studio.installed.length === 10);
  await second.studio.shutdown();

  // A studio with no controller and no socket is the normal phone boot.
  const bare = await bootStudio({ engine: fakeEngine(), storage: new MemoryStudioStorage(), deckCount: 4, midi: null });
  check('a phone boot without hardware works', bare.studio.installed.length === 10);
  const studio: Studio = bare.studio;
  check('the missing controller is reported once', studio.ctx.state.events.filter((event) => event.kind === 'midi').length === 1, JSON.stringify(studio.ctx.state.events.filter((event) => event.kind === 'midi')));
  await bare.studio.shutdown();
}
