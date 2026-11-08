// core_selftest.cpp — host-compilable checks for the parts of the core that do
// not need a device: the ring buffer, the filter, and the WAV decoder.
//
//   g++ -std=c++20 -O2 -Iandroid/app/src/main/cpp
//       android/app/src/main/cpp/tests/core_selftest.cpp -o /tmp/core_selftest
//   /tmp/core_selftest
//
// Deliberately dependency-free: this runs in CI on a plain Linux box, so a
// broken ring buffer or decoder is caught before an NDK build.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../FlacProbe.hpp"
#include "../LockFreeRingBuffer.hpp"
#include "../SvfFilter.hpp"
#include "../WavReader.hpp"

namespace {

int gPassed = 0;
int gFailed = 0;

void check(const char* name, bool condition, const char* detail = "") {
  if (condition) {
    ++gPassed;
    std::printf("  ok   %s\n", name);
  } else {
    ++gFailed;
    std::printf("  FAIL %s%s%s\n", name, detail[0] ? " — " : "", detail);
  }
}

void writeInt16Wav(const std::string& path, int32_t sampleRate, int16_t channels, int32_t frames) {
  std::ofstream file(path, std::ios::binary);
  const uint32_t dataSize = static_cast<uint32_t>(frames) * channels * 2;
  const uint32_t riffSize = 36 + dataSize;

  auto write32 = [&](uint32_t value) {
    const unsigned char bytes[4] = {
        static_cast<unsigned char>(value & 0xff), static_cast<unsigned char>((value >> 8) & 0xff),
        static_cast<unsigned char>((value >> 16) & 0xff), static_cast<unsigned char>((value >> 24) & 0xff)};
    file.write(reinterpret_cast<const char*>(bytes), 4);
  };
  auto write16 = [&](uint16_t value) {
    const unsigned char bytes[2] = {static_cast<unsigned char>(value & 0xff),
                                    static_cast<unsigned char>((value >> 8) & 0xff)};
    file.write(reinterpret_cast<const char*>(bytes), 2);
  };

  file.write("RIFF", 4);
  write32(riffSize);
  file.write("WAVE", 4);
  file.write("fmt ", 4);
  write32(16);
  write16(1);  // PCM
  write16(static_cast<uint16_t>(channels));
  write32(static_cast<uint32_t>(sampleRate));
  write32(static_cast<uint32_t>(sampleRate * channels * 2));
  write16(static_cast<uint16_t>(channels * 2));
  write16(16);
  file.write("data", 4);
  write32(dataSize);

  for (int32_t frame = 0; frame < frames; ++frame) {
    for (int16_t channel = 0; channel < channels; ++channel) {
      // Ramp from -0.5 to +0.5 so the decoder can be checked numerically.
      const double value = -0.5 + static_cast<double>(frame) / (frames > 1 ? frames - 1 : 1);
      const int16_t pcm = static_cast<int16_t>(value * 32767.0);
      const unsigned char bytes[2] = {static_cast<unsigned char>(pcm & 0xff),
                                      static_cast<unsigned char>((pcm >> 8) & 0xff)};
      file.write(reinterpret_cast<const char*>(bytes), 2);
    }
  }
}

void testRingBuffer() {
  std::printf("\nLockFreeRingBuffer\n");
  auragrid::LockFreeRingBuffer<int> ring(8);
  check("capacity rounds up to a power of two", ring.capacity() == 8);

  for (int i = 0; i < 8; ++i) ring.push(i);
  check("full buffer rejects the next push", !ring.push(99));

  int value = -1;
  bool orderOk = true;
  for (int i = 0; i < 8; ++i) {
    if (!ring.pop(value) || value != i) orderOk = false;
  }
  check("FIFO order preserved", orderOk);
  check("drained buffer is empty", ring.empty());

  // Wrap-around: force the indices past the mask several times.
  int wrapOk = 0;
  for (int round = 0; round < 100; ++round) {
    ring.push(round);
    if (ring.pop(value) && value == round) ++wrapOk;
  }
  check("wrap-around stays correct", wrapOk == 100);
}

void testFilter() {
  std::printf("\nSvfFilter\n");
  auragrid::SvfFilter filter;
  filter.prepare(48000.0);

  bool finite = true;
  for (float cutoff : {0.0f, 0.001f, 0.5f, 0.99f, 1.0f}) {
    filter.setCutoff(cutoff);
    filter.setResonance(0.95f);
    for (int i = 0; i < 4096; ++i) {
      const float out = filter.process(std::sin(static_cast<float>(i) * 0.05f));
      if (!std::isfinite(out)) finite = false;
    }
  }
  check("stable across the whole cutoff range at high resonance", finite);

  filter.reset();
  filter.setCutoff(0.05f);  // very low: a lowpass must strongly attenuate
  filter.setResonance(0.0f);
  float peak = 0.f;
  for (int i = 0; i < 48000; ++i) {
    const float out = filter.process(std::sin(static_cast<float>(i) * 0.5f));
    peak = std::max(peak, std::fabs(out));
  }
  check("lowpass attenuates a 3.8 kHz tone below unity", peak < 0.5f);

  check("soft clip never exceeds full scale",
        std::fabs(auragrid::softClip(10.f, 1.6f)) <= 1.0f &&
            std::fabs(auragrid::softClip(1.f, 1.6f) - 1.0f) < 1e-6f);
}

void testWavDecoder() {
  std::printf("\nWavReader\n");
  const std::string path = "/tmp/auragrid_selftest.wav";
  writeInt16Wav(path, 44100, 2, 1000);
  auragrid::WavData data = auragrid::decodeWav(path);
  check("decodes a stereo PCM16 file", data.ok, data.error.c_str());
  check("frame count", data.frames == 1000);
  check("sample rate preserved", data.sampleRate == 44100);
  check("interleaved stereo output", data.samples.size() == 2000);
  check("first sample matches the ramp", std::fabs(data.samples[0] + 0.5f) < 0.01f);
  check("channel copy is intact", std::fabs(data.samples[0] - data.samples[1]) < 1e-6f);

  const std::string monoPath = "/tmp/auragrid_selftest_mono.wav";
  writeInt16Wav(monoPath, 48000, 1, 512);
  auragrid::WavData mono = auragrid::decodeWav(monoPath);
  check("decodes a mono file", mono.ok, mono.error.c_str());
  check("mono is duplicated to stereo", mono.samples.size() == 1024);
  check("mono channels match", std::fabs(mono.samples[2] - mono.samples[3]) < 1e-6f);

  auragrid::WavData missing = auragrid::decodeWav("/tmp/does-not-exist.wav");
  check("missing file reports an error instead of crashing", !missing.ok && !missing.error.empty());

  std::remove(path.c_str());
  std::remove(monoPath.c_str());
}


/** Writes a FLAC header with a STREAMINFO block, enough for the probe. */
std::string writeFlacHeader(const std::string& path, int32_t sampleRate, int32_t channels, int32_t bits,
                            int64_t totalSamples, bool lastBlock = true) {
  std::vector<unsigned char> bytes;
  const unsigned char magic[4] = {'f', 'L', 'a', 'C'};
  bytes.insert(bytes.end(), magic, magic + 4);

  bytes.push_back(static_cast<unsigned char>((lastBlock ? 0x80 : 0x00) | 0x00));  // STREAMINFO
  bytes.push_back(0);
  bytes.push_back(0);
  bytes.push_back(34);

  bytes.push_back(0x10);  // min block size 4096
  bytes.push_back(0x00);
  bytes.push_back(0x10);  // max block size 4096
  bytes.push_back(0x00);
  for (int index = 0; index < 6; ++index) bytes.push_back(0);  // min/max frame size (3 + 3)
  // 34-byte body so far: 2 block min + 2 block max + 3 frame min + 3 frame max.

  const uint64_t packed = (static_cast<uint64_t>(sampleRate) << 44) |
                          (static_cast<uint64_t>(channels - 1) << 41) |
                          (static_cast<uint64_t>(bits - 1) << 36) |
                          (static_cast<uint64_t>(totalSamples) & 0xFFFFFFFFFULL);
  for (int shift = 56; shift >= 0; shift -= 8) bytes.push_back(static_cast<unsigned char>((packed >> shift) & 0xFF));
  for (int index = 0; index < 16; ++index) bytes.push_back(static_cast<unsigned char>(0xAB));  // md5

  std::ofstream file(path, std::ios::binary);
  file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  return path;
}

void testFlacProbe() {
  std::printf("\nflac probe\n");
  const std::string path = writeFlacHeader("/tmp/auragrid_selftest_flac.flac", 44100, 2, 16, 44100 * 372);

  const auragrid::FlacInfo info = auragrid::probeFlacFile(path);
  check("a flac header is recognised", info.isFlac, info.error.c_str());
  check("the stream info parses", info.ok, info.error.c_str());
  check("sample rate is read", info.sampleRate == 44100);
  check("channel count is read", info.channels == 2);
  check("bit depth is read", info.bitsPerSample == 16);
  check("total samples are read", info.totalSamples == 44100LL * 372);
  check("duration is derived", info.durationMs >= 371000 && info.durationMs <= 373000);
  check("an md5 is reported when present", info.md5.size() == 32);

  const unsigned char notFlac[8] = {'R', 'I', 'F', 'F', 0, 0, 0, 0};
  const auragrid::FlacInfo riff = auragrid::probeFlac(notFlac, sizeof(notFlac));
  check("a wav file is not mistaken for flac", !riff.isFlac && !riff.ok);

  const auragrid::FlacInfo empty = auragrid::probeFlac(notFlac, 0);
  check("an empty buffer is refused", !empty.ok && !empty.error.empty());

  const unsigned char truncated[6] = {'f', 'L', 'a', 'C', 0x80, 0x00};
  const auragrid::FlacInfo cut = auragrid::probeFlac(truncated, sizeof(truncated));
  check("a truncated header is refused", cut.isFlac && !cut.ok, cut.error.c_str());

  const std::string hostile = writeFlacHeader("/tmp/auragrid_selftest_flac_bad.flac", 0, 2, 16, 1000);
  const auragrid::FlacInfo bad = auragrid::probeFlacFile(hostile);
  check("an implausible sample rate is refused", !bad.ok, bad.error.c_str());

  check("a missing file reports an error", !auragrid::probeFlacFile("/tmp/no-such-file.flac").ok);
  check("needsFlacConversion is true for flac", auragrid::needsFlacConversion(path));

  std::remove(path.c_str());
  std::remove(hostile.c_str());
}

}  // namespace

int main() {
  std::printf("AuraGrid core self-test\n");
  testRingBuffer();
  testFilter();
  testWavDecoder();
  testFlacProbe();
  std::printf("\n%d passed, %d failed\n", gPassed, gFailed);
  return gFailed == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
