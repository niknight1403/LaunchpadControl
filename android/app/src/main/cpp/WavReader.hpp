// WavReader.hpp — minimal RIFF/WAVE decoder for the realtime core.
//
// Supports the formats a DJ actually loads from a phone:
//   PCM 16-bit, PCM 24-bit, IEEE float 32-bit, mono/stereo, any sample rate.
//
// Why hand-rolled: pulling a decoder into the audio path means a library that
// allocates, seeks and possibly takes a lock. Decoding happens once per clip on
// the JSI thread, and the callback then reads a flat float buffer.
//
// FLAC is *not* handled here. docs/BUILD.md lists the two acceptable routes
// (libFLAC via prefab, or decode to WAV on import).

#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace auragrid {

struct WavData {
  int32_t sampleRate = 0;
  int32_t channels = 0;
  int64_t frames = 0;
  // Interleaved float in -1..1, always stereo (mono is duplicated).
  std::vector<float> samples;
  bool ok = false;
  std::string error;
};

namespace wav {

inline uint32_t readU32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint16_t readU16(const unsigned char* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

inline float pcm16ToFloat(const unsigned char* p) {
  int16_t value = static_cast<int16_t>(readU16(p));
  return static_cast<float>(value) / 32768.0f;
}

inline float pcm24ToFloat(const unsigned char* p) {
  int32_t value = (static_cast<int32_t>(p[0]) << 8) | (static_cast<int32_t>(p[1]) << 16) |
                  (static_cast<int32_t>(p[2]) << 24);
  return static_cast<float>(value) / 2147483648.0f;
}

inline float float32ToFloat(const unsigned char* p) {
  uint32_t raw = readU32(p);
  float value;
  std::memcpy(&value, &raw, sizeof(float));
  // Guards against a clipped/broken file blowing up the master bus.
  if (!std::isfinite(value)) return 0.0f;
  return value;
}

}  // namespace wav

inline WavData decodeWav(const std::string& path) {
  WavData out;
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    out.error = "cannot open file";
    return out;
  }

  unsigned char header[12];
  if (!file.read(reinterpret_cast<char*>(header), 12)) {
    out.error = "file too short";
    return out;
  }
  if (std::memcmp(header, "RIFF", 4) != 0 || std::memcmp(header + 8, "WAVE", 4) != 0) {
    out.error = "not a RIFF/WAVE file";
    return out;
  }

  uint16_t audioFormat = 0;
  uint16_t channels = 0;
  uint32_t sampleRate = 0;
  uint16_t bitsPerSample = 0;
  uint32_t dataSize = 0;
  std::streampos dataOffset = 0;

  unsigned char chunk[8];
  while (file.read(reinterpret_cast<char*>(chunk), 8)) {
    const uint32_t chunkSize = wav::readU32(chunk + 4);
    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      std::vector<unsigned char> fmt(chunkSize);
      if (!file.read(reinterpret_cast<char*>(fmt.data()), chunkSize)) break;
      if (chunkSize >= 16) {
        audioFormat = wav::readU16(fmt.data());
        channels = wav::readU16(fmt.data() + 2);
        sampleRate = wav::readU32(fmt.data() + 4);
        bitsPerSample = wav::readU16(fmt.data() + 14);
      }
    } else if (std::memcmp(chunk, "data", 4) == 0) {
      dataSize = chunkSize;
      dataOffset = file.tellg();
      file.seekg(0, std::ios::end);
      const std::streampos end = file.tellg();
      const std::streampos available = end - dataOffset;
      if (available >= 0 && static_cast<uint64_t>(available) < dataSize) {
        dataSize = static_cast<uint32_t>(available);
      }
      file.seekg(dataOffset);
      break;
    } else {
      // Skip unknown chunk, respecting the even-byte padding rule.
      file.seekg(chunkSize + (chunkSize & 1u), std::ios::cur);
    }
  }

  if (dataOffset == 0 || dataSize == 0) {
    out.error = "no data chunk";
    return out;
  }
  if (channels < 1 || channels > 2) {
    out.error = "only mono/stereo supported";
    return out;
  }

  const int bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample <= 0) {
    out.error = "invalid bit depth";
    return out;
  }
  const int64_t frameCount = static_cast<int64_t>(dataSize) / (bytesPerSample * channels);
  if (frameCount <= 0) {
    out.error = "empty data chunk";
    return out;
  }

  std::vector<unsigned char> raw(dataSize);
  file.seekg(dataOffset);
  if (!file.read(reinterpret_cast<char*>(raw.data()), dataSize)) {
    out.error = "truncated data chunk";
    return out;
  }

  out.samples.resize(static_cast<size_t>(frameCount) * 2);
  for (int64_t frame = 0; frame < frameCount; ++frame) {
    float left = 0.0f;
    float right = 0.0f;
    for (int channel = 0; channel < channels; ++channel) {
      const size_t offset =
          static_cast<size_t>(frame) * channels * bytesPerSample + static_cast<size_t>(channel) * bytesPerSample;
      float value = 0.0f;
      if (audioFormat == 3 && bytesPerSample == 4) {
        value = wav::float32ToFloat(raw.data() + offset);
      } else if (bytesPerSample == 2) {
        value = wav::pcm16ToFloat(raw.data() + offset);
      } else if (bytesPerSample == 3) {
        value = wav::pcm24ToFloat(raw.data() + offset);
      } else if (bytesPerSample == 4) {
        value = wav::float32ToFloat(raw.data() + offset);
      }
      if (channel == 0) left = value;
      else right = value;
    }
    if (channels == 1) right = left;
    out.samples[static_cast<size_t>(frame) * 2] = left;
    out.samples[static_cast<size_t>(frame) * 2 + 1] = right;
  }

  out.sampleRate = static_cast<int32_t>(sampleRate);
  out.channels = 2;
  out.frames = frameCount;
  out.ok = true;
  return out;
}

}  // namespace auragrid
