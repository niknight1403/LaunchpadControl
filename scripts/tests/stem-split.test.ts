import {
  applyStemMix,
  reconstructionError,
  sine,
  splitBands,
  stemEnergy,
} from '../../src/analysis/StemSplit';
import { check, near, section } from './harness';

const sampleRate = 48_000;

const rms = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, samples.length));

/**
 * Measures a band split the way a DJ hears it: mute a stem and listen to what is
 * left. Raw per-stem RMS is misleading here, because mid and highs are
 * complementary and therefore partially anti-phase — both can be louder than the
 * source while still summing back to it exactly.
 */
function levelWith(signal: Float32Array, gains: { bass?: number; mid?: number; highs?: number }): number {
  const split = splitBands([signal], sampleRate);
  return rms(applyStemMix(split, gains)[0]!);
}

export async function run(): Promise<void> {
  section('Band split: reconstruction');
  const low = sine(60, 1, sampleRate, 0.4);
  const middle = sine(1_000, 1, sampleRate, 0.3);
  const high = sine(9_000, 1, sampleRate, 0.2);
  const mixed = new Float32Array(low.length);
  for (let index = 0; index < low.length; index += 1) mixed[index] = low[index]! + middle[index]! + high[index]!;

  const split = splitBands([mixed], sampleRate);
  check(
    'all three stems have the input length',
    split.bass[0]!.length === mixed.length && split.mid[0]!.length === mixed.length && split.highs[0]!.length === mixed.length,
  );

  const recombined = applyStemMix(split);
  const error = reconstructionError([mixed], recombined);
  check('unity stems reconstruct the input exactly', error < 1e-6, String(error));

  const onlyBass = applyStemMix(split, { mid: 0, highs: 0 });
  check('a single stem is not silent', onlyBass[0]!.some((value) => Math.abs(value) > 0.01));
  const muted = applyStemMix(split, { bass: 0, mid: 0, highs: 0 });
  check('muting everything yields silence', muted[0]!.every((value) => Math.abs(value) < 1e-9));

  section('Band split: band placement, measured by muting');
  const bassTone = sine(60, 0.5, sampleRate);
  const bassLevel = rms(bassTone);
  check('muting the bass kills a 60 Hz tone', levelWith(bassTone, { bass: 0 }) < bassLevel * 0.35, String(levelWith(bassTone, { bass: 0 })));
  check('keeping only the bass keeps a 60 Hz tone', levelWith(bassTone, { mid: 0, highs: 0 }) > bassLevel * 0.7);

  const midTone = sine(1_000, 0.5, sampleRate);
  const midLevel = rms(midTone);
  check('muting the mids guts a 1 kHz tone', levelWith(midTone, { mid: 0 }) < midLevel * 0.55, String(levelWith(midTone, { mid: 0 })));
  check('muting the bass leaves a 1 kHz tone nearly intact', levelWith(midTone, { bass: 0 }) > midLevel * 0.95);

  const highTone = sine(9_000, 0.5, sampleRate);
  const highLevel = rms(highTone);
  check('muting the highs kills a 9 kHz tone', levelWith(highTone, { highs: 0 }) < highLevel * 0.4, String(levelWith(highTone, { highs: 0 })));
  check('keeping only the highs keeps a 9 kHz tone', levelWith(highTone, { bass: 0, mid: 0 }) > highLevel * 0.9);

  section('Band split: crossovers are configurable');
  const tone400 = sine(400, 0.4, sampleRate);
  const level400 = rms(tone400);
  // 400 Hz with the crossover pushed to 1200 Hz belongs to the bass stem;
  // with the crossover at 100 Hz it must not.
  const bassAt1200 = (() => {
    const splitAt = splitBands([tone400], sampleRate, { lowCrossoverHz: 1_200, highCrossoverHz: 3_000 });
    return rms(applyStemMix(splitAt, { bass: 0 })[0]!);
  })();
  check('a crossover above the tone puts it in the bass', bassAt1200 < level400 * 0.5, `${bassAt1200} vs ${level400}`);
  check('with the default crossover the same tone is not bass', levelWith(tone400, { bass: 0 }) > level400 * 0.9);
  const notBass = (() => {
    const splitAt = splitBands([tone400], sampleRate, { lowCrossoverHz: 100, highCrossoverHz: 3_000 });
    return rms(applyStemMix(splitAt, { bass: 0 })[0]!);
  })();
  check('a crossover below the tone keeps it out of the bass', notBass > level400 * 0.95);

  section('Band split: stereo independence');
  const left = sine(60, 0.4, sampleRate, 0.4);
  const right = sine(9_000, 0.4, sampleRate, 0.4);
  const stereo = splitBands([left, right], sampleRate);
  check('two channels in, two channels out', stereo.bass.length === 2 && stereo.mid.length === 2);
  check('the left channel carries the bass', rms(stereo.bass[0]!) > rms(stereo.bass[1]!) * 5);
  check('the right channel carries the highs', rms(stereo.highs[1]!) > rms(stereo.highs[0]!) * 5);
  check('stereo reconstruction is exact on both channels', reconstructionError([left, right], applyStemMix(stereo)) < 1e-6);

  section('Band split: gains');
  const bassAndHigh = new Float32Array(low.length);
  for (let index = 0; index < low.length; index += 1) bassAndHigh[index] = low[index]! * 0.5 + high[index]! * 0.5;
  const unityLevel = rms(applyStemMix(splitBands([bassAndHigh], sampleRate))[0]!);
  const bassCutLevel = rms(applyStemMix(splitBands([bassAndHigh], sampleRate), { bass: 0.2 })[0]!);
  check('cutting the bass lowers the level', bassCutLevel < unityLevel * 0.9, `${bassCutLevel} vs ${unityLevel}`);
  check('cutting the bass does not remove everything', bassCutLevel > unityLevel * 0.3);
  const energies = stemEnergy(split);
  check('stem energy is reported per band', energies.bass > 0 && energies.mid > 0 && energies.highs > 0, JSON.stringify(energies));

  section('Band split: edge cases');
  const empty = splitBands([new Float32Array(0)], sampleRate);
  check('an empty buffer splits into empty stems', empty.bass[0]!.length === 0 && stemEnergy(empty).bass === 0);
  const dc = new Float32Array(4_800).fill(0.5);
  const dcSplit = splitBands([dc], sampleRate);
  check('DC offset ends up in the bass', rms(dcSplit.bass[0]!) > rms(dcSplit.highs[0]!) * 10);
  check('DC still reconstructs', reconstructionError([dc], applyStemMix(dcSplit)) < 1e-6);
  check('a missing channel reports infinite error instead of silence', reconstructionError([new Float32Array(4)], []) === Number.POSITIVE_INFINITY);
  check('a sine helper produces the requested length', sine(440, 0.25, sampleRate).length === Math.round(0.25 * sampleRate));
  check('a sine helper peaks near its amplitude', near(Math.max(...Array.from(sine(440, 0.1, sampleRate, 0.3))), 0.3, 0.01));
}
