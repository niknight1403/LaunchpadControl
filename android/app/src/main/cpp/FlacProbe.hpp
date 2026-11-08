// FlacProbe.hpp — identifies a FLAC file and extracts its STREAMINFO.
//
// The core does not ship a FLAC *decoder*. A correct one is a few thousand lines
// (rice partitions, LPC, wasted bits, seek tables) and every one of those lines runs
// on the path that fills the audio buffer. The two sane routes are documented in
// docs/BUILD.md: decode on import with libFLAC via prefab, or convert once.
//
// What the app does need, and gets here, is to know what it is looking at *before*
// it spends time on it: is this really FLAC, what sample rate, how many channels,
// how many bits, how long. Then the import screen can say "FLAC 44.1 kHz stereo,
// 6:12, wird beim Import konvertiert" instead of failing with an empty error.
//
// Header-only and allocation-free, so it is testable in CI with a synthetic file.

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace auragrid {

struct FlacInfo {
  bool ok = false;
  /** True when the file starts with the FLAC magic but the stream info is broken. */
  bool isFlac = false;
  int32_t sampleRate = 0;
  int32_t channels = 0;
  int32_t bitsPerSample = 0;
  int64_t totalSamples = 0;
  /** Duration in ms, derived from the two fields above. */
  int64_t durationMs = 0;
  /** MD5 of the unencoded audio, as the encoder wrote it; empty when unset. */
  std::string md5;
  std::string error;
};

namespace flac {

inline uint32_t readBe32(const unsigned char* bytes) {
  return (static_cast<uint32_t>(bytes[0]) << 24) | (static_cast<uint32_t>(bytes[1]) << 16) |
         (static_cast<uint32_t>(bytes[2]) << 8) | static_cast<uint32_t>(bytes[3]);
}

inline uint64_t readBe64High(const unsigned char* bytes) {
  // The STREAMINFO tail packs rate (20 bit), channels (3), bits (5) and samples (36)
  // into 64 bits — read them in the order they appear rather than as two integers.
  uint64_t value = 0;
  for (int index = 0; index < 8; ++index) value = (value << 8) | bytes[index];
  return value;
}

/** Parses the 34-byte STREAMINFO block body. */
inline void parseStreamInfo(const unsigned char* body, FlacInfo& info) {
  const uint32_t minimumBlock = (static_cast<uint32_t>(body[0]) << 8) | body[1];
  const uint32_t maximumBlock = (static_cast<uint32_t>(body[2]) << 8) | body[3];
  if (minimumBlock < 16 || maximumBlock < 16) {
    info.error = "block size out of range";
    return;
  }

  const uint64_t packed = readBe64High(body + 10);
  const uint32_t sampleRate = static_cast<uint32_t>((packed >> 44) & 0xFFFFF);
  const uint32_t channels = static_cast<uint32_t>(((packed >> 41) & 0x7) + 1);
  const uint32_t bits = static_cast<uint32_t>(((packed >> 36) & 0x1F) + 1);
  const uint64_t totalSamples = packed & 0xFFFFFFFFFULL;

  if (sampleRate < 1000 || sampleRate > 768000) {
    info.error = "implausible sample rate";
    return;
  }
  if (channels < 1 || channels > 8) {
    info.error = "implausible channel count";
    return;
  }
  if (bits < 4 || bits > 32) {
    info.error = "implausible bit depth";
    return;
  }

  info.sampleRate = static_cast<int32_t>(sampleRate);
  info.channels = static_cast<int32_t>(channels);
  info.bitsPerSample = static_cast<int32_t>(bits);
  info.totalSamples = static_cast<int64_t>(totalSamples);
  info.durationMs = sampleRate > 0 ? static_cast<int64_t>((totalSamples * 1000ULL) / sampleRate) : 0;

  char md5[33];
  static const char* kHex = "0123456789abcdef";
  for (int index = 0; index < 16; ++index) {
    md5[index * 2] = kHex[(body[18 + index] >> 4) & 0xF];
    md5[index * 2 + 1] = kHex[body[18 + index] & 0xF];
  }
  md5[32] = '\0';
  bool allZero = true;
  for (int index = 0; index < 32; ++index) {
    if (md5[index] != '0') {
      allZero = false;
      break;
    }
  }
  info.md5 = allZero ? std::string() : std::string(md5);
  info.ok = true;
  info.isFlac = true;
}

}  // namespace flac

/** Identifies a FLAC file from a byte prefix; safe on any input. */
inline FlacInfo probeFlac(const unsigned char* bytes, std::size_t size) {
  FlacInfo info;
  static const unsigned char kMagic[4] = {'f', 'L', 'a', 'C'};
  if (size < 4 || std::memcmp(bytes, kMagic, 4) != 0) {
    info.error = "not a flac stream";
    return info;
  }
  info.isFlac = true;

  std::size_t offset = 4;
  // Metadata blocks: 1 bit last-flag, 7 bits type, 24 bits length. STREAMINFO (0)
  // must come first, but skip anything else rather than assuming.
  while (offset + 4 <= size) {
    const unsigned char header = bytes[offset];
    const bool last = (header & 0x80) != 0;
    const unsigned type = header & 0x7F;
    const std::size_t length = (static_cast<std::size_t>(bytes[offset + 1]) << 16) |
                               (static_cast<std::size_t>(bytes[offset + 2]) << 8) |
                               static_cast<std::size_t>(bytes[offset + 3]);
    offset += 4;
    if (type == 0) {
      if (length < 34 || offset + 34 > size) {
        info.error = "truncated stream info";
        return info;
      }
      flac::parseStreamInfo(bytes + offset, info);
      return info;
    }
    if (last) {
      info.error = "no stream info block";
      return info;
    }
    offset += length;
  }
  info.error = "no metadata blocks";
  return info;
}

/** Reads just the header of a file and probes it. */
inline FlacInfo probeFlacFile(const std::string& path) {
  std::FILE* file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    FlacInfo info;
    info.error = "cannot open file";
    return info;
  }
  std::vector<unsigned char> buffer(64 * 1024);
  const std::size_t read = std::fread(buffer.data(), 1, buffer.size(), file);
  std::fclose(file);
  return probeFlac(buffer.data(), read);
}

/** Convenience for the importer: decides whether a path needs conversion. */
inline bool needsFlacConversion(const std::string& path) {
  const FlacInfo info = probeFlacFile(path);
  return info.isFlac;
}

}  // namespace auragrid
