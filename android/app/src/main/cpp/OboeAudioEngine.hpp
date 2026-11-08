// OboeAudioEngine.hpp — hard-realtime audio core.
//
// Design contract, and every line below serves it:
//   * The callback never allocates, locks, logs, throws or calls into JNI.
//   * Everything variable lives in pre-allocated vectors, sized in start().
//   * All control arrives through one SPSC command ring; all feedback leaves
//     through one SPSC event ring.
//   * Decoding (file I/O, allocation) happens on the JSI thread, never here.

#pragma once

#include <oboe/Oboe.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "AudioCommand.hpp"
#include "LockFreeRingBuffer.hpp"
#include "SvfFilter.hpp"

namespace auragrid {

/** One decoded source. Stem 0 is the full mix when no separation exists. */
struct Clip {
  int32_t sampleRate = 48000;
  int64_t frames = 0;
  int stemCount = 1;
  double bpm = 120.0;
  bool ok = false;
  /** Interleaved stereo per stem; stems[0] && stems[1] used when stemCount == 1. */
  std::array<std::vector<float>, kStemsPerVoice> stems;
};

class OboeAudioEngine : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
 public:
  OboeAudioEngine();
  ~OboeAudioEngine() override;

  // ── lifecycle ────────────────────────────────────────────────────────────
  bool start(int32_t sampleRate, int32_t framesPerBuffer, float maxDelaySeconds);
  void stop();
  bool isRunning() const { return running_.load(std::memory_order_acquire); }

  // ── clip bank ────────────────────────────────────────────────────────────
  /** Decodes a WAV into the deck's next free bank slot, returns the slot id. */
  int32_t loadClip(int32_t deck, const std::string& path, double bpm);
  void unloadClip(int32_t deck, int32_t clipSlot);

  // ── performance ──────────────────────────────────────────────────────────
  void triggerPad(int32_t deck, int32_t pad, float velocity);
  void stopDeck(int32_t deck);
  void setDeckGain(int32_t deck, float gain);
  void setStemGain(int32_t deck, int32_t stem, float gain);
  void setFx(int32_t deck, int32_t slot, float value);
  void setMasterGain(float gain);
  void setTransport(double bpm, double phaseBeats);
  void setCrossfader(float value);
  /** Loop between two source frames; ignored when endFrame <= startFrame. */
  void setLoop(int32_t deck, int64_t startFrame, int64_t endFrame);
  void clearLoop(int32_t deck);
  /** Playback rate multiplier for beatmatching, 0.5..2.0. */
  void setDeckRate(int32_t deck, float rate);
  /** Jumps the playing voices to a source frame. */
  void seek(int32_t deck, int64_t frame);

  // ── telemetry ────────────────────────────────────────────────────────────
  double latencyMs() const;
  double cpuLoad() const;
  int32_t xruns() const { return xruns_.load(std::memory_order_relaxed); }
  int32_t activeVoices() const { return activeVoices_.load(std::memory_order_relaxed); }
  float masterPeak() const { return masterPeak_.load(std::memory_order_relaxed); }
  double transportBeats() const { return transportBeats_.load(std::memory_order_relaxed); }

  /** Drains the event ring on the JS thread. */
  std::vector<EngineEvent> drainEvents(std::size_t maxEvents);

  // oboe::AudioStreamDataCallback
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) override;
  // oboe::AudioStreamErrorCallback
  void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) override;

 private:
  struct Voice {
    Clip* clip = nullptr;
    double position = 0.0;      // in source frames
    double increment = 1.0;     // source frames per output frame
    double baseIncrement = 1.0; // increment at rate 1.0, before the deck rate
    float velocity = 1.0f;
    float fade = 0.0f;       // 0..1 declick ramp
    int32_t pad = 0;
    bool active = false;
    bool releasing = false;
  };

  struct Deck {
    std::array<Voice, kVoicesPerDeck> voices;
    std::array<float, kStemsPerVoice> stemGain{{1.f, 1.f, 1.f, 1.f}};
    float gain = 1.0f;
    float velocityTarget = 1.0f;

    SvfFilter filterL;
    SvfFilter filterR;
    float cutoff = 1.0f;
    float resonance = 0.25f;

    float stutterRate = 0.f;
    float stutterMix = 0.f;
    std::vector<float> captureL;
    std::vector<float> captureR;
    std::size_t captureWrite = 0;
    double stutterRead = 0.0;

    float delayMix = 0.f;
    float delayFeedback = 0.35f;
    float delayDrift = 0.f;
    std::vector<float> delayL;
    std::vector<float> delayR;
    std::size_t delayWrite = 0;
    double delaySamples = 0.0;
    double driftPhase = 0.0;

    float drive = 1.0f;
    float crossfadeGain = 1.f;
    float peak = 0.f;

    int64_t loopStart = 0;
    int64_t loopEnd = 0;
    bool loopEnabled = false;
    float rate = 1.0f;
  };

  void handleCommand(const AudioCommand& command);
  void renderDeck(Deck& deck, float* outLeft, float* outRight, int32_t frames);
  void resetDeckBuffers(Deck& deck, double sampleRate, float maxDelaySeconds);
  void pushEvent(EventType type, int32_t deck, int32_t pad);
  int32_t bankSlot(int32_t deck, int32_t pad) const { return deck * kPadsPerDeck + (pad % kPadsPerDeck); }

  static constexpr int32_t kPadsPerDeck = 8;

  LockFreeRingBuffer<AudioCommand> commands_{256};
  LockFreeRingBuffer<EngineEvent> events_{256};

  std::shared_ptr<oboe::AudioStream> stream_;
  std::mutex streamMutex_;
  std::mutex clipMutex_;

  /** Audio thread reads the pointer, JSI thread owns the memory. */
  std::array<std::atomic<Clip*>, kClipSlots> clipBank_{};
  std::vector<std::unique_ptr<Clip>> ownedClips_;

  std::array<Deck, kMaxDecks> decks_{};
  std::array<int32_t, kMaxDecks> nextBankSlot_{};

  std::atomic<bool> running_{false};
  std::atomic<double> cpuLoad_{0.0};
  std::atomic<int32_t> xruns_{0};
  std::atomic<int32_t> activeVoices_{0};
  std::atomic<float> masterPeak_{0.f};
  std::atomic<float> masterGain_{0.85f};
  std::atomic<float> crossfader_{0.5f};
  std::atomic<double> transportBpm_{124.0};
  std::atomic<double> transportBeats_{0.0};

  int32_t sampleRate_ = 48000;
  int32_t framesPerBuffer_ = 128;
  float maxDelaySeconds_ = 2.f;
};

}  // namespace auragrid
