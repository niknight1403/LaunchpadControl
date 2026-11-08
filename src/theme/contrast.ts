/**
 * Contrast: readable on a dark stage and in daylight.
 *
 * The AuraGrid palette is deliberately dark, and a dark palette is where contrast
 * quietly breaks: the "muted" grey that looks fine on a laptop screen is unreadable
 * on a phone held at an angle in a club. These are WCAG relative-luminance and
 * contrast-ratio calculations, plus a repair function the theme tests use.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses #rgb, #rrggbb and #rrggbbaa (alpha ignored for contrast purposes). */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, '');
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return null;
  const expand = (input: string): string =>
    input.length === 3 || input.length === 4
      ? input
          .slice(0, 3)
          .split('')
          .map((character) => character + character)
          .join('')
      : input.slice(0, 6);
  const full = expand(value);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb | string): number {
  const rgb = typeof color === 'string' ? parseHex(color) : color;
  if (!rgb) return 0;
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: Rgb | string, background: Rgb | string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export type TextSize = 'normal' | 'large';

/** WCAG AA minimum: 4.5 for body text, 3 for large text and UI shapes. */
export function minimumRatio(size: TextSize = 'normal'): number {
  return size === 'large' ? 3 : 4.5;
}

export interface ContrastReport {
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  passes: boolean;
  size: TextSize;
}

export function checkContrast(foreground: string, background: string, size: TextSize = 'normal'): ContrastReport {
  const ratio = contrastRatio(foreground, background);
  const required = minimumRatio(size);
  return { foreground, background, ratio, required, passes: ratio >= required, size };
}

/**
 * Repairs a pair that fails, by moving the foreground towards white or black.
 *
 * Used by the theme test rather than at runtime: if a token pair needs repair, the
 * token is wrong and should be fixed in the palette.
 */
export function repairContrast(foreground: string, background: string, size: TextSize = 'normal'): { color: string; report: ContrastReport } {
  const required = minimumRatio(size);
  if (contrastRatio(foreground, background) >= required) {
    return { color: foreground, report: checkContrast(foreground, background, size) };
  }
  const start = parseHex(foreground);
  const target = relativeLuminance(background) < 0.5 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  if (!start) return { color: toHex(target), report: checkContrast(toHex(target), background, size) };

  // Binary search on the mix towards the target: 20 steps is well below one
  // 8-bit step of visible difference and terminates in a deterministic colour.
  let low = 0;
  let high = 1;
  let best = toHex(target);
  for (let step = 0; step < 20; step += 1) {
    const mid = (low + high) / 2;
    const candidate = toHex({
      r: start.r + (target.r - start.r) * mid,
      g: start.g + (target.g - start.g) * mid,
      b: start.b + (target.b - start.b) * mid,
    });
    if (contrastRatio(candidate, background) >= required) {
      best = candidate;
      high = mid;
    } else {
      low = mid;
    }
  }
  return { color: best, report: checkContrast(best, background, size) };
}

/** The palette pairs the app actually renders, for the theme test. */
export interface PalettePair {
  name: string;
  foreground: string;
  background: string;
  size: TextSize;
}

export function auditPalette(pairs: readonly PalettePair[]): { failures: ContrastReport[]; worst: ContrastReport | null } {
  const reports = pairs.map((pair) => checkContrast(pair.foreground, pair.background, pair.size));
  const failures = reports.filter((report) => !report.passes);
  const worst = reports.reduce<ContrastReport | null>(
    (lowest, report) => (lowest === null || report.ratio < lowest.ratio ? report : lowest),
    null,
  );
  return { failures, worst };
}
