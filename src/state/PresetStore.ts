import type { AudioEngine } from '../engine/AudioEngine';
import { DECK_IDS, type DeckId } from '../engine/types';
import {
  FX_NAME_TO_PARAM,
  PRESET_SCHEMA_VERSION,
  emptyPreset,
  parsePreset,
  summarise,
  type DeckPreset,
  type FxName,
  type Preset,
  type PresetSummary,
  FX_PARAM_TO_NAME,
} from './schema';

/** Storage is injected: AsyncStorage on device, memory in tests, FS for export. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory adapter — used by the tests and by the desktop simulator. */
export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key) ?? null : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface PresetStoreOptions {
  namespace?: string;
  /** Autosave debounce. Long enough not to hammer storage, short enough to survive a crash. */
  autosaveMs?: number;
  now?: () => number;
}

const INDEX_KEY = 'index';

/**
 * Preset store.
 *
 * Persists an index plus one record per preset, so saving a preset never
 * rewrites the whole library. Autosave is debounced and coalesced: a filter
 * sweep produces hundreds of state changes per bar and none of them deserve a
 * disk write.
 */
export class PresetStore {
  private storage: StorageAdapter;
  private namespace: string;
  private autosaveMs: number;
  private now: () => number;

  private presets = new Map<string, Preset>();
  private order: string[] = [];
  private loaded = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: (() => Preset) | null = null;
  private lastError: string | null = null;

  constructor(storage: StorageAdapter, options: PresetStoreOptions = {}) {
    this.storage = storage;
    this.namespace = options.namespace ?? `auragrid.presets.v${PRESET_SCHEMA_VERSION}`;
    this.autosaveMs = options.autosaveMs ?? 1_500;
    this.now = options.now ?? (() => Date.now());
  }

  /** Loads the index and all records. Corrupt entries are skipped, not thrown. */
  async load(): Promise<void> {
    this.presets.clear();
    this.order = [];
    const rawIndex = await this.storage.getItem(this.key(INDEX_KEY));
    if (rawIndex === null) {
      this.loaded = true;
      return;
    }
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(rawIndex) as unknown;
      ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const raw = await this.storage.getItem(this.key(id));
      if (raw === null) continue;
      const result = parsePreset(raw, this.now());
      if (result.ok) {
        this.presets.set(result.preset.id, result.preset);
        this.order.push(result.preset.id);
      } else {
        this.lastError = `preset ${id}: ${result.errors.join(', ')}`;
      }
    }
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get lastLoadError(): string | null {
    return this.lastError;
  }

  list(): PresetSummary[] {
    return this.order
      .map((id) => this.presets.get(id))
      .filter((preset): preset is Preset => preset !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(summarise);
  }

  get(id: string): Preset | undefined {
    return this.presets.get(id);
  }

  async save(preset: Preset): Promise<Preset> {
    const validated = parsePreset({ ...preset, version: PRESET_SCHEMA_VERSION, updatedAt: this.now() }, this.now());
    if (!validated.ok) throw new Error(`preset invalid: ${validated.errors.join(', ')}`);
    const record = validated.preset;
    this.presets.set(record.id, record);
    if (!this.order.includes(record.id)) this.order.push(record.id);
    await this.storage.setItem(this.key(record.id), JSON.stringify(record));
    await this.storage.setItem(this.key(INDEX_KEY), JSON.stringify(this.order));
    return record;
  }

  async delete(id: string): Promise<void> {
    this.presets.delete(id);
    this.order = this.order.filter((entry) => entry !== id);
    await this.storage.removeItem(this.key(id));
    await this.storage.setItem(this.key(INDEX_KEY), JSON.stringify(this.order));
  }

  /** Debounced autosave of a live snapshot; call it on any state change. */
  scheduleAutosave(snapshot: () => Preset): void {
    this.pendingSnapshot = snapshot;
    if (this.autosaveTimer !== null) return;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      const take = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (!take) return;
      void this.save(take()).catch(() => undefined);
    }, this.autosaveMs);
  }

  /** Forces the pending autosave out. Call it on app background / deck close. */
  async flush(): Promise<void> {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    const take = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (take) await this.save(take());
  }

  /** Serialises one preset for a file export. */
  export(preset: Preset): string {
    return JSON.stringify(preset, null, 2);
  }

  /** Parses an imported file, migrating old versions. Throws with a usable message. */
  import(json: string): Preset {
    const result = parsePreset(json, this.now());
    if (!result.ok) throw new Error(`Import fehlgeschlagen: ${result.errors.join(', ')}`);
    return result.preset;
  }

  /** Snapshots the live engine into a preset. */
  captureFromEngine(
    engine: AudioEngine,
    options: {
      name?: string;
      id?: string;
      clipPaths?: Partial<Record<DeckId, string | null>>;
      agent?: Partial<Preset['agent']>;
      surface?: Partial<Preset['surface']>;
      now?: number;
    } = {},
  ): Preset {
    const timestamp = options.now ?? this.now();
    const base = emptyPreset(options.name ?? 'Live-Snapshot', timestamp);
    const preset: Preset = {
      ...base,
      id: options.id ?? base.id,
      bpm: engine.currentBpm,
      masterGain: engine.masterGainValue,
      crossfader: engine.crossfaderValue,
      decks: DECK_IDS.map((id) => captureDeck(engine, id, options.clipPaths?.[id] ?? null)),
      agent: { ...base.agent, ...(options.agent ?? {}) },
      surface: { ...base.surface, ...(options.surface ?? {}) },
    };
    return preset;
  }

  /** Applies a preset to the engine. Missing clips are skipped, not fatal. */
  applyToEngine(engine: AudioEngine, preset: Preset): { appliedDecks: number; skippedDecks: DeckId[] } {
    engine.setBpm(preset.bpm);
    engine.setMasterGain(preset.masterGain);
    engine.setCrossfader(preset.crossfader);

    const skipped: DeckId[] = [];
    for (const deck of preset.decks) {
      const state = engine.getDeckState(deck.id);
      if (!state) continue;

      if (deck.clipPath) {
        try {
          engine.loadClip(deck.id, deck.clipPath, deck.bpm);
        } catch {
          skipped.push(deck.id);
        }
      }
      engine.setDeckGain(deck.id, deck.gain);
      for (const stem of ['drums', 'bass', 'synth', 'vocals'] as const) {
        engine.setStemGain(deck.id, stem, deck.stemGains[stem]);
      }
      engine.setFilterMode(deck.id, deck.filterMode);
      for (const [name, value] of Object.entries(deck.fx) as [FxName, number | undefined][]) {
        if (typeof value === 'number') engine.setFx(deck.id, FX_NAME_TO_PARAM[name], value);
      }
    }
    return { appliedDecks: preset.decks.length - skipped.length, skippedDecks: skipped };
  }

  private key(id: string): string {
    return `${this.namespace}.${id}`;
  }
}

function captureDeck(engine: AudioEngine, deck: DeckId, clipPath: string | null): DeckPreset {
  const state = engine.getDeckState(deck);
  const fx: Partial<Record<FxName, number>> = {};
  if (state) {
    for (const [param, value] of Object.entries(state.fx)) {
      const name = FX_PARAM_TO_NAME[Number(param)];
      if (name) fx[name] = value;
    }
  }
  return {
    id: deck,
    clipPath,
    bpm: state?.bpm ?? engine.currentBpm,
    gain: state?.gain ?? 1,
    stemGains: state ? { ...state.stemGains } : { drums: 1, bass: 1, synth: 1, vocals: 1 },
    filterMode: state?.filterMode ?? 'lowpass',
    fx,
  };
}

export type { Preset, PresetSummary };
