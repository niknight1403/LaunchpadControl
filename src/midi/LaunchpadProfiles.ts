import type { RgbTriplet } from './types';

/**
 * Hardware profiles as *data*.
 *
 * LED index math and control CCs differ between firmware revisions. If a unit
 * disagrees with this table, fix the table: nothing in the driver hard-codes a
 * note number or a CC.
 *
 * Programmer-mode note layout (Launchpad Mini MK3 / X / Pro MK3):
 *   note = (row + 1) * 10 + col + 1, row 0 = bottom-left = note 11, top-right = 88.
 *
 * SysEx lighting (MK3 series):
 *   F0 00 20 29 <model> 03 <type> <led> <r> <g> <b> [<led> <r> <g> <b> ...] F7
 *   type: 0 static, 1 flashing, 2 pulsing.
 */

export type LaunchpadModel = 'mini-mk3' | 'x' | 'pro-mk3';

export interface LaunchpadProfile {
  id: LaunchpadModel;
  label: string;
  /** F0 00 20 29 + model byte. */
  modelByte: number;
  supportsRgb: boolean;
  gridRows: number;
  gridCols: number;
  noteForCell(row: number, col: number): number;
  cellForNote(note: number): { row: number; col: number } | null;
  /** Top row of eight scene/mode buttons. */
  topRowCC: readonly number[];
  /** Right-hand column, top to bottom. */
  rightColumnCC: readonly number[];
  /** Mode select SysEx; harmless if a firmware ignores it. */
  programmerMode: readonly number[];
  liveMode: readonly number[];
}

const NOVATION = 0x00;
const NOVATION_2 = 0x20;
const NOVATION_3 = 0x29;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

function baseProfile(
  id: LaunchpadModel,
  label: string,
  modelByte: number,
  topRowCC: readonly number[],
  rightColumnCC: readonly number[],
): LaunchpadProfile {
  return {
    id,
    label,
    modelByte,
    supportsRgb: true,
    gridRows: 8,
    gridCols: 8,
    noteForCell(row: number, col: number): number {
      return (row + 1) * 10 + col + 1;
    },
    cellForNote(note: number) {
      if (note < 11 || note > 88) return null;
      const row = Math.floor(note / 10) - 1;
      const col = note % 10 - 1;
      if (row < 0 || row > 7 || col < 0 || col > 7) return null;
      return { row, col };
    },
    topRowCC,
    rightColumnCC,
    programmerMode: [SYSEX_START, NOVATION, NOVATION_2, NOVATION_3, modelByte, 0x00, 0x01, SYSEX_END],
    liveMode: [SYSEX_START, NOVATION, NOVATION_2, NOVATION_3, modelByte, 0x00, 0x00, SYSEX_END],
  };
}

/** Top row CCs 104..111 are consistent across the MK3 family. */
const TOP_ROW = [104, 105, 106, 107, 108, 109, 110, 111] as const;

export const PROFILES: Record<LaunchpadModel, LaunchpadProfile> = {
  'mini-mk3': baseProfile('mini-mk3', 'Launchpad Mini MK3', 0x0d, TOP_ROW, [89, 79, 69, 59, 49, 39, 29, 19]),
  x: baseProfile('x', 'Launchpad X', 0x0c, TOP_ROW, [89, 79, 69, 59, 49, 39, 29, 19]),
  'pro-mk3': baseProfile('pro-mk3', 'Launchpad Pro MK3', 0x0f, TOP_ROW, [89, 79, 69, 59, 49, 39, 29, 19]),
};

export const DEFAULT_PROFILE: LaunchpadModel = 'mini-mk3';

/** Fixed SysEx prefix without the terminator: F0 00 20 29 <model>. */
export function sysexPrefix(profile: LaunchpadProfile): number[] {
  return [SYSEX_START, NOVATION, NOVATION_2, NOVATION_3, profile.modelByte];
}

export const SYSEX_TYPE_STATIC = 0x00;
export const SYSEX_TYPE_FLASH = 0x01;
export const SYSEX_TYPE_PULSE = 0x02;

/**
 * Novation's RGB range is 0..127 on the wire, not 0..255.
 * Half of all "my LEDs look washed out" bugs are this one line.
 */
export function toWireChannel(value: number): number {
  const byte = Math.max(0, Math.min(255, Math.round(value)));
  return Math.round((byte / 255) * 127);
}

export function scaleRgb(color: RgbTriplet, factor: number): RgbTriplet {
  const f = Math.max(0, Math.min(1, factor));
  return {
    r: Math.round(color.r * f),
    g: Math.round(color.g * f),
    b: Math.round(color.b * f),
  };
}

/** Perceptually saner than linear scaling for velocity → brightness. */
export function velocityBrightness(velocity: number): number {
  const v = Math.max(0, Math.min(1, velocity));
  return 0.12 + 0.88 * Math.pow(v, 0.65);
}
