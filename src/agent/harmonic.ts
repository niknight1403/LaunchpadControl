/**
 * Harmonic utilities: Camelot wheel, compatibility scoring, key estimation.
 *
 * All functions are pure. The agent uses them to decide what to blend next;
 * they are also unit-testable without audio hardware.
 */

export type PitchClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export type KeyMode = 'major' | 'minor';

export interface MusicalKey {
  /** 0 = C … 11 = B */
  root: PitchClass;
  mode: KeyMode;
  /** Camelot code, e.g. "8A". */
  camelot: string;
  /** Human label, e.g. "C min". */
  label: string;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Camelot number per pitch class, major (B) side. */
const MAJOR_CAMELOT: readonly number[] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
/** Camelot number per pitch class, minor (A) side. */
const MINOR_CAMELOT: readonly number[] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export function makeKey(root: PitchClass, mode: KeyMode): MusicalKey {
  const number = mode === 'major' ? MAJOR_CAMELOT[root] : MINOR_CAMELOT[root];
  const suffix = mode === 'major' ? 'B' : 'A';
  return {
    root,
    mode,
    camelot: `${number}${suffix}`,
    label: `${NOTE_NAMES[root]} ${mode === 'major' ? 'maj' : 'min'}`,
  };
}

export function parseCamelot(code: string): { number: number; letter: 'A' | 'B' } | null {
  const match = /^(\d{1,2})\s*([ABab])$/.exec(code.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 1 || number > 12) return null;
  return { number, letter: (match[2]?.toUpperCase() as 'A' | 'B') ?? 'A' };
}

export function keyFromCamelot(code: string): MusicalKey | null {
  const parsed = parseCamelot(code);
  if (!parsed) return null;
  const mode: KeyMode = parsed.letter === 'B' ? 'major' : 'minor';
  const table = mode === 'major' ? MAJOR_CAMELOT : MINOR_CAMELOT;
  const root = table.indexOf(parsed.number);
  if (root < 0) return null;
  return makeKey(root as PitchClass, mode);
}

/** Semitone distance, always the shorter direction (0..6). */
export function semitoneDistance(a: PitchClass, b: PitchClass): number {
  const raw = Math.abs(a - b) % 12;
  return raw > 6 ? 12 - raw : raw;
}

/**
 * Camelot compatibility 0..1.
 *  1.00 same code            8A → 8A
 *  0.95 relative major/minor 8A → 8B
 *  0.90 energy neighbour     8A → 9A / 7A
 *  0.70 two-step neighbour   8A → 10A / 6A
 *  0.55 diagonal             8A → 9B / 7B
 *  else fall back to a semitone-distance curve (mixing out of key is allowed,
 *  it just costs a little).
 */
export function harmonicCompatibility(from: MusicalKey, to: MusicalKey): number {
  const a = parseCamelot(from.camelot);
  const b = parseCamelot(to.camelot);
  if (a && b) {
    const distance = Math.min(
      Math.abs(a.number - b.number),
      12 - Math.abs(a.number - b.number),
    );
    if (distance === 0 && a.letter === b.letter) return 1;
    if (distance === 0) return 0.95;
    if (a.letter === b.letter) {
      if (distance === 1) return 0.9;
      if (distance === 2) return 0.7;
      if (distance === 7) return 0.65; // classic +7 "energy boost"
    } else if (distance === 1) {
      return 0.55;
    }
  }
  const steps = semitoneDistance(from.root, to.root);
  return Math.max(0.15, 0.5 - steps * 0.06);
}

/** Reasons that read well in the UI, not just numbers. */
export function describeKeyMove(from: MusicalKey, to: MusicalKey): string {
  const score = harmonicCompatibility(from, to);
  const a = parseCamelot(from.camelot);
  const b = parseCamelot(to.camelot);
  if (!a || !b) return `${from.camelot} → ${to.camelot}`;
  if (a.number === b.number && a.letter === b.letter) return 'gleiche Tonart, nahtlos';
  if (a.number === b.number) return 'relatives Dur/Moll, sehr weich';
  const distance = Math.min(Math.abs(a.number - b.number), 12 - Math.abs(a.number - b.number));
  if (a.letter === b.letter && distance === 1) return 'Energie-Schritt auf dem Camelot-Rad';
  if (a.letter === b.letter && distance === 2) return 'zwei Schritte, spürbarer Move';
  if (a.letter !== b.letter && distance === 1) return 'diagonaler Move, bewusst setzen';
  return `weite Modulation (Score ${score.toFixed(2)})`;
}

/**
 * Krumhansl-Schmuckler key profiles (Krumhansl & Kessler 1982).
 * Feed a 12-bin chroma vector, get the most likely key.
 */
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

export interface KeyEstimate extends MusicalKey {
  /** Pearson correlation of the winning rotation, 0..1. */
  confidence: number;
}

export function estimateKey(chroma: readonly number[]): KeyEstimate | null {
  if (chroma.length !== 12) return null;
  let best: KeyEstimate | null = null;
  for (let root = 0; root < 12; root += 1) {
    const rotated = chroma.map((_, index) => chroma[(index + root) % 12] ?? 0);
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const correlation = pearson(rotated, profile);
      if (!best || correlation > best.confidence) {
        const key = makeKey(root as PitchClass, mode);
        best = { ...key, confidence: Math.max(0, Math.min(1, correlation)) };
      }
    }
  }
  return best;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i] ?? 0;
    sumB += b[i] ?? 0;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/**
 * Tempo compatibility 0..1, half/double time aware.
 * A 87 BPM track mixes fine with a 174 BPM track; DJs do it every night.
 */
export function tempoMatchScore(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const candidates = [b, b / 2, b * 2];
  let best = 0;
  for (const candidate of candidates) {
    const delta = Math.abs(a - candidate) / a;
    const score = Math.max(0, 1 - delta * 6); // 1 % off ≈ 0.94, 10 % off ≈ 0.4
    if (score > best) best = score;
  }
  return best;
}

/** Nudge needed to beatmatch `from` onto `to` in percent of `from`. */
export function requiredTempoShift(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  const options = [to, to / 2, to * 2];
  let bestShift = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const shift = (option - from) / from;
    if (Math.abs(shift) < Math.abs(bestShift)) bestShift = shift;
  }
  return Math.round(bestShift * 1000) / 1000;
}

/** The four moves a DJ actually makes, in priority order. */
export function nextKeyCandidates(key: MusicalKey): { key: MusicalKey; score: number; reason: string }[] {
  const parsed = parseCamelot(key.camelot);
  if (!parsed) return [];
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  const codes = [
    `${parsed.number}${parsed.letter}`,
    `${parsed.number}${parsed.letter === 'A' ? 'B' : 'A'}`,
    `${wrap(parsed.number + 1)}${parsed.letter}`,
    `${wrap(parsed.number - 1)}${parsed.letter}`,
    `${wrap(parsed.number + 2)}${parsed.letter}`,
  ];
  const seen = new Set<string>();
  const result: { key: MusicalKey; score: number; reason: string }[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const candidate = keyFromCamelot(code);
    if (!candidate) continue;
    result.push({
      key: candidate,
      score: harmonicCompatibility(key, candidate),
      reason: describeKeyMove(key, candidate),
    });
  }
  return result.sort((left, right) => right.score - left.score);
}
