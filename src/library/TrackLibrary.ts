import { harmonicCompatibility, keyFromCamelot, makeKey, tempoMatchScore, type MusicalKey } from '../agent/harmonic';
import type { Track } from '../agent/AuraGridAgent';
import { quantiseBpm } from '../analysis/beat';
import type { StorageAdapter } from '../state/PresetStore';

export interface TrackRecord {
  id: string;
  title: string;
  artist: string;
  /** Path or content URI the engine can load. */
  path: string;
  bpm: number;
  /** Camelot code, e.g. "8A". Empty when unknown. */
  camelot: string;
  durationSeconds: number;
  /** 0..1 perceived energy, drives the agent's arc. */
  energy: number;
  tags: string[];
  addedAt: number;
  /** Set once the offline analysis pass has run. */
  analysed: boolean;
}

export interface TrackQuery {
  text?: string;
  minBpm?: number;
  maxBpm?: number;
  camelot?: string;
  minEnergy?: number;
  analysedOnly?: boolean;
}

export interface SimilarTrack {
  track: TrackRecord;
  score: number;
  harmonicScore: number;
  tempoScore: number;
}

const STORAGE_KEY = 'auragrid.library.v1';

/**
 * Track library: the agent's raw material.
 *
 * Records are deduplicated by path (phones hand out the same file through
 * several URIs) and keyed by a stable id so a re-analysis updates a record
 * instead of cloning it.
 */
export class TrackLibrary {
  private records = new Map<string, TrackRecord>();
  private storage: StorageAdapter | null;
  private now: () => number;
  private dirty = false;

  constructor(storage: StorageAdapter | null = null, options: { now?: () => number } = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (!this.storage) return;
    const raw = await this.storage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      this.records.clear();
      for (const entry of parsed) {
        const record = normalise(entry);
        if (record) this.records.set(record.id, record);
      }
    } catch {
      // A corrupt library must not brick the app: start empty, keep the file.
      this.records.clear();
    }
  }

  async persist(): Promise<void> {
    if (!this.storage || !this.dirty) return;
    await this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.records.values()]));
    this.dirty = false;
  }

  get size(): number {
    return this.records.size;
  }

  all(): TrackRecord[] {
    return [...this.records.values()].sort((left, right) => left.title.localeCompare(right.title));
  }

  get(id: string): TrackRecord | undefined {
    return this.records.get(id);
  }

  findByPath(path: string): TrackRecord | undefined {
    return [...this.records.values()].find((record) => record.path === path);
  }

  add(
    input: Omit<TrackRecord, 'id' | 'addedAt' | 'analysed' | 'energy' | 'tags' | 'camelot' | 'artist'> &
      Partial<Pick<TrackRecord, 'id' | 'addedAt' | 'analysed' | 'energy' | 'tags' | 'camelot' | 'artist'>>,
  ): TrackRecord {
    const existing = this.findByPath(input.path);
    const timestamp = input.addedAt ?? this.now();
    const record: TrackRecord = {
      id: input.id ?? existing?.id ?? `track-${timestamp.toString(36)}-${this.records.size}`,
      title: input.title || 'Unbenannt',
      // An upsert must not wipe metadata it was not given: re-adding a file
      // after a rename would otherwise lose the artist every time.
      artist: input.artist ?? existing?.artist ?? '',
      path: input.path,
      bpm: quantiseBpm(input.bpm),
      camelot: input.camelot ?? existing?.camelot ?? '',
      durationSeconds: Math.max(0, input.durationSeconds ?? existing?.durationSeconds ?? 0),
      energy: clamp01(input.energy ?? existing?.energy ?? 0.5),
      tags: input.tags ?? existing?.tags ?? [],
      addedAt: timestamp,
      analysed: input.analysed ?? false,
    };
    this.records.set(record.id, record);
    this.dirty = true;
    return record;
  }

  /** Writes back the result of the offline analysis pass. */
  applyAnalysis(
    id: string,
    analysis: { bpm?: number; camelot?: string; durationSeconds?: number; energy?: number },
  ): TrackRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const updated: TrackRecord = {
      ...record,
      bpm: analysis.bpm !== undefined ? quantiseBpm(analysis.bpm) : record.bpm,
      camelot: analysis.camelot ?? record.camelot,
      durationSeconds: analysis.durationSeconds ?? record.durationSeconds,
      energy: analysis.energy !== undefined ? clamp01(analysis.energy) : record.energy,
      analysed: true,
    };
    this.records.set(id, updated);
    this.dirty = true;
    return updated;
  }

  remove(id: string): boolean {
    const removed = this.records.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  query(filter: TrackQuery): TrackRecord[] {
    const text = filter.text?.trim().toLowerCase();
    return this.all().filter((record) => {
      if (filter.minBpm !== undefined && record.bpm < filter.minBpm) return false;
      if (filter.maxBpm !== undefined && record.bpm > filter.maxBpm) return false;
      if (filter.camelot && record.camelot !== filter.camelot) return false;
      if (filter.minEnergy !== undefined && record.energy < filter.minEnergy) return false;
      if (filter.analysedOnly && !record.analysed) return false;
      if (text) {
        const haystack = `${record.title} ${record.artist} ${record.tags.join(' ')}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  /** Ranked candidates against one record, using the same maths as the agent. */
  similar(id: string, limit = 5): SimilarTrack[] {
    const source = this.records.get(id);
    if (!source) return [];
    const sourceKey = recordToKey(source);
    return this.all()
      .filter((record) => record.id !== id)
      .map((record) => {
        const harmonicScore = sourceKey ? harmonicCompatibility(sourceKey, recordToKey(record) ?? sourceKey) : 0.3;
        const tempoScore = tempoMatchScore(source.bpm, record.bpm);
        return {
          track: record,
          harmonicScore: round(harmonicScore),
          tempoScore: round(tempoScore),
          score: round(harmonicScore * 0.6 + tempoScore * 0.4),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /** Converts a record into the shape the agent and the engine work with. */
  toAgentTrack(record: TrackRecord): Track {
    const key = recordToKey(record) ?? makeKey(9, 'minor');
    return {
      id: record.id,
      title: record.title,
      artist: record.artist,
      path: record.path,
      bpm: record.bpm,
      key,
      energy: record.energy,
    };
  }

  /** Everything the agent needs, as agent tracks. */
  toAgentTracks(filter: TrackQuery = {}): Track[] {
    return this.query(filter).map((record) => this.toAgentTrack(record));
  }

  clear(): void {
    if (this.records.size > 0) this.dirty = true;
    this.records.clear();
  }
}

export function recordToKey(record: TrackRecord): MusicalKey | null {
  if (!record.camelot) return null;
  return keyFromCamelot(record.camelot);
}

function normalise(input: unknown): TrackRecord | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.length === 0) return null;
  const bpm = typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm > 0 ? raw.bpm : 120;
  return {
    id: typeof raw.id === 'string' ? raw.id : `track-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof raw.title === 'string' ? raw.title : 'Unbenannt',
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    path: raw.path,
    bpm,
    camelot: typeof raw.camelot === 'string' ? raw.camelot : '',
    durationSeconds: typeof raw.durationSeconds === 'number' ? raw.durationSeconds : 0,
    energy: clamp01(typeof raw.energy === 'number' ? raw.energy : 0.5),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
    analysed: raw.analysed === true,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
