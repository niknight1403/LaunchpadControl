/**
 * Cyber-neon OLED design tokens.
 * Import these everywhere; no component defines a raw hex value.
 */

export const aura = {
  color: {
    /** Pitch black OLED base. Kept at #0B0F19, not #000: bleeding pixels look cheap. */
    oled: '#0B0F19',
    surface: '#161C2E',
    surfaceRaised: '#1E2740',
    /** 60% opacity glass over the OLED base. */
    glass: 'rgba(22, 28, 46, 0.6)',
    border: 'rgba(255, 255, 255, 0.08)',
    borderStrong: 'rgba(0, 242, 254, 0.35)',
    cyan: '#00F2FE',
    pink: '#FF007F',
    green: '#39FF14',
    amber: '#FFB020',
    text: '#E8EDF7',
    textDim: '#8A96B2',
    textFaint: '#556078',
  },
  radius: { sm: 6, md: 12, lg: 18, xl: 26 },
  space: { xs: 4, sm: 8, md: 12, lg: 18, xl: 26 },
  font: {
    mono: 'monospace',
    sizes: { micro: 10, small: 12, body: 14, title: 18, display: 28 },
  },
  /** Pad indicator states, mapped straight onto Launchpad LED colours. */
  pad: {
    idle: { r: 14, g: 20, b: 34 },
    loaded: { r: 0, g: 90, b: 120 },
    playing: { r: 0, g: 242, b: 254 },
    queued: { r: 255, g: 0, b: 127 },
    warning: { r: 255, g: 176, b: 32 },
    agent: { r: 57, g: 255, b: 20 },
  },
  motion: {
    fast: 90,
    normal: 180,
    slow: 320,
  },
} as const;

export type AuraPadState = keyof typeof aura.pad;

/** Hex helper for RN styles; the LED path uses the numeric triplet instead. */
export function rgbHex(triplet: { r: number; g: number; b: number }): string {
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${hex(triplet.r)}${hex(triplet.g)}${hex(triplet.b)}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${value}`;
}
