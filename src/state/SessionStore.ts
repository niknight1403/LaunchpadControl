/**
 * Session store: survives the app being killed on stage.
 *
 * A phone in a club gets backgrounded, hits a battery warning, or simply runs out
 * of RAM in the middle of a set. This store writes a small, versioned snapshot so
 * the next launch can come back to the same two tracks at the same positions.
 *
 * Two rules keep it honest:
 *  - every write is stamped, and the file only counts as clean after an explicit
 *    shutdown marker. A snapshot without that marker means "we died", and the
 *    restore path says so instead of pretending nothing happened.
 *  - nothing is trusted on the way in. Values are clamped, unknown versions are
 *    migrated, and a corrupt blob is reported, never silently discarded.
 */

export interface DeckSnapshot {
  trackId: string | null;
  positionSeconds: number;
  rate: number;
  gain: number;
  filter: number;
  loop: { startSeconds: number; endSeconds: number } | null;
}

export interface SessionUiState {
  motion: boolean;
  mixerOpen: boolean;
}

export interface SessionSnapshot {
  version: 1;
  savedAt: number;
  clean: boolean;
  activeDeck: number;
  decks: DeckSnapshot[];
  libraryTrackIds: string[];
  setPlanIds: string[];
  ui: SessionUiState;
}

export interface SessionStorage {
  load(): string | null;
  save(text: string): void;
  remove(): void;
}

export interface SessionStoreOptions {
  now?: () => number;
  debounceMs?: number;
  deckCount?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface RestoreResult {
  snapshot: SessionSnapshot | null;
  warnings: string[];
}

const DECK_COUNT = 4;
const MAX_RATE = 2;
const MIN_RATE = 0.5;

export const EMPTY_DECK: DeckSnapshot = {
  trackId: null,
  positionSeconds: 0,
  rate: 1,
  gain: 1,
  filter: 1,
  loop: null,
};

export function emptySnapshot(deckCount = DECK_COUNT, now = 0): SessionSnapshot {
  return {
    version: 1,
    savedAt: now,
    clean: false,
    activeDeck: 0,
    decks: Array.from({ length: deckCount }, () => ({ ...EMPTY_DECK })),
    libraryTrackIds: [],
    setPlanIds: [],
    ui: { motion: false, mixerOpen: false },
  };
}

const clamp = (value: number, low: number, high: number): number =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;

/** Accepts anything and returns a valid snapshot plus what had to be repaired. */
export function migrateSnapshot(raw: unknown, options: { deckCount?: number; now?: number } = {}): RestoreResult {
  const deckCount = options.deckCount ?? DECK_COUNT;
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { snapshot: null, warnings: ['snapshot is not an object'] };
  }
  const source = raw as Record<string, unknown>;
  const version = typeof source.version === 'number' ? source.version : 0;
  if (version > 1) {
    warnings.push(`snapshot version ${version} is newer than this build understands`);
    return { snapshot: null, warnings };
  }
  if (version === 0) warnings.push('snapshot had no version, migrated as legacy v0');

  const snapshot = emptySnapshot(deckCount, options.now ?? 0);
  snapshot.savedAt = typeof source.savedAt === 'number' ? source.savedAt : 0;
  snapshot.clean = source.clean === true;
  snapshot.activeDeck = Math.trunc(clamp(Number(source.activeDeck ?? 0), 0, deckCount - 1));
  snapshot.libraryTrackIds = Array.isArray(source.libraryTrackIds)
    ? source.libraryTrackIds.filter((id): id is string => typeof id === 'string')
    : [];
  snapshot.setPlanIds = Array.isArray(source.setPlanIds)
    ? source.setPlanIds.filter((id): id is string => typeof id === 'string')
    : [];

  const ui = (source.ui ?? {}) as Record<string, unknown>;
  snapshot.ui = { motion: ui.motion === true, mixerOpen: ui.mixerOpen === true };

  const decks = Array.isArray(source.decks) ? source.decks : [];
  if (decks.length !== deckCount) warnings.push(`expected ${deckCount} decks, got ${decks.length}`);
  for (let index = 0; index < deckCount; index += 1) {
    const candidate = (decks[index] ?? {}) as Record<string, unknown>;
    const raw_rate = Number(candidate.rate ?? 1);
    const rate = clamp(Number.isFinite(raw_rate) ? raw_rate : 1, MIN_RATE, MAX_RATE);
    if (Number.isFinite(raw_rate) && raw_rate !== rate) warnings.push(`deck ${index + 1}: rate ${raw_rate} clamped to ${rate}`);
    const loopSource = candidate.loop as Record<string, unknown> | null | undefined;
    let loop: DeckSnapshot['loop'] = null;
    if (loopSource && typeof loopSource === 'object') {
      const start = Number(loopSource.startSeconds);
      const end = Number(loopSource.endSeconds);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        loop = { startSeconds: Math.max(0, start), endSeconds: end };
      } else {
        warnings.push(`deck ${index + 1}: dropped an invalid loop`);
      }
    }
    snapshot.decks[index] = {
      trackId: typeof candidate.trackId === 'string' ? candidate.trackId : null,
      positionSeconds: Math.max(0, Number(candidate.positionSeconds ?? 0) || 0),
      rate,
      gain: clamp(Number(candidate.gain ?? 1), 0, 1.5),
      filter: clamp(Number(candidate.filter ?? 1), 0, 1),
      loop,
    };
  }
  return { snapshot, warnings };
}

export class SessionStore {
  private storage: SessionStorage;
  private now: () => number;
  private debounceMs: number;
  private deckCount: number;
  private setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private clearTimeoutFn: (handle: unknown) => void;

  private state: SessionSnapshot;
  private dirty = false;
  private timer: unknown = null;
  private writes = 0;

  constructor(storage: SessionStorage, options: SessionStoreOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? 800;
    this.deckCount = options.deckCount ?? DECK_COUNT;
    this.setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.state = emptySnapshot(this.deckCount, this.now());
  }

  get snapshot(): SessionSnapshot {
    return this.state;
  }

  get writeCount(): number {
    return this.writes;
  }

  get hasPendingWrite(): boolean {
    return this.dirty;
  }

  /** Applies a patch to the top-level state and marks it dirty. */
  patch(patch: Partial<Omit<SessionSnapshot, 'version' | 'decks'>>): void {
    // Any change makes the snapshot "dirty work in progress": it only counts as
    // a clean session after markCleanShutdown().
    this.state = { ...this.state, ...patch, version: 1, savedAt: this.now(), clean: false };
    this.touch();
  }

  setDeck(index: number, patch: Partial<DeckSnapshot>): void {
    if (index < 0 || index >= this.deckCount) return;
    const decks = [...this.state.decks];
    decks[index] = { ...decks[index]!, ...patch };
    this.state = { ...this.state, decks, savedAt: this.now(), clean: false };
    this.touch();
  }

  setUi(patch: Partial<SessionUiState>): void {
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch }, savedAt: this.now(), clean: false };
    this.touch();
  }

  /** Debounced write: a slider drag produces one file write, not two hundred. */
  touch(): void {
    this.dirty = true;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.saveNow();
    }, this.debounceMs);
  }

  saveNow(): boolean {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    const payload: SessionSnapshot = { ...this.state, version: 1, savedAt: this.now() };
    try {
      this.storage.save(JSON.stringify(payload));
    } catch {
      return false;
    }
    this.state = payload;
    this.dirty = false;
    this.writes += 1;
    return true;
  }

  /** Marks a deliberate shutdown so the next restore does not warn. */
  markCleanShutdown(): boolean {
    this.state = { ...this.state, clean: true, savedAt: this.now() };
    return this.saveNow();
  }

  restore(): RestoreResult {
    const text = this.storage.load();
    if (text === null) return { snapshot: null, warnings: ['no saved session'] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { snapshot: null, warnings: ['saved session is not valid JSON'] };
    }
    const result = migrateSnapshot(parsed, { deckCount: this.deckCount, now: this.now() });
    if (!result.snapshot) return result;
    if (!result.snapshot.clean) {
      result.warnings.push('previous session ended without a clean shutdown, restored best effort');
    }
    this.state = result.snapshot;
    this.dirty = false;
    return result;
  }

  clear(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.storage.remove();
    this.state = emptySnapshot(this.deckCount, this.now());
    this.dirty = false;
  }
}
