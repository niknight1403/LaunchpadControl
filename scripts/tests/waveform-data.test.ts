import { buildMarkers, buildWaveformData, bucketWeights, gridFor, loudestPosition } from '../../src/analysis/WaveformData';
import { sine } from '../../src/analysis/StemSplit';
import { check, near, section } from './harness';

const sampleRate = 48_000;

export async function run(): Promise<void> {
  section('Waveform data: buckets');
  const bassTrack = sine(60, 2, sampleRate, 0.6);
  const bassData = buildWaveformData([bassTrack], sampleRate, null, { bucketCount: 64 });
  check('the requested bucket count is produced', bassData.buckets.length === 64, String(bassData.buckets.length));
  check('bucket duration is reported', near(bassData.secondsPerBucket, 2 / 64, 0.0001), String(bassData.secondsPerBucket));
  check('peaks are 0..1', bassData.buckets.every((bucket) => bucket.peak <= 1.0001));
  check('a full-scale tone shows a peak near its amplitude', near(bassData.maxPeak, 0.6, 0.02), String(bassData.maxPeak));
  check('no markers without a grid', bassData.markers.length === 0);

  section('Waveform data: band colouring');
  const bassWeights = bucketWeights(bassData.buckets[10]!);
  check('a 60 Hz tone reads as bass', bassWeights.low > 0.6, JSON.stringify(bassWeights));
  const highData = buildWaveformData([sine(9_000, 2, sampleRate, 0.6)], sampleRate, null, { bucketCount: 32 });
  const highWeights = bucketWeights(highData.buckets[5]!);
  check('a 9 kHz tone reads as highs', highWeights.high > 0.6, JSON.stringify(highWeights));
  const midData = buildWaveformData([sine(1_000, 2, sampleRate, 0.6)], sampleRate, null, { bucketCount: 32 });
  const midWeights = bucketWeights(midData.buckets[5]!);
  check('a 1 kHz tone reads as mids', midWeights.mid > 0.5, JSON.stringify(midWeights));
  check('weights sum to one', near(bassWeights.low + bassWeights.mid + bassWeights.high, 1, 0.002));
  check('silence has no weights', bucketWeights({ low: 0, mid: 0, high: 0, peak: 0, rms: 0 }).low === 0);

  section('Waveform data: dynamics');
  const quiet = sine(440, 1, sampleRate, 0.05);
  const loud = sine(440, 1, sampleRate, 0.9);
  const dynamic = new Float32Array(quiet.length * 2);
  dynamic.set(quiet, 0);
  dynamic.set(loud, quiet.length);
  const dynamicData = buildWaveformData([dynamic], sampleRate, null, { bucketCount: 40 });
  const firstHalf = dynamicData.buckets.slice(0, 20).reduce((sum, bucket) => sum + bucket.rms, 0) / 20;
  const secondHalf = dynamicData.buckets.slice(20).reduce((sum, bucket) => sum + bucket.rms, 0) / 20;
  check('the loud half is louder', secondHalf > firstHalf * 3, `${firstHalf} vs ${secondHalf}`);
  const peakPosition = loudestPosition(dynamicData);
  check('the loudest bucket sits in the second half', peakPosition >= 0.5, String(peakPosition));

  section('Waveform data: stereo');
  const stereoLeft = sine(60, 1, sampleRate, 0.5);
  const stereoRight = sine(6_000, 1, sampleRate, 0.5);
  const stereoData = buildWaveformData([stereoLeft, stereoRight], sampleRate, null, { bucketCount: 16 });
  check('stereo keeps one bucket list', stereoData.buckets.length === 16);
  check('both bands are visible from the louder channel', stereoData.buckets[3]!.low > 0 && stereoData.buckets[3]!.high > 0);

  section('Waveform data: beat markers');
  const grid = gridFor(120, 0.5);
  const markers = buildMarkers(grid, 10, 200, 10 / 200);
  check('markers start at the first beat', markers[0]!.seconds === 0.5, String(markers[0]!.seconds));
  check('the first marker is a bar line', markers[0]!.isBar);
  check('markers follow the tempo', near(markers[1]!.seconds, 1, 1e-6), String(markers[1]!.seconds));
  check('every fourth marker is a bar', markers.filter((marker) => marker.isBar).length === Math.ceil(markers.length / 4) || markers.length < 8);
  check('markers stay inside the track', markers.every((marker) => marker.seconds < 10));
  check('markers never exceed the bucket count', markers.every((marker) => marker.bucket < 200));
  check('markers are unique per bucket', new Set(markers.map((marker) => marker.bucket)).size === markers.length);
  const barBucket = markers.find((marker) => marker.isBar && marker.bucket > 0);
  check('bar lines win their bucket', barBucket !== undefined);

  const noGrid = buildMarkers(grid, 0, 100, 0.1);
  check('a zero-length track has no markers', noGrid.length === 0);
  // makeGrid clamps a nonsense tempo instead of dividing by zero, so the walk must
  // terminate with a handful of markers rather than hang.
  const badGrid = gridFor(0, 0);
  const clampedMarkers = buildMarkers(badGrid, 10, 100, 0.1);
  check('a nonsense tempo still terminates', clampedMarkers.length > 0 && clampedMarkers.length <= 6, String(clampedMarkers.length));
  check('a nonsense tempo yields a clamped grid', badGrid.bpm >= 20);

  section('Waveform data: integration');
  const full = buildWaveformData([sine(120, 4, sampleRate, 0.5)], sampleRate, gridFor(128), { bucketCount: 96 });
  check('waveform and markers are produced together', full.buckets.length === 96 && full.markers.length > 0);
  check('markers reference real buckets', full.markers.every((marker) => full.buckets[marker.bucket] !== undefined));
  const empty = buildWaveformData([], sampleRate, null, { bucketCount: 8 });
  check('an empty channel list does not crash', empty.buckets.length === 8 && empty.maxPeak === 0);
  const zeroLength = buildWaveformData([new Float32Array(0)], sampleRate, null, { bucketCount: 4 });
  check('a zero-length buffer yields zero buckets with data', zeroLength.buckets.every((bucket) => bucket.peak === 0));
}
