import { analyseSamples, peaksFromSamples } from '../../src/analysis/AudioAnalyzer';
import { computeChroma, pitchClassOfFrequency, pitchClassName, rmsToEnergy } from '../../src/analysis/chroma';
import { binFrequency, fftInPlace, magnitudeSpectrum, nextPowerOfTwo } from '../../src/analysis/fft';
import { check, near, section } from './harness';

function sine(frequency: number, seconds: number, sampleRate: number, amplitude = 0.5): number[] {
  const total = Math.round(seconds * sampleRate);
  const samples = new Array<number>(total);
  for (let i = 0; i < total; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return samples;
}

function mix(buffers: number[][]): number[] {
  const length = Math.max(...buffers.map((buffer) => buffer.length));
  const out = new Array<number>(length).fill(0);
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i += 1) out[i] = (out[i] ?? 0) + (buffer[i] ?? 0) / buffers.length;
  }
  return out;
}

export async function run(): Promise<void> {
  section('FFT');
  check('nextPowerOfTwo rounds up', nextPowerOfTwo(1000) === 1024 && nextPowerOfTwo(1024) === 1024);

  const fftSize = 1024;
  const sampleRate = 8192;
  const binIndex = 64; // 64 * 8192 / 1024 = 512 Hz
  const frame = new Float64Array(fftSize);
  const expectedHz = binFrequency(binIndex, fftSize, sampleRate);
  for (let i = 0; i < fftSize; i += 1) {
    frame[i] = Math.sin((2 * Math.PI * expectedHz * i) / sampleRate);
  }
  const magnitudes = magnitudeSpectrum(frame);
  let peakBin = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    if ((magnitudes[bin] ?? 0) > (magnitudes[peakBin] ?? 0)) peakBin = bin;
  }
  check('a pure tone lands in its own bin', Math.abs(peakBin - binIndex) <= 1, `${peakBin} vs ${binIndex}`);
  check('spectrum length is n/2', magnitudes.length === fftSize / 2);

  // Parseval: energy in time == energy in frequency (scaled by n).
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) real[i] = frame[i] ?? 0;
  fftInPlace(real, imag);
  let timeEnergy = 0;
  for (let i = 0; i < fftSize; i += 1) timeEnergy += (frame[i] ?? 0) ** 2;
  let freqEnergy = 0;
  for (let i = 0; i < fftSize; i += 1) freqEnergy += (real[i] ?? 0) ** 2 + (imag[i] ?? 0) ** 2;
  check('energy is conserved by the transform', near(freqEnergy / fftSize, timeEnergy, timeEnergy * 0.01));

  let threw = false;
  try {
    fftInPlace(new Float64Array(3), new Float64Array(3));
  } catch {
    threw = true;
  }
  check('non power-of-two size is rejected', threw);

  section('Chroma');
  check('440 Hz maps to A', pitchClassOfFrequency(440) === 9);
  check('261.63 Hz maps to C', pitchClassOfFrequency(261.63) === 0);
  check('pitch class names', pitchClassName(9) === 'A' && pitchClassName(0) === 'C');

  // A minor triad, three octaves apart, is the classic analyser smoke test.
  const aMinorTriad = mix([
    sine(110, 6, sampleRate),
    sine(261.63, 6, sampleRate),
    sine(329.63, 6, sampleRate),
  ]);
  const chromaResult = computeChroma(aMinorTriad, sampleRate, { frameSize: 2048, hopSize: 1024, maxFrames: 64 });
  const strongest = [...chromaResult.chroma.keys()].sort(
    (left, right) => (chromaResult.chroma[right] ?? 0) - (chromaResult.chroma[left] ?? 0),
  );
  check('A, C and E carry the most energy', [9, 0, 4].every((pc) => strongest.slice(0, 4).includes(pc)), strongest.slice(0, 4).join(','));
  check('chroma sums to 1', near(chromaResult.chroma.reduce((sum, value) => sum + value, 0), 1, 1e-6));
  check('chroma reports frames', chromaResult.framesAnalysed > 0);
  check('silence gives an empty chroma', computeChroma(new Array(8192).fill(0), sampleRate).framesAnalysed >= 0);

  check('rmsToEnergy maps silence to 0', rmsToEnergy(0) === 0);
  check('rmsToEnergy is monotonic', rmsToEnergy(0.01) < rmsToEnergy(0.2));

  section('Offline analysis');
  const analysis = analyseSamples(aMinorTriad, sampleRate, { peakBins: 64 });
  check('detects A minor from the triad', analysis.camelot === '8A', analysis.camelot);
  check('key confidence is usable', analysis.keyConfidence > 0.45, String(analysis.keyConfidence));
  check('peaks have the requested length', analysis.peaks.length === 64);
  check('peaks stay within 0..1', analysis.peaks.every((peak) => peak >= 0 && peak <= 1));
  check('duration is reported', near(analysis.durationSeconds, 6, 0.01), String(analysis.durationSeconds));

  // A click track: tempo must come out, and a missing key must stay missing
  // rather than being invented.
  const clickLength = sampleRate * 12;
  const clicks = new Array<number>(clickLength).fill(0);
  const beatSamples = Math.round((60 / 128) * sampleRate);
  for (let start = 0; start + 200 < clickLength; start += beatSamples) {
    for (let i = 0; i < 64; i += 1) clicks[start + i] = Math.sin((i / sampleRate) * 2 * Math.PI * 1500) * (1 - i / 64);
  }
  const clickAnalysis = analyseSamples(clicks, sampleRate, { beat: { hopSize: 64 }, peakBins: 32 });
  check('click track tempo detected', clickAnalysis.bpm !== null && near(clickAnalysis.bpm, 128, 3), String(clickAnalysis.bpm));
  check('click track peaks are sparse but present', clickAnalysis.peaks.some((peak) => peak > 0.9));

  const silenceAnalysis = analyseSamples(new Array(sampleRate * 3).fill(0), sampleRate);
  check('silence yields no bpm and no key', silenceAnalysis.bpm === null && silenceAnalysis.camelot === '');

  const peaks = peaksFromSamples([0, 1, -1, 0, 0.5, -0.5], 3);
  check('peaksFromSamples normalises to the loudest bin', peaks[0] === 1 || peaks[1] === 1, peaks.join(','));
  check('peaksFromSamples handles an empty buffer', peaksFromSamples([], 8).length === 8);
}
