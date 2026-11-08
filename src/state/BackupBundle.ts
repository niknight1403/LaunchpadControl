/**
 * Backup bundle: everything the app knows, in one file you can carry.
 *
 * Presets, the track library, set plans and MIDI mappings live in different stores
 * with different shapes. Losing them to a reinstall is the most expensive kind of
 * bug, so this module packs them into one JSON document with a version and a
 * checksum, and merges a foreign bundle back in by id instead of overwriting
 * everything the user has done since.
 */

export interface BundleSection<T> {
  /** Records by id, so merging is possible at all. */
  items: Record<string, T>;
  /** Deleted ids, so a merge does not resurrect something the user removed. */
  deleted?: string[];
}

export interface BackupBundle {
  version: 1;
  createdAt: number;
  app: string;
  /** Cheap integrity check; see `checksumOf`. */
  checksum: string;
  counts: { presets: number; tracks: number; setPlans: number; mappings: number };
  data: {
    presets: BundleSection<Record<string, unknown>>;
    tracks: BundleSection<Record<string, unknown>>;
    setPlans: BundleSection<Record<string, unknown>>;
    mappings: BundleSection<Record<string, unknown>>;
  };
}

export interface BackupInput {
  presets?: Record<string, Record<string, unknown>>;
  tracks?: Record<string, Record<string, unknown>>;
  setPlans?: Record<string, Record<string, unknown>>;
  mappings?: Record<string, Record<string, unknown>>;
  deleted?: Partial<Record<'presets' | 'tracks' | 'setPlans' | 'mappings', string[]>>;
  createdAt: number;
  app?: string;
}

export interface MergeReport {
  added: string[];
  replaced: string[];
  skipped: string[];
  /** Ids the incoming bundle had marked as deleted; removed locally too. */
  removed: string[];
  warnings: string[];
}

export type SectionName = 'presets' | 'tracks' | 'setPlans' | 'mappings';

const SECTIONS: SectionName[] = ['presets', 'tracks', 'setPlans', 'mappings'];

/**
 * 32-bit FNV-1a over the canonical JSON.
 *
 * Not a security hash and not meant to be: it catches a truncated download, a bad
 * copy and a hand-edited file, which is what actually happens to a backup.
 */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Deterministic JSON: keys sorted, so the checksum is stable across runs. */
export function canonicalJson(value: unknown): string {
  const build = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null';
    if (Array.isArray(input)) return `[${input.map(build).join(',')}]`;
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${build(item)}`).join(',')}}`;
  };
  return build(value);
}

function sectionOf<T>(items: Record<string, T>, deleted: string[]): BundleSection<T> {
  return deleted.length > 0 ? { items, deleted } : { items };
}

export function createBundle(input: BackupInput): BackupBundle {
  const presets = input.presets ?? {};
  const tracks = input.tracks ?? {};
  const setPlans = input.setPlans ?? {};
  const mappings = input.mappings ?? {};
  const deleted = input.deleted ?? {};

  const withoutChecksum = {
    version: 1 as const,
    createdAt: input.createdAt,
    app: input.app ?? 'AuraGrid',
    counts: {
      presets: Object.keys(presets).length,
      tracks: Object.keys(tracks).length,
      setPlans: Object.keys(setPlans).length,
      mappings: Object.keys(mappings).length,
    },
    data: {
      presets: sectionOf(presets, deleted.presets ?? []),
      tracks: sectionOf(tracks, deleted.tracks ?? []),
      setPlans: sectionOf(setPlans, deleted.setPlans ?? []),
      mappings: sectionOf(mappings, deleted.mappings ?? []),
    },
  };
  const checksum = checksumOf(canonicalJson(withoutChecksum));
  return { ...withoutChecksum, checksum };
}

export interface VerifyResult {
  ok: boolean;
  warnings: string[];
  bundle: BackupBundle | null;
}

/** Parses and checks a bundle. Never throws on bad input. */
export function verifyBundle(text: string): VerifyResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, warnings: ['backup is not valid JSON'], bundle: null };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, warnings: ['backup is not an object'], bundle: null };
  const candidate = parsed as Record<string, unknown>;
  const version = typeof candidate.version === 'number' ? candidate.version : 0;
  if (version !== 1) {
    return { ok: false, warnings: [`unsupported backup version ${version}`], bundle: null };
  }
  const data = candidate.data as Record<string, BundleSection<Record<string, unknown>>> | undefined;
  if (!data) return { ok: false, warnings: ['backup has no data section'], bundle: null };

  const recomputed = checksumOf(
    canonicalJson({
      version: 1,
      createdAt: candidate.createdAt,
      app: candidate.app,
      counts: candidate.counts,
      data,
    }),
  );
  if (recomputed !== candidate.checksum) {
    warnings.push(`checksum mismatch: expected ${String(candidate.checksum)}, computed ${recomputed}`);
    return { ok: false, warnings, bundle: null };
  }

  const bundle = candidate as unknown as BackupBundle;
  for (const name of SECTIONS) {
    const section = bundle.data[name];
    if (!section || typeof section !== 'object') {
      warnings.push(`section "${name}" is missing and was treated as empty`);
      bundle.data[name] = { items: {} };
      continue;
    }
    if (typeof section.items !== 'object' || section.items === null) {
      warnings.push(`section "${name}" has no items and was treated as empty`);
      bundle.data[name] = { items: {} };
    }
  }
  return { ok: true, warnings, bundle };
}

export interface MergeOptions {
  /** When both sides have the same id, which copy wins. */
  prefer?: 'local' | 'incoming' | 'newest';
}

/**
 * Merges an incoming bundle into local data by id.
 *
 * `newest` compares `updated_date`-ish fields when they look like timestamps and
 * falls back to keeping the local copy: silently overwriting a newer local edit is
 * the one outcome a backup restore must never produce.
 */
export function mergeBundle(
  local: Partial<Record<SectionName, Record<string, Record<string, unknown>>>>,
  incoming: BackupBundle,
  options: MergeOptions = {},
): { merged: Record<SectionName, Record<string, Record<string, unknown>>>; report: MergeReport } {
  const prefer = options.prefer ?? 'newest';
  const report: MergeReport = { added: [], replaced: [], skipped: [], removed: [], warnings: [] };
  const merged = {} as Record<SectionName, Record<string, Record<string, unknown>>>;

  for (const name of SECTIONS) {
    const target: Record<string, Record<string, unknown>> = { ...(local[name] ?? {}) };
    const section = incoming.data[name];
    const deleted = section.deleted ?? [];
    for (const id of deleted) {
      if (target[id] !== undefined) {
        delete target[id];
        report.removed.push(`${name}:${id}`);
      }
    }
    for (const [id, value] of Object.entries(section.items ?? {})) {
      const existing = target[id];
      if (existing === undefined) {
        target[id] = value;
        report.added.push(`${name}:${id}`);
        continue;
      }
      const takeIncoming =
        prefer === 'incoming' ||
        (prefer === 'newest' && timestampOf(value) > timestampOf(existing));
      if (takeIncoming) {
        target[id] = value;
        report.replaced.push(`${name}:${id}`);
      } else {
        report.skipped.push(`${name}:${id}`);
      }
    }
    merged[name] = target;
  }
  return { merged, report };
}

function timestampOf(record: Record<string, unknown>): number {
  for (const key of ['updated_date', 'updatedAt', 'modifiedAt', 'savedAt', 'created_date', 'createdAt']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

/** Human summary for the restore dialog. */
export function describeMerge(report: MergeReport): string {
  return [
    `${report.added.length} neu`,
    `${report.replaced.length} ersetzt`,
    `${report.skipped.length} behalten`,
    `${report.removed.length} entfernt`,
  ].join(', ');
}

export function describeBundleSize(bundle: BackupBundle): string {
  const bytes = new TextEncoder().encode(JSON.stringify(bundle)).length;
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}
