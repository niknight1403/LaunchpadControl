import { AudioEngine } from '../../src/engine/AudioEngine';
import { SessionRecorder, type RecordingEngine, type RecordingPaths } from '../../src/recording/SessionRecorder';
import { decodeWavPcm16, encodeWav, encodeWavInterleaved, parseWavHeader } from '../../src/recording/WavWriter';
import { check, near, section } from './harness';

class FakeRecordingEngine implements RecordingEngine {
  readonly sampleRate = 48000;
  path: string | null = null;
  frames = 0;
  started = 0;
  stopped = 0;
  refuse = false;

  startRecording(path: string): boolean {
    if (this.refuse) return false;
    this.path = path;
    this.frames = 0;
    this.started += 1;
    return true;
  }

  stopRecording(): void {
    this.stopped += 1;
    this.path = null;
  }

  get recordedFrames(): number {
    return this.frames;
  }
}

const fakePaths: RecordingPaths = {
  preparePath: (name) => `/recordings/${name.replace(/\s+/g, '_')}.wav`,
};

export async function run(): Promise<void> {
  section('WAV encoding');
  const half = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav([Array.from(half), Array.from(half)], 48000);
  check('header is 44 bytes plus payload', wav.length === 44 + half.length * 2 * 2);
  check('riff magic', String.fromCharCode(...wav.slice(0, 4)) === 'RIFF');
  check('wave magic', String.fromCharCode(...wav.slice(8, 12)) === 'WAVE');

  const header = parseWavHeader(wav);
  check('header parses', header !== null);
  check('stereo declared', header?.channels === 2);
  check('sample rate declared', header?.sampleRate === 48000);
  check('16 bit declared', header?.bitsPerSample === 16);
  check('frame count matches', header?.frames === half.length, `${header?.frames}`);
  check('riff size is file length minus 8', header?.riffSize === wav.length - 8);
  check('data size matches payload', header?.dataSize === wav.length - 44);

  const decoded = decodeWavPcm16(wav);
  check('decoder reads the header', decoded?.header.channels === 2);
  check('silence stays silence', near(decoded?.channels[0]?.[0] ?? 1, 0, 1e-4));
  check('half scale survives the roundtrip', near(decoded?.channels[0]?.[1] ?? 0, 0.5, 1e-3), String(decoded?.channels[0]?.[1]));
  check('negative half scale survives', near(decoded?.channels[1]?.[2] ?? 0, -0.5, 1e-3));
  check('full scale survives', near(decoded?.channels[0]?.[3] ?? 0, 1, 1e-3));
  check('clipping is clamped, not wrapped', near(decoded?.channels[0]?.[4] ?? 0, -1, 1e-3));

  const interleaved = encodeWavInterleaved([0.25, -0.25, 0.5, -0.5], 44100);
  const interleavedDecoded = decodeWavPcm16(interleaved);
  check('interleaved helper splits channels', near(interleavedDecoded?.channels[0]?.[1] ?? 0, 0.5, 1e-3));
  check('interleaved helper keeps the right channel', near(interleavedDecoded?.channels[1]?.[0] ?? 0, -0.25, 1e-3));

  check('garbage is rejected by the parser', parseWavHeader(new Uint8Array(20)) === null);
  const notWav = new Uint8Array(64);
  notWav.set([0x4d, 0x54, 0x68, 0x64], 0); // "MThd" — a MIDI file
  check('a non-WAV file is rejected', parseWavHeader(notWav) === null);

  section('Session recorder');
  let clock = 1_000_000;
  const engine = new FakeRecordingEngine();
  const recorder = new SessionRecorder(engine, fakePaths, { now: () => clock, sampleRate: 48000 });
  recorder.attachTransport(() => 12.5);

  check('not recording initially', !recorder.isRecording);
  const started = recorder.start('Peak Time', 'take-1');
  check('start returns a take handle', started !== null && started.path === '/recordings/Peak_Time.wav');
  check('the engine was told to record', engine.path === '/recordings/Peak_Time.wav' && engine.started === 1);
  check('a second start is refused', recorder.start('Second') === null);
  check('recorder reports active', recorder.isRecording && recorder.activeName === 'Peak Time');

  clock += 60_000;
  const marker = recorder.addMarker('Drop');
  check('marker records the transport position', marker?.beats === 12.5);
  check('marker records the offset in the take', near(marker?.offsetSeconds ?? 0, 60, 0.01), String(marker?.offsetSeconds));

  clock += 30_000;
  engine.frames = 48000 * 90;
  const take = recorder.stop();
  check('stop returns the take', take !== null);
  check('the engine stopped recording', engine.stopped === 1);
  check('duration comes from the frame count', near(take?.durationSeconds ?? 0, 90, 0.01), String(take?.durationSeconds));
  check('markers are attached to the take', take?.markers.length === 1 && take?.markers[0]?.label === 'Drop');
  check('the take knows its path', take?.path === '/recordings/Peak_Time.wav');
  check('recorder is idle again', !recorder.isRecording);

  const cue = recorder.cueSheet(take!);
  check('cue sheet lists the take', cue.includes('Peak Time'));
  check('cue sheet lists the marker with a timestamp', cue.includes('01:00.00') && cue.includes('Drop'), cue);

  check('a second start is possible after stop', recorder.start('Encore') !== null);
  recorder.stop();
  check('history keeps both takes', recorder.history().length === 2);

  section('Recorder failure handling');
  const refusing = new FakeRecordingEngine();
  refusing.refuse = true;
  const blocked = new SessionRecorder(refusing, fakePaths, { now: () => 1, sampleRate: 48000 });
  check('a refused start returns null', blocked.start('Nope') === null);
  check('a refused start does not mark the recorder active', !blocked.isRecording);
  check('markers without a take are ignored', blocked.addMarker('orphan') === null);
  check('stop without a take is null', blocked.stop() === null);

  section('Recorder against the silent engine');
  const silent = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 128 });
  await silent.start();
  const silentRecorder = new SessionRecorder(silent, fakePaths, { sampleRate: 48000 });
  const silentStart = silentRecorder.start('Rehearsal');
  check('the silent bridge accepts a recording', silentStart !== null);
  check('the bridge accepts the path', silent.startRecording('/tmp/second.wav') === true);
  silentRecorder.stop();
  silent.stop();
}
