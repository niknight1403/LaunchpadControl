import { SessionStore, migrateSnapshot, type SessionStorage } from '../../src/state/SessionStore';
import { check, near, section } from './harness';

class MemoryStorage implements SessionStorage {
  data: string | null = null;
  saves = 0;
  removals = 0;

  load(): string | null {
    return this.data;
  }

  save(text: string): void {
    this.data = text;
    this.saves += 1;
  }

  remove(): void {
    this.data = null;
    this.removals += 1;
  }
}

/** Collects debounce callbacks so the test can fire them by hand. */
function fakeTimers() {
  const queue: { handler: () => void; ms: number }[] = [];
  return {
    queue,
    setTimeoutFn: (handler: () => void, ms: number) => {
      queue.push({ handler, ms });
      return queue.length - 1;
    },
    clearTimeoutFn: () => {
      queue.length = 0;
    },
    runAll: () => {
      const pending = [...queue];
      queue.length = 0;
      for (const entry of pending) entry.handler();
    },
  };
}

export async function run(): Promise<void> {
  section('Session store: snapshot shape');
  const storage = new MemoryStorage();
  const timers = fakeTimers();
  let clock = 1_000;
  const store = new SessionStore(storage, {
    now: () => clock,
    debounceMs: 500,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  check('a fresh store has four decks', store.snapshot.decks.length === 4);
  check('decks start empty', store.snapshot.decks.every((deck) => deck.trackId === null));
  check('a fresh store is not clean', !store.snapshot.clean);

  section('Session store: writes');
  store.setDeck(0, { trackId: 'aurora', positionSeconds: 42.5, filter: 0.6 });
  store.setUi({ motion: true });
  check('changes mark the store dirty', store.hasPendingWrite);
  check('nothing was written yet', storage.saves === 0);

  // A slider drag fires many changes; the debounce collapses them.
  store.setDeck(0, { filter: 0.7 });
  store.setDeck(0, { filter: 0.8 });
  clock += 100;
  timers.runAll();
  check('one write for a burst of changes', storage.saves === 1, String(storage.saves));
  check('the store is clean after the write', !store.hasPendingWrite);

  const persisted = JSON.parse(storage.data ?? '{}');
  check('the deck travelled to storage', persisted.decks[0].trackId === 'aurora');
  check('the last value in a burst wins', near(persisted.decks[0].filter, 0.8, 1e-9));
  check('ui state travelled too', persisted.ui.motion === true);
  check('a normal write is not marked clean', persisted.clean === false);

  section('Session store: clean shutdown');
  clock += 1_000;
  check('marking a clean shutdown writes', store.markCleanShutdown());
  const clean = JSON.parse(storage.data ?? '{}');
  check('the snapshot is now marked clean', clean.clean === true);

  section('Session store: restore');
  storage.data = JSON.stringify({
    version: 1,
    savedAt: 5_000,
    clean: true,
    activeDeck: 2,
    decks: [
      { trackId: 'a', positionSeconds: 10, rate: 1, gain: 1, filter: 1, loop: { startSeconds: 4, endSeconds: 8 } },
      { trackId: null, positionSeconds: 0, rate: 1, gain: 1, filter: 1, loop: null },
      { trackId: 'b', positionSeconds: 3, rate: 1.05, gain: 0.9, filter: 0.8, loop: null },
      { trackId: null, positionSeconds: 0, rate: 1, gain: 1, filter: 1, loop: null },
    ],
    libraryTrackIds: ['a', 'b'],
    setPlanIds: ['plan-1'],
    ui: { motion: false, mixerOpen: true },
  });
  const restored = store.restore();
  check('clean restore produces no warnings', restored.warnings.length === 0, restored.warnings.join(','));
  check('active deck restored', restored.snapshot?.activeDeck === 2);
  check('loop restored', restored.snapshot?.decks[0]?.loop?.endSeconds === 8);
  check('library ids restored', restored.snapshot?.libraryTrackIds.length === 2);
  check('mixer state restored', restored.snapshot?.ui.mixerOpen === true);
  check('the store adopts the restored state', store.snapshot.decks[2]!.trackId === 'b');

  section('Session store: unclean shutdown');
  const crashed = new SessionStore(storage, { now: () => clock });
  storage.data = JSON.stringify({ version: 1, savedAt: 1, clean: false, decks: [] });
  const recovered = crashed.restore();
  check('an unclean snapshot is reported', recovered.warnings.some((warning) => warning.includes('clean shutdown')));
  check('the decks are still usable', recovered.snapshot !== null && recovered.snapshot.decks.length === 4);
  check('missing decks are warned about', recovered.warnings.some((warning) => warning.includes('expected 4 decks')));

  section('Session store: hostile input');
  storage.data = 'not json at all';
  const broken = new SessionStore(storage);
  const brokenResult = broken.restore();
  check('corrupt json yields no snapshot', brokenResult.snapshot === null);
  check('corrupt json is reported', (brokenResult.warnings[0] ?? '').includes('not valid JSON'));

  const future = migrateSnapshot({ version: 9 });
  check('a newer snapshot version is refused', future.snapshot === null && (future.warnings[0] ?? '').includes('newer'));

  const legacy = migrateSnapshot({ activeDeck: 1, decks: [{ trackId: 'x' }] });
  check('a v0 snapshot is migrated', legacy.snapshot?.version === 1, JSON.stringify(legacy.snapshot?.version));
  check('a v0 snapshot is reported', legacy.warnings.some((warning) => warning.includes('legacy v0')));
  check('v0 deck data is kept', legacy.snapshot?.decks[0]?.trackId === 'x');

  const wild = migrateSnapshot({
    version: 1,
    activeDeck: 99,
    decks: [
      { trackId: 'x', rate: 9, gain: 40, filter: -3, positionSeconds: -12, loop: { startSeconds: 8, endSeconds: 2 } },
      'not an object',
    ],
  });
  check('active deck is clamped', wild.snapshot?.activeDeck === 3);
  check('rate is clamped into the playable range', near(wild.snapshot?.decks[0]?.rate ?? 0, 2, 1e-9));
  check('gain is clamped', near(wild.snapshot?.decks[0]?.gain ?? 0, 1.5, 1e-9));
  check('negative positions are clamped', (wild.snapshot?.decks[0]?.positionSeconds ?? -1) === 0);
  check('an inverted loop is dropped', wild.snapshot?.decks[0]?.loop === null);
  check('clamping is reported', wild.warnings.some((warning) => warning.includes('clamped')));
  check('a broken deck entry falls back to empty', wild.snapshot?.decks[1]?.trackId === null);

  section('Session store: clear');
  const clearing = new SessionStore(storage, {
    now: () => clock,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  clearing.setDeck(1, { trackId: 'z' });
  clearing.clear();
  check('clear removes the stored session', storage.removals === 1 && storage.data === null);
  check('clear resets the state', clearing.snapshot.decks[1]!.trackId === null);
  check('clear drops pending writes', !clearing.hasPendingWrite);
}
