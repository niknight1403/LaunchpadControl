import { encodeWav } from './WavWriter';

/**
 * Post-processing and export for a finished take.
 *
 * A recorded set is raw: too quiet at the start, a conversation in the middle,
 * clipping where the master was pushed. This module is the boring, deterministic
 * part of "make it listenable": normalise to a peak, fade the ends, trim the room
 * noise and hand out a bundle someone can actually open the next morning.
 *
 * Everything here is offline and pure, so it can be tested against numbers instead
 * of ears.
 */

export interface NormalizeOptions {
  /** Peak target in dBFS, negative. -1 dBFS leaves headroom for lossy codecs. */
  targetPeakDb?: number;
  /** Ceiling never to exceed, in dBFS. */
  ceilingDb?: number;
}

export interface FadeOptions {
  /** Fade length in seconds. */
  seconds: number;
  /** Shape of the curve. */
  curve?: 'linear' | 'equalPower';
}

export interface TrimResult {
  channels: Float32Array[];
  /** Seconds removed from the front. */
  leadingSeconds: number;
  /** Seconds removed from the end. */
  trailingSeconds: number;
}

const DB_FLOOR = -120;

export function dbToLinear(db: number): number {
  return db <= DB_FLOOR ? 0 : 10 ** (db / 20);
}

export function linearToDb(linear: number): number {
  return linear <= 1e-6 ? DB_FLOOR : Math.round(20 * Math.log10(linear) * 100) / 100;
}

function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const magnitude = Math.abs(channel[index]!);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

export function peakDb(channels: readonly Float32Array[]): number {
  return linearToDb(peakOf(channels));
}

/**
 * Scales all channels by one gain so the loudest sample hits the target.
 *
 * One gain for every channel on purpose: normalising channels independently would
 * shift the stereo image, which on a recorded set sounds like the room rotating.
 */
export function normalize(channels: readonly Float32Array[], options: NormalizeOptions = {}): Float32Array[] {
  const targetDb = Math.min(options.ceilingDb ?? -0.3, options.targetPeakDb ?? -1);
  const peak = peakOf(channels);
  if (peak <= 0) return channels.map((channel) => new Float32Array(channel));
  const target = dbToLinear(targetDb);
  const gain = target / peak;
  return channels.map((channel) => {
    const output = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      const scaled = channel[index]! * gain;
      // The target is below the ceiling by construction, but a rounding error on a
      // full-scale sample must not become a click.
      output[index] = scaled > target ? target : scaled < -target ? -target : scaled;
    }
    return output;
  });
}

/** Applies a fade-in from silence, or a fade-out to silence. */
export function fade(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: FadeOptions & { direction?: 'in' | 'out' } = { seconds: 0 },
): Float32Array[] {
  const direction = options.direction ?? 'in';
  const curve = options.curve ?? 'equalPower';
  const length = Math.min(
    Math.round(Math.max(0, options.seconds) * sampleRate),
    channels[0]?.length ?? 0,
  );
  if (length <= 0) return channels.map((channel) => new Float32Array(channel));

  const gains = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = (index + 1) / length;
    gains[index] = curve === 'linear' ? t : Math.sin((Math.PI / 2) * t);
  }

  return channels.map((channel) => {
    const output = new Float32Array(channel);
    if (direction === 'in') {
      for (let index = 0; index < length; index += 1) output[index] = channel[index]! * gains[index]!;
    } else {
      const offset = channel.length - length;
      for (let index = 0; index < length; index += 1) {
        output[offset + index] = channel[offset + index]! * gains[length - 1 - index]!;
      }
    }
    return output;
  });
}

/**
 * Trims leading and trailing silence.
 *
 * `thresholdDb` is relative to the take's own peak, not absolute: a quiet recording
 * of a quiet room has to be trimmed by its own standard, or nothing is trimmed at
 * all.
 */
export function trimSilence(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: { thresholdDb?: number; keepSeconds?: number } = {},
): TrimResult {
  const peak = peakOf(channels);
  const length = channels[0]?.length ?? 0;
  if (peak <= 0 || length === 0) return { channels: channels.map((channel) => new Float32Array(channel)), leadingSeconds: 0, trailingSeconds: 0 };
  const threshold = peak * dbToLinear(options.thresholdDb ?? -50);
  const keep = Math.round(Math.max(0, options.keepSeconds ?? 0.05) * sampleRate);

  const isLoud = (index: number): boolean =>
    channels.some((channel) => Math.abs(channel[index] ?? 0) > threshold);

  let first = 0;
  while (first < length && !isLoud(first)) first += 1;
  let last = length - 1;
  while (last > first && !isLoud(last)) last -= 1;

  const start = Math.max(0, first - keep);
  const end = Math.min(length, last + 1 + keep);
  const channelsOut = channels.map((channel) => channel.slice(start, end));
  return {
    channels: channelsOut,
    leadingSeconds: Math.round((start / sampleRate) * 1000) / 1000,
    trailingSeconds: Math.round(((length - end) / sampleRate) * 1000) / 1000,
  };
}

export interface ExportManifest {
  name: string;
  createdAt: number;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  peakDb: number;
  /** Markers, in the same shape the recorder produces. */
  markers: { label: string; offsetSeconds: number }[];
  notes: string[];
}

export interface ExportBundle {
  manifest: ExportManifest;
  wav: Uint8Array;
  cueSheet: string;
}

export interface ExportOptions {
  name: string;
  createdAt: number;
  sampleRate: number;
  targetPeakDb?: number;
  fadeSeconds?: number;
  trim?: boolean;
  markers?: { label: string; offsetSeconds: number }[];
  notes?: string[];
}

/**
 * Turns a finished take into what leaves the phone: a normalised, faded WAV, a
 * cue sheet and a manifest that says exactly what was done to it.
 */
export function buildExportBundle(channels: readonly Float32Array[], options: ExportOptions): ExportBundle {
  const notes: string[] = [];
  let working: Float32Array[] = channels.map((channel) => new Float32Array(channel));

  if (options.trim) {
    const trimmed = trimSilence(working, options.sampleRate);
    working = trimmed.channels;
    if (trimmed.leadingSeconds > 0 || trimmed.trailingSeconds > 0) {
      notes.push(`trimmed ${trimmed.leadingSeconds}s from the front and ${trimmed.trailingSeconds}s from the end`);
    } else {
      notes.push('nothing to trim');
    }
  }

  const fadeSeconds = options.fadeSeconds ?? 0;
  if (fadeSeconds > 0) {
    working = fade(working, options.sampleRate, { seconds: fadeSeconds, direction: 'in' });
    working = fade(working, options.sampleRate, { seconds: fadeSeconds, direction: 'out' });
    notes.push(`faded ${fadeSeconds}s in and out`);
  }

  working = normalize(working, { targetPeakDb: options.targetPeakDb ?? -1 });
  const peak = peakDb(working);
  notes.push(`normalised to ${peak} dBFS`);

  const frames = working[0]?.length ?? 0;
  const durationSeconds = Math.round((frames / options.sampleRate) * 100) / 100;
  const wav = encodeWav(working.map((channel) => Array.from(channel)), options.sampleRate);

  const markers = options.markers ?? [];
  const cueLines = [`# ${options.name}`, `# ${durationSeconds}s @ ${options.sampleRate} Hz`, ''];
  for (const marker of markers) {
    const minutes = Math.floor(marker.offsetSeconds / 60);
    const seconds = (marker.offsetSeconds % 60).toFixed(2).padStart(5, '0');
    cueLines.push(`${String(minutes).padStart(2, '0')}:${seconds}  ${marker.label}`);
  }

  return {
    manifest: {
      name: options.name,
      createdAt: options.createdAt,
      sampleRate: options.sampleRate,
      channels: working.length,
      durationSeconds,
      peakDb: peak,
      markers,
      notes: [...notes, ...(options.notes ?? [])],
    },
    wav,
    cueSheet: cueLines.join('\n'),
  };
}

/** One-line summary for the share sheet. */
export function describeBundle(bundle: ExportBundle): string {
  const { manifest } = bundle;
  const sizeMb = Math.round((bundle.wav.length / (1024 * 1024)) * 10) / 10;
  return `${manifest.name} · ${manifest.durationSeconds}s · ${sizeMb} MB · peak ${manifest.peakDb} dBFS`;
}
