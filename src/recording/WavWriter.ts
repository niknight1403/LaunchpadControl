/**
 * WAV encoding and header parsing, dependency-free.
 *
 * Two jobs:
 *  - the native core writes the live capture (C++), and this module reads its
 *    output for verification and export;
 *  - offline renders (a mixdown of a transition) are produced here in JS.
 *
 * Works in React Native and in Node: no Buffer, no fs.
 */

export interface WavHeader {
  riffSize: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number;
  dataOffset: number;
  dataSize: number;
  frames: number;
}

const HEADER_BYTES = 44;

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encodes interleaved-by-channel float audio as PCM16 WAV.
 * `channels` are separate arrays, each one sample per frame.
 */
export function encodeWav(channels: readonly (readonly number[])[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataSize = frames * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  writeU32(view, 4, 36 + dataSize);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  writeU32(view, 16, 16);
  writeU16(view, 20, 1); // PCM
  writeU16(view, 22, channelCount);
  writeU32(view, 24, sampleRate);
  writeU32(view, 28, sampleRate * channelCount * bytesPerSample);
  writeU16(view, 32, channelCount * bytesPerSample);
  writeU16(view, 34, 16);
  writeAscii(view, 36, 'data');
  writeU32(view, 40, dataSize);

  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const raw = channels[channel]?.[frame] ?? 0;
      const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** Encodes interleaved stereo samples (l,r,l,r…) as PCM16 WAV. */
export function encodeWavInterleaved(interleaved: readonly number[], sampleRate: number): Uint8Array {
  const frames = Math.floor(interleaved.length / 2);
  const left = new Array<number>(frames);
  const right = new Array<number>(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = interleaved[i * 2] ?? 0;
    right[i] = interleaved[i * 2 + 1] ?? 0;
  }
  return encodeWav([left, right], sampleRate);
}

export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  // Walk the chunks: a real file from another tool may put LIST before data.
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  while (offset + 8 <= bytes.length) {
    const chunkTag = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (chunkTag === 'fmt ' && offset + 24 <= bytes.length) {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkTag === 'data') {
      const dataOffset = offset + 8;
      const dataSize = Math.min(size, bytes.length - dataOffset);
      const bytesPerFrame = Math.max(1, (bitsPerSample / 8) * Math.max(1, channels));
      return {
        riffSize: view.getUint32(4, true),
        channels,
        sampleRate,
        bitsPerSample,
        audioFormat,
        dataOffset,
        dataSize,
        frames: Math.floor(dataSize / bytesPerFrame),
      };
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

/** Reads a PCM16 WAV back into per-channel floats. Used by the tests and import. */
export function decodeWavPcm16(bytes: Uint8Array): { header: WavHeader; channels: number[][] } | null {
  const header = parseWavHeader(bytes);
  if (!header || header.bitsPerSample !== 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels: number[][] = Array.from({ length: header.channels }, () => []);
  let offset = header.dataOffset;
  for (let frame = 0; frame < header.frames; frame += 1) {
    for (let channel = 0; channel < header.channels; channel += 1) {
      const value = view.getInt16(offset, true) / 32768;
      channels[channel]?.push(value);
      offset += 2;
    }
  }
  return { header, channels };
}

export function durationSecondsOf(frames: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return frames / sampleRate;
}
