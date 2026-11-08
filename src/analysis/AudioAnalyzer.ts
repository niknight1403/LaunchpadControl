/**
 * Offline analyser: one pass over decoded samples produces everything the UI and
 * the agent need before a track can be played.
 *
 * Output feeds `TrackLibrary.applyAnalysis` and `WaveformView`. It runs on the JS
 * thread on purpose (no native dependency), capped by `maxFrames` so a long file
 * costs a bounded amount of time.
 */
import { estimateKey } from '../agent/harmonic';
import { detectBpm, type BeatOptions } from './beat';
import { computeChroma, rmsToEnergy, type ChromaOptions } from './chroma';

export interface TrackAnalysis {
  durationSeconds: number;
  bpm: number | null;
  bpmConfidence: number;
  /** Camelot code, empty when the key could not be determined. */
  camelot: string;
  keyConfidence: number;
  keyLabel: string;
  energy: number;
  rms: number;
  /** Normalised waveform peaks for the UI, always `peakBins` long. */
  peaks: number[];
  framesAnalysed: number;
}

export interface AnalyseOptions {
  beat?: BeatOptions;
  chroma?: ChromaOptions;
  peakBins?: number;
}

/** Downsampled absolute peak per bin. Cheap, and it is what a waveform shows. */
export function peaksFromSamples(samples: readonly number[], bins = 128): number[] {
  const count = Math.max(1, Math.min(2048, Math.floor(bins)));
  const peaks = new Array<number>(count).fill(0);
  if (samples.length === 0) return peaks;
  const perBin = samples.length / count;
  for (let bin = 0; bin < count; bin += 1) {
    const start = Math.floor(bin * perBin);
    const end = Math.min(samples.length, Math.floor((bin + 1) * perBin));
    let peak = 0;
    // Stride through long bins: a 6-minute file is 16 M samples and we do not
    // need every one of them to know how tall the bin is.
    const stride = Math.max(1, Math.floor((end - start) / 2048));
    for (let i = start; i < end; i += stride) {
      const magnitude = Math.abs(samples[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
    peaks[bin] = peak;
  }
  // Normalise to the loudest bin so the waveform fills its box.
  const loudest = Math.max(...peaks, 1e-6);
  return peaks.map((value) => Math.round((value / loudest) * 1000) / 1000);
}

export function analyseSamples(
  samples: readonly number[],
  sampleRate: number,
  options: AnalyseOptions = {},
): TrackAnalysis {
  const durationSeconds = sampleRate > 0 ? samples.length / sampleRate : 0;

  // Analysis reads at most ~40 s of audio: beyond that the statistics stop
  // changing and the cost keeps growing.
  const analysisWindow =
    samples.length > sampleRate * 40 ? samples.slice(0, sampleRate * 40) : samples;

  const beat = detectBpm(analysisWindow, sampleRate, options.beat);
  const chromaResult = computeChroma(samples, sampleRate, options.chroma);
  const keyEstimate = estimateKey(Array.from(chromaResult.chroma));

  // A key guess below the confidence floor is noise: better to say "unknown"
  // than to light up a Camelot code the DJ then trusts.
  const keyUsable = keyEstimate !== null && keyEstimate.confidence >= 0.45;

  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    bpm: beat ? beat.bpm : null,
    bpmConfidence: beat ? beat.confidence : 0,
    camelot: keyUsable ? keyEstimate.camelot : '',
    keyConfidence: keyEstimate ? Math.round(keyEstimate.confidence * 1000) / 1000 : 0,
    keyLabel: keyUsable ? keyEstimate.label : '',
    energy: Math.round(rmsToEnergy(chromaResult.rms) * 1000) / 1000,
    rms: Math.round(chromaResult.rms * 1e6) / 1e6,
    peaks: peaksFromSamples(samples, options.peakBins ?? 128),
    framesAnalysed: chromaResult.framesAnalysed,
  };
}
