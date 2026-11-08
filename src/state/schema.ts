/**
 * Preset/session schema with explicit versioning.
 *
 * Rule: never mutate an old shape. Add a version, write a migration, and keep
 * importing old files working — a set that will not load before a gig is a bug
 * report the size of a career.
 */
import { DECK_IDS, FxParam, type DeckId, type StemId } from '../engine/types';
import type { LaunchpadModel } from '../midi/LaunchpadProfiles';

export const PRESET_SCHEMA_VERSION = 2;

export type SurfaceModeName = 'session' | 'note' | 'fx';

export interface DeckPreset {
  /** 0..3 */
  id: DeckId;
  /** Where the audio came from; null for an empty deck. */
  clipPath: string | null;
  bpm: number;
  gain: number;
  stemGains: Record<StemId, number>;
  filterMode: 'lowpass' | 'highpass';
  /** FX values by parameter name, normalised 0..1. */
  fx: Partial<Record<FxName, number>>;
}

export type FxName =
  | 'filterCutoff'
  | 'filterResonance'
  | 'stutterRate'
  | 'stutterMix'
  | 'delayMix'
  | 'delayFeedback'
  | 'delayDrift'
  | 'drive';

export const FX_NAME_TO_PARAM: Record<FxName, FxParam> = {
  filterCutoff: FxParam.FilterCutoff,
  filterResonance: FxParam.FilterResonance,
  stutterRate: FxParam.StutterRate,
  stutterMix: FxParam.StutterMix,
  delayMix: FxParam.DelayMix,
  delayFeedback: FxParam.DelayFeedback,
  delayDrift: FxParam.DelayDrift,
  drive: FxParam.Drive,
};

export const FX_PARAM_TO_NAME: Record<number, FxName> = Object.fromEntries(
  Object.entries(FX_NAME_TO_PARAM).map(([name, param]) => [param, name as FxName]),
) as Record<number, FxName>;

export interface AgentPreset {
  coPilot: boolean;
  /** 0..1 */
  autonomy: number;
  transitionBars: number;
}

export interface SurfacePreset {
  profile: LaunchpadModel;
  mode: SurfaceModeName;
}

export interface Preset {
  version: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  bpm: number;
  masterGain: number;
  crossfader: number;
  decks: DeckPreset[];
  agent: AgentPreset;
  surface: SurfacePreset;
}

export interface PresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  /** Number of decks that carry a clip. */
  loadedDecks: number;
}

export type ValidationResult =
  | { ok: true; preset: Preset; migrated: boolean }
  | { ok: false; errors: string[] };

const STEM_KEYS: StemId[] = ['drums', 'bass', 'synth', 'vocals'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function emptyPreset(name = 'Neues Preset', now = Date.now()): Preset {
  return {
    version: PRESET_SCHEMA_VERSION,
    id: `preset-${now.toString(36)}`,
    name,
    createdAt: now,
    updatedAt: now,
    bpm: 124,
    masterGain: 0.85,
    crossfader: 0.5,
    decks: DECK_IDS.map((id) => ({
      id,
      clipPath: null,
      bpm: 124,
      gain: 1,
      stemGains: { drums: 1, bass: 1, synth: 1, vocals: 1 },
      filterMode: 'lowpass' as const,
      fx: { filterCutoff: 1, filterResonance: 0.25 },
    })),
    agent: { coPilot: false, autonomy: 0.5, transitionBars: 8 },
    surface: { profile: 'mini-mk3', mode: 'session' },
  };
}

/**
 * v1 → v2: v1 had no `fx` per deck, no `surface` block, and stored
 * `agent.transitionBars` as `transitionLength`. Migration fills defaults.
 */
function migrateV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const decks = Array.isArray(raw.decks) ? raw.decks : [];
  const migratedDecks = decks.map((entry) => {
    const deck = entry as Record<string, unknown>;
    return {
      ...deck,
      fx: deck.fx ?? { filterCutoff: 1, filterResonance: 0.25 },
    };
  });
  const agent = (raw.agent as Record<string, unknown> | undefined) ?? {};
  return {
    ...raw,
    version: 2,
    decks: migratedDecks,
    agent: {
      coPilot: agent.coPilot ?? false,
      autonomy: agent.autonomy ?? 0.5,
      transitionBars: agent.transitionBars ?? agent.transitionLength ?? 8,
    },
    surface: raw.surface ?? { profile: 'mini-mk3', mode: 'session' },
  };
}

/** Validates and migrates anything that claims to be a preset. */
export function parsePreset(input: unknown, now = Date.now()): ValidationResult {
  if (typeof input === 'string') {
    try {
      return parsePreset(JSON.parse(input) as unknown, now);
    } catch {
      return { ok: false, errors: ['not valid JSON'] };
    }
  }
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['preset must be an object'] };
  }

  let raw = input as Record<string, unknown>;
  let migrated = false;

  const version = isFiniteNumber(raw.version) ? raw.version : 1;
  if (version > PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`preset version ${version} is newer than this build (${PRESET_SCHEMA_VERSION})`],
    };
  }
  if (version < 2) {
    raw = migrateV1toV2(raw);
    migrated = true;
  }

  const errors: string[] = [];
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) errors.push('name is required');
  if (!isFiniteNumber(raw.bpm) || raw.bpm < 40 || raw.bpm > 220) errors.push('bpm out of range');

  const rawDecks = Array.isArray(raw.decks) ? raw.decks : [];
  const decks: DeckPreset[] = [];
  for (const id of DECK_IDS) {
    const candidate = rawDecks.find((entry) => (entry as { id?: number })?.id === id) as
      | Record<string, unknown>
      | undefined;
    if (!candidate) {
      errors.push(`deck ${id} missing`);
      continue;
    }
    const stemGains = (candidate.stemGains as Record<string, unknown> | undefined) ?? {};
    const stems = {} as Record<StemId, number>;
    for (const stem of STEM_KEYS) {
      const value = stemGains[stem];
      stems[stem] = isFiniteNumber(value) ? clamp01(value) : 1;
    }
    const fxRaw = (candidate.fx as Record<string, unknown> | undefined) ?? {};
    const fx: Partial<Record<FxName, number>> = {};
    for (const name of Object.keys(FX_NAME_TO_PARAM) as FxName[]) {
      const value = fxRaw[name];
      if (isFiniteNumber(value)) fx[name] = clamp01(value);
    }
    decks.push({
      id,
      clipPath: typeof candidate.clipPath === 'string' ? candidate.clipPath : null,
      bpm: isFiniteNumber(candidate.bpm) ? candidate.bpm : 124,
      gain: isFiniteNumber(candidate.gain) ? clamp01(candidate.gain) : 1,
      stemGains: stems,
      filterMode: candidate.filterMode === 'highpass' ? 'highpass' : 'lowpass',
      fx,
    });
  }

  const agentRaw = (raw.agent as Record<string, unknown> | undefined) ?? {};
  const surfaceRaw = (raw.surface as Record<string, unknown> | undefined) ?? {};
  const profile = surfaceRaw.profile;
  const mode = surfaceRaw.mode;

  const preset: Preset = {
    version: PRESET_SCHEMA_VERSION,
    id: typeof raw.id === 'string' ? raw.id : `preset-${now.toString(36)}`,
    name: typeof raw.name === 'string' ? raw.name : 'Unbenannt',
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : now,
    bpm: isFiniteNumber(raw.bpm) ? raw.bpm : 124,
    masterGain: isFiniteNumber(raw.masterGain) ? clamp01(raw.masterGain) : 0.85,
    crossfader: isFiniteNumber(raw.crossfader) ? clamp01(raw.crossfader) : 0.5,
    decks,
    agent: {
      coPilot: agentRaw.coPilot === true,
      autonomy: isFiniteNumber(agentRaw.autonomy) ? clamp01(agentRaw.autonomy) : 0.5,
      transitionBars: isFiniteNumber(agentRaw.transitionBars) ? Math.max(1, agentRaw.transitionBars) : 8,
    },
    surface: {
      profile: profile === 'x' || profile === 'pro-mk3' ? profile : 'mini-mk3',
      mode: mode === 'note' || mode === 'fx' ? mode : 'session',
    },
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, preset, migrated };
}

export function summarise(preset: Preset): PresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    loadedDecks: preset.decks.filter((deck) => deck.clipPath !== null).length,
  };
}
