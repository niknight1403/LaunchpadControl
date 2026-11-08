import {
  buildExportBundle,
  dbToLinear,
  describeBundle,
  fade,
  linearToDb,
  normalize,
  peakDb,
  trimSilence,
} from '../../src/recording/PostProcess';
import { sine } from '../../src/analysis/StemSplit';
import { decodeWavPcm16 } from '../../src/recording/WavWriter';
import { check, near, section } from './harness';

const sampleRate = 48_000;

const peakOf = (channels: readonly Float32Array[]): number =>
  channels.reduce((best, channel) => Math.max(best, channel.reduce((inner, value) => Math.max(inner, Math.abs(value)), 0)), 0);

export async function run(): Promise<void> {
  section('Post-processing: levels');
  check('0 dB is unity', near(dbToLinear(0), 1, 1e-12));
  check('-6 dB is about half', near(dbToLinear(-6), 0.5012, 0.001));
  check('a tiny level floors to silence', dbToLinear(-200) === 0);
  check('unity reads as 0 dB', near(linearToDb(1), 0, 1e-9));
  check('silence reads as the floor', linearToDb(0) === -120);

  section('Post-processing: normalise');
  const quiet = [sine(440, 0.5, sampleRate, 0.1)];
  check('the quiet take starts low', peakDb(quiet) < -18, String(peakDb(quiet)));
  const normalised = normalize(quiet, { targetPeakDb: -1 });
  check('normalising hits the target peak', near(peakDb(normalised), -1, 0.05), String(peakDb(normalised)));
  check('normalising does not clip', peakOf(normalised) <= 1);
  check('the waveform keeps its shape', (() => {
    const originalRatio = quiet[0]![100]! / quiet[0]![200]!;
    const normalisedRatio = normalised[0]![100]! / normalised[0]![200]!;
    return Math.abs(originalRatio - normalisedRatio) < 1e-4;
  })());

  const stereo = [sine(440, 0.2, sampleRate, 0.2), sine(440, 0.2, sampleRate, 0.1)];
  const normalisedStereo = normalize(stereo, { targetPeakDb: -3 });
  check('stereo is scaled by one gain', near(normalisedStereo[1]![500]! / normalisedStereo[0]![500]!, 0.5, 0.01), 'the image must not shift');
  check('the loudest channel sets the peak', near(peakDb(normalisedStereo), -3, 0.05));

  const silent = [new Float32Array(1_000)];
  check('normalising silence stays silent', peakOf(normalize(silent)) === 0);
  const ceiling = normalize([sine(440, 0.2, sampleRate, 0.5)], { targetPeakDb: 6, ceilingDb: -1 });
  check('the ceiling wins over an illegal target', peakDb(ceiling) <= -0.95, String(peakDb(ceiling)));

  section('Post-processing: fades');
  const tone = [sine(440, 0.5, sampleRate, 0.8)];
  const fadedIn = fade(tone, sampleRate, { seconds: 0.1, direction: 'in' });
  check('a fade-in starts near silence', Math.abs(fadedIn[0]![0]!) < 0.1, String(fadedIn[0]![0]));
  check('the fade stays below the source', fadedIn[0]![1_000]! < tone[0]![1_000]!);
  check('the fade reaches full level', near(Math.abs(fadedIn[0]![4_799]!), Math.abs(tone[0]![4_799]!), 1e-5));
  const fadedOut = fade(tone, sampleRate, { seconds: 0.1, direction: 'out' });
  check('a fade-out ends near silence', Math.abs(fadedOut[0]![fadedOut[0]!.length - 1]!) < 0.1);
  check('a fade-out leaves the start alone', near(fadedOut[0]![0]!, tone[0]![0]!, 1e-6));
  const linear = fade(tone, sampleRate, { seconds: 0.1, direction: 'in', curve: 'linear' });
  check('a linear fade is straight', near(Math.abs(linear[0]![2_400]!), Math.abs(tone[0]![2_400]!) * 0.5, 0.02));
  check('a zero-length fade changes nothing', fade(tone, sampleRate, { seconds: 0 }).map((channel) => channel[100]!).join() === tone.map((channel) => channel[100]!).join());

  section('Post-processing: trim');
  const body = sine(440, 1, sampleRate, 0.5);
  const padded = new Float32Array(sampleRate * 2);
  padded.set(body, sampleRate / 2);
  const trimmed = trimSilence([padded], sampleRate, { keepSeconds: 0 });
  check('leading silence is trimmed', near(trimmed.leadingSeconds, 0.5, 0.01), String(trimmed.leadingSeconds));
  check('trailing silence is trimmed', near(trimmed.trailingSeconds, 0.5, 0.01), String(trimmed.trailingSeconds));
  check('the body survives', trimmed.channels[0]!.length > sampleRate * 0.95 && trimmed.channels[0]!.length < sampleRate * 1.05);
  const kept = trimSilence([padded], sampleRate, { keepSeconds: 0.1 });
  check('padding is kept around the body', kept.channels[0]!.length > trimmed.channels[0]!.length);
  // A tail 20 dB below the peak is quiet but not silent: it must survive a -40 dB
  // threshold. Judging that absolutely is the bug this guards against.
  const audibleTail = new Float32Array(sampleRate);
  audibleTail.set(body.slice(0, 4_800), 0);
  audibleTail.set(sine(440, 0.9, sampleRate, 0.05), 4_800);
  const trimmedQuiet = trimSilence([audibleTail], sampleRate, { thresholdDb: -40 });
  check('a quiet but audible tail is kept', trimmedQuiet.trailingSeconds < 0.05, String(trimmedQuiet.trailingSeconds));
  const allSilent = trimSilence([new Float32Array(sampleRate)], sampleRate);
  check('an all-silent take is not trimmed to nothing', allSilent.channels[0]!.length === sampleRate && allSilent.leadingSeconds === 0);

  section('Post-processing: export bundle');
  const bundle = buildExportBundle([padded], {
    name: 'Peak Time',
    createdAt: 1_700_000_000_000,
    sampleRate,
    targetPeakDb: -1,
    fadeSeconds: 0.05,
    trim: true,
    markers: [
      { label: 'Drop', offsetSeconds: 60 },
      { label: 'Breakdown', offsetSeconds: 125.5 },
    ],
  });
  check('the bundle carries a wav', bundle.wav.length > 44);
  check('the wav is decodable', decodeWavPcm16(bundle.wav) !== null);
  const decoded = decodeWavPcm16(bundle.wav)!;
  check('the wav is normalised', near(peakOf(decoded.channels.map((channel) => Float32Array.from(channel))), 0.891, 0.02), String(peakOf(decoded.channels.map((channel) => Float32Array.from(channel)))));
  check('the manifest reports the peak', near(bundle.manifest.peakDb, -1, 0.1));
  check('the manifest duration matches the audio it ships', near(bundle.manifest.durationSeconds, decoded.header.frames / sampleRate, 0.02), `${bundle.manifest.durationSeconds} vs ${decoded.header.frames / sampleRate}`);
  check('the manifest lists the markers', bundle.manifest.markers.length === 2);
  check('the manifest explains what was done', bundle.manifest.notes.some((note) => note.includes('trimmed')));
  check('the manifest notes the fade', bundle.manifest.notes.some((note) => note.includes('faded')));
  check('the cue sheet lists the markers', bundle.cueSheet.includes('01:00.00') && bundle.cueSheet.includes('Drop'), bundle.cueSheet);
  check('the cue sheet names the take', bundle.cueSheet.includes('Peak Time'));
  check('the summary is human readable', describeBundle(bundle).includes('MB') && describeBundle(bundle).includes('Peak Time'));

  const noOptions = buildExportBundle([body], { name: 'Raw', createdAt: 1, sampleRate });
  check('exporting without options still works', noOptions.wav.length > 44 && noOptions.manifest.notes.length === 1);
  check('no trim means no trim note', !noOptions.manifest.notes.some((note) => note.includes('trimmed')));
}
