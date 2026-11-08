import { SessionStore, type SessionSnapshot, type SessionStorage } from '../../state/SessionStore';
import { asDeck, type StudioContext, type StudioPlugin } from '../Studio';

/**
 * Sprint 11 wiring: crash-safe session restore.
 *
 * The store already knew how to debounce, migrate and mark a clean shutdown. What was
 * missing is the bridge in both directions: read the app state into a snapshot on every
 * change, and push a restored snapshot back into the engine at boot.
 *
 * One decision worth naming: the restore is *applied*, not just read. A restored
 * session that only repopulates the UI and leaves the engine at defaults is worse than
 * no restore at all, because the DJ sees the right numbers and hears silence.
 */
export interface SessionWiring {
  /** Persists immediately; used before the app goes to background. */
  flush(): boolean;
  /** Re-reads app state into a fresh snapshot. */
  capture(): void;
  store(): SessionStore;
}

export function sessionPlugin(): StudioPlugin & { wiring: SessionWiring | null } {
  const plugin: StudioPlugin & { wiring: SessionWiring | null } = {
    name: 'session',
    sprint: 11,
    wiring: null,
    install(ctx: StudioContext) {
      const storage: SessionStorage = {
        load: () => ctx.storage.getItem('auragrid.session'),
        save: (text: string) => ctx.storage.setItem('auragrid.session', text),
        remove: () => ctx.storage.removeItem('auragrid.session'),
      };
      const store = new SessionStore(storage, { deckCount: ctx.state.decks.length, now: ctx.now });
      const restored = store.restore();

      if (restored.snapshot) {
        const wasCrash = !restored.snapshot.clean;
        applySnapshot(ctx, restored.snapshot);
        ctx.log(
          'session',
          wasCrash
            ? `previous session was not closed cleanly, restored ${restored.snapshot.decks.length} decks`
            : 'session restored',
        );
      } else if (restored.warnings.length > 0) {
        ctx.log('session', `restore skipped: ${restored.warnings.join(', ')}`);
      }

      const wiring: SessionWiring = {
        flush: () => store.saveNow(),
        capture: () => capture(ctx, store),
        store: () => store,
      };
      plugin.wiring = wiring;

      ctx.provide('flushSession', wiring.flush);
      ctx.provide('captureSession', wiring.capture);

      // Autosave hangs off the studio's change notifications instead of a timer per
      // control: one debounced write behind many rapid fader moves.
      const unsubscribe = ctx.subscribe(() => capture(ctx, store));
      capture(ctx, store);
      // A snapshot must exist from the first boot, otherwise the very first crash
      // has nothing to restore. The debounce is for the writes that follow.
      store.saveNow();

      plugin.dispose = () => {
        unsubscribe();
        store.saveNow();
      };
    },
    dispose() {
      plugin.wiring?.flush();
    },
  };
  return plugin;
}

/** App state → snapshot. Only what the app actually tracks is written. */
function capture(ctx: StudioContext, store: SessionStore): void {
  store.patch({ activeDeck: ctx.state.selectedDeck, savedAt: ctx.now(), clean: false });
  const rate = ctx.engine.sampleRate;
  ctx.state.decks.forEach((deck, index) => {
    store.setDeck(index, {
      trackId: deck.trackId ?? null,
      positionSeconds: deck.positionSeconds ?? 0,
      rate: deck.rate ?? 1,
      gain: deck.gain ?? 1,
      filter: deck.filter ?? 0,
      loop: deck.loop
        ? { startSeconds: deck.loop.startFrame / Math.max(1, rate), endSeconds: deck.loop.endFrame / Math.max(1, rate) }
        : null,
    });
  });
}

/** Snapshot → engine. This is the half that makes a restore audible. */
function applySnapshot(ctx: StudioContext, snapshot: SessionSnapshot): void {
  const rate = Math.max(1, ctx.engine.sampleRate);
  ctx.state.selectedDeck = asDeck(Math.min(snapshot.activeDeck, ctx.state.decks.length - 1));
  snapshot.decks.forEach((deck, index) => {
    const wiringDeck = ctx.state.decks[index];
    if (!wiringDeck) return;
    const id = asDeck(index);
    ctx.engine.setDeckGain(id, deck.gain);
    ctx.engine.setDeckRate(id, deck.rate);
    ctx.engine.setFx(id, 'filter', deck.filter);
    if (deck.loop) {
      const startFrame = Math.round(deck.loop.startSeconds * rate);
      const endFrame = Math.round(deck.loop.endSeconds * rate);
      ctx.engine.setLoop(id, startFrame, endFrame);
      wiringDeck.loop = { startFrame, endFrame };
    } else {
      ctx.engine.clearLoop(id);
      wiringDeck.loop = null;
    }
    wiringDeck.trackId = deck.trackId;
    wiringDeck.positionSeconds = deck.positionSeconds;
    wiringDeck.rate = deck.rate;
    wiringDeck.gain = deck.gain;
    wiringDeck.filter = deck.filter;
    if (deck.positionSeconds > 0) ctx.engine.seek(id, Math.round(deck.positionSeconds * rate));
  });
  ctx.state.bpm = ctx.engine.currentBpm;
  ctx.notify();
}

/** Marks the session clean on shutdown; call from the app's background handler. */
export function markSessionClean(store: SessionStore): boolean {
  if (!store.markCleanShutdown()) return false;
  return store.saveNow();
}
