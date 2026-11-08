/**
 * Chroma extraction: 12 pitch-class bins from a time-domain buffer.
 *
 * This is what turns audio into a key. The mapping is deliberately narrow
 * (55 Hz – 2 kHz) because that is where harmonic content lives; bass rumble and
 * cymbal wash only smear the chroma vector.
 */
import { binFrequency, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from './fft';

export interface ChromaOptions {
  /** FFT size; 4096 at 48 kHz gives ~12 Hz resolution. */
  frameSize?: number;
  hopSize?: number;
  /** Hard cap so a 10-minute file cannot lock the JS thread. */
  maxFrames?: number;
  minFrequency?: number;
  maxFrequency?: number;
}

export interface ChromaResult {
  /** 12 bins, C..B, L1-normalised (sums to 1 when any energy exists). */
  chroma: Float64Array;
  /** RMS of the analysed region, 0..1-ish. */
  rms: number;
  framesAnalysed: number;
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function pitchClassOfFrequency(frequency: number): number {
  if (frequency <= 0) return 0;
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const pitchClass = Math.round(midi) % 12;
  return pitchClass < 0 ? pitchClass + 12 : pitchClass;
}

export function pitchClassName(pitchClass: number): string {
  return PITCH_CLASS_NAMES[((pitchClass % 12) + 12) % 12] ?? 'C';
}

export function computeChroma(
  samples: readonly number[],
  sampleRate: number,
  options: ChromaOptions = {},
): ChromaResult {
  const frameSize = nextPowerOfTwo(options.frameSize ?? 4096);
  const hopSize = Math.max(1, options.hopSize ?? frameSize / 2);
  const maxFrames = options.maxFrames ?? 512;
  const minFrequency = options.minFrequency ?? 55;
  const maxFrequency = options.maxFrequency ?? 2000;

  const chroma = new Float64Array(12);
  const window = hannWindow(frameSize);
  const frame = new Float64Array(frameSize);

  const availableFrames = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const framesToAnalyse = Math.min(availableFrames, maxFrames);
  if (framesToAnalyse <= 0) {
    return { chroma, rms: 0, framesAnalysed: 0 };
  }

  // Spread frames across the whole file instead of only the intro: a track's
  // key is not always established in the first 4096 samples.
  const step = framesToAnalyse < availableFrames ? Math.floor(availableFrames / framesToAnalyse) : 1;

  const minBin = Math.max(1, Math.floor((minFrequency * frameSize) / sampleRate));
  const maxBin = Math.min(frameSize / 2 - 1, Math.ceil((maxFrequency * frameSize) / sampleRate));

  let energySum = 0;
  let analysed = 0;

  for (let index = 0; index < framesToAnalyse; index += 1) {
    const offset = index * step * hopSize;
    if (offset + frameSize > samples.length) break;
    for (let i = 0; i < frameSize; i += 1) frame[i] = samples[offset + i] ?? 0;

    const magnitudes = magnitudeSpectrum(frame, window);
    for (let bin = minBin; bin <= maxBin; bin += 1) {
      const magnitude = magnitudes[bin] ?? 0;
      if (magnitude <= 0) continue;
      const frequency = binFrequency(bin, frameSize, sampleRate);
      const pitchClass = pitchClassOfFrequency(frequency);
      // Sqrt weighting: a bass fundamental must not outweigh the whole chord.
      chroma[pitchClass] = (chroma[pitchClass] ?? 0) + Math.sqrt(magnitude);
    }
    for (let i = 0; i < frameSize; i += 1) {
      const value = frame[i] ?? 0;
      energySum += value * value;
    }
    analysed += 1;
  }

  let total = 0;
  for (const value of chroma) total += value;
  if (total > 0) {
    for (let i = 0; i < 12; i += 1) chroma[i] = (chroma[i] ?? 0) / total;
  }

  const rms = analysed > 0 ? Math.sqrt(energySum / (analysed * frameSize)) : 0;
  return { chroma, rms, framesAnalysed: analysed };
}

/** Maps RMS to a 0..1 "energy" figure usable for the agent's arc. */
export function rmsToEnergy(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  // -30 dBFS → 0, -3 dBFS → ~0.9. Club masters live in that band.
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const mapped = (db + 30) / 27;
  return Math.max(0, Math.min(1, mapped));
}
