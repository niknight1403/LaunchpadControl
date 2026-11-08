// OboeAudioEngine.cpp — see OboeAudioEngine.hpp for the contract this file must keep.

#include "OboeAudioEngine.hpp"

#include <android/log.h>

#include <algorithm>
#include <chrono>
#include <cmath>

#include "WavReader.hpp"

#define AURA_LOG(...) __android_log_print(ANDROID_LOG_INFO, "AuraGridCore", __VA_ARGS__)
#define AURA_ERR(...) __android_log_print(ANDROID_LOG_ERROR, "AuraGridCore", __VA_ARGS__)

namespace auragrid {

namespace {
constexpr std::size_t kCaptureFrames = 1u << 14;  // 16384 frames ≈ 341 ms @ 48k
constexpr int32_t kMaxCommandsPerBlock = 64;
constexpr double kDeclickMs = 3.0;
constexpr double kStopDeclickMs = 6.0;
constexpr double kDefaultDelaySeconds = 0.25;
}  // namespace

OboeAudioEngine::OboeAudioEngine() {
  for (auto& deck : decks_) {
    deck.filterL.prepare(48000.0);
    deck.filterR.prepare(48000.0);
  }
  nextBankSlot_.fill(0);
  clipBank_.fill(nullptr);
}

OboeAudioEngine::~OboeAudioEngine() { stop(); }

// ── lifecycle ──────────────────────────────────────────────────────────────

bool OboeAudioEngine::start(int32_t sampleRate, int32_t framesPerBuffer, float maxDelaySeconds) {
  std::lock_guard<std::mutex> lock(streamMutex_);
  if (running_.load(std::memory_order_acquire)) return true;

  sampleRate_ = sampleRate > 0 ? sampleRate : 48000;
  framesPerBuffer_ = framesPerBuffer > 0 ? framesPerBuffer : 128;
  maxDelaySeconds_ = maxDelaySeconds > 0.f ? maxDelaySeconds : 2.f;

  for (auto& deck : decks_) {
    resetDeckBuffers(deck, static_cast<double>(sampleRate_), maxDelaySeconds_);
  }

  oboe::AudioStreamBuilder builder;
  builder.setDirection(oboe::Direction::Output)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::Float)
      ->setChannelCount(oboe::ChannelCount::Stereo)
      ->setSampleRate(sampleRate_)
      ->setFramesPerDataCallback(framesPerBuffer_)
      ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::None)
      ->setDataCallback(this)
      ->setErrorCallback(this);

  oboe::Result result = builder.openStream(stream_);
  if (result != oboe::Result::OK) {
    // Exclusive is a request, not a guarantee: fall back rather than stay silent.
    AURA_ERR("Exclusive stream failed (%s), retrying shared", oboe::convertToText(result));
    oboe::AudioStreamBuilder fallback;
    fallback.setDirection(oboe::Direction::Output)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        ->setSharingMode(oboe::SharingMode::Shared)
        ->setFormat(oboe::AudioFormat::Float)
        ->setChannelCount(oboe::ChannelCount::Stereo)
        ->setSampleRate(sampleRate_)
        ->setFramesPerDataCallback(framesPerBuffer_)
        ->setDataCallback(this)
        ->setErrorCallback(this);
    result = fallback.openStream(stream_);
    if (result != oboe::Result::OK) {
      AURA_ERR("openStream failed: %s", oboe::convertToText(result));
      return false;
    }
  }

  stream_->setBufferSizeInFrames(framesPerBuffer_ * 2);
  result = stream_->requestStart();
  if (result != oboe::Result::OK) {
    AURA_ERR("requestStart failed: %s", oboe::convertToText(result));
    stream_.reset();
    return false;
  }

  running_.store(true, std::memory_order_release);
  AURA_LOG("Started %d Hz, %d frames, latency %.2f ms", sampleRate_, framesPerBuffer_, latencyMs());
  return true;
}

void OboeAudioEngine::stop() {
  std::lock_guard<std::mutex> lock(streamMutex_);
  if (stream_) {
    stream_->requestStop();
    stream_->close();
    stream_.reset();
  }
  running_.store(false, std::memory_order_release);
}

void OboeAudioEngine::resetDeckBuffers(Deck& deck, double sampleRate, float maxDelaySeconds) {
  deck.captureL.assign(kCaptureFrames, 0.f);
  deck.captureR.assign(kCaptureFrames, 0.f);
  const std::size_t delayFrames =
      static_cast<std::size_t>(sampleRate * std::max(0.1f, maxDelaySeconds)) + 4;
  deck.delayL.assign(delayFrames, 0.f);
  deck.delayR.assign(delayFrames, 0.f);
  deck.captureWrite = 0;
  deck.stutterRead = 0.0;
  deck.delayWrite = 0;
  deck.delaySamples = sampleRate * kDefaultDelaySeconds;
  deck.driftPhase = 0.0;
  deck.voices = {};
  deck.filterL.prepare(sampleRate);
  deck.filterR.prepare(sampleRate);
  deck.filterL.setCutoff(deck.cutoff);
  deck.filterR.setCutoff(deck.cutoff);
}

// ── clip bank ──────────────────────────────────────────────────────────────

int32_t OboeAudioEngine::loadClip(int32_t deck, const std::string& path, double bpm) {
  if (deck < 0 || deck >= kMaxDecks) return -1;

  WavData wav = decodeWav(path);
  if (!wav.ok) {
    AURA_ERR("loadClip failed for %s: %s", path.c_str(), wav.error.c_str());
    return -1;
  }

  auto clip = std::make_unique<Clip>();
  clip->sampleRate = wav.sampleRate;
  clip->frames = wav.frames;
  clip->bpm = bpm > 0 ? bpm : 120.0;
  clip->stemCount = 1;
  clip->stems[0] = std::move(wav.samples);
  clip->ok = true;

  Clip* raw = clip.get();

  std::lock_guard<std::mutex> lock(clipMutex_);
  ownedClips_.push_back(std::move(clip));

  const int32_t local = nextBankSlot_[deck] % kPadsPerDeck;
  nextBankSlot_[deck] = (local + 1) % kPadsPerDeck;
  const int32_t slot = deck * kPadsPerDeck + local;
  clipBank_[slot].store(raw, std::memory_order_release);
  return slot;
}

void OboeAudioEngine::unloadClip(int32_t deck, int32_t clipSlot) {
  if (clipSlot >= 0 && clipSlot < kClipSlots) {
    clipBank_[clipSlot].store(nullptr, std::memory_order_release);
  }
  // The Clip object stays owned by the engine: the audio thread may still be
  // reading it this block. Memory is reclaimed at stop() / engine destruction.
  (void)deck;
}

// ── performance commands (JSI thread) ──────────────────────────────────────

void OboeAudioEngine::triggerPad(int32_t deck, int32_t pad, float velocity) {
  AudioCommand command;
  command.type = CommandType::kTriggerPad;
  command.deck = deck;
  command.a = pad;
  command.value = velocity;
  if (!commands_.push(command)) pushEvent(EventType::kCommandDropped, deck, pad);
}

void OboeAudioEngine::stopDeck(int32_t deck) {
  AudioCommand command;
  command.type = CommandType::kStopDeck;
  command.deck = deck;
  if (!commands_.push(command)) pushEvent(EventType::kCommandDropped, deck, 0);
}

void OboeAudioEngine::setDeckGain(int32_t deck, float gain) {
  AudioCommand command;
  command.type = CommandType::kDeckGain;
  command.deck = deck;
  command.value = gain;
  commands_.push(command);
}

void OboeAudioEngine::setStemGain(int32_t deck, int32_t stem, float gain) {
  AudioCommand command;
  command.type = CommandType::kStemGain;
  command.deck = deck;
  command.a = stem;
  command.value = gain;
  commands_.push(command);
}

void OboeAudioEngine::setFx(int32_t deck, int32_t slot, float value) {
  AudioCommand command;
  command.type = CommandType::kFx;
  command.deck = deck;
  command.a = slot;
  command.value = value;
  commands_.push(command);
}

void OboeAudioEngine::setMasterGain(float gain) {
  masterGain_.store(std::clamp(gain, 0.f, 1.5f), std::memory_order_relaxed);
}

void OboeAudioEngine::setTransport(double bpm, double phaseBeats) {
  transportBpm_.store(bpm > 20.0 ? bpm : 120.0, std::memory_order_relaxed);
  if (phaseBeats >= 0) transportBeats_.store(phaseBeats, std::memory_order_relaxed);
}

void OboeAudioEngine::setCrossfader(float value) {
  crossfader_.store(std::clamp(value, 0.f, 1.f), std::memory_order_relaxed);
}

void OboeAudioEngine::setLoop(int32_t deck, int64_t startFrame, int64_t endFrame) {
  AudioCommand command;
  command.type = CommandType::kSetLoop;
  command.deck = deck;
  command.frameA = startFrame;
  command.frameB = endFrame;
  commands_.push(command);
}

void OboeAudioEngine::clearLoop(int32_t deck) {
  AudioCommand command;
  command.type = CommandType::kClearLoop;
  command.deck = deck;
  commands_.push(command);
}

void OboeAudioEngine::seek(int32_t deck, int64_t frame) {
  AudioCommand command;
  command.type = CommandType::kSeek;
  command.deck = deck;
  command.frameA = frame < 0 ? 0 : frame;
  commands_.push(command);
}

void OboeAudioEngine::setDeckRate(int32_t deck, float rate) {
  AudioCommand command;
  command.type = CommandType::kDeckRate;
  command.deck = deck;
  command.value = rate;
  commands_.push(command);
}

double OboeAudioEngine::latencyMs() const {
  if (!stream_) return 0.0;
  const double seconds = stream_->calculateLatencyMillis() / 1000.0;
  return seconds > 0 ? seconds * 1000.0 : 0.0;
}

double OboeAudioEngine::cpuLoad() const { return cpuLoad_.load(std::memory_order_relaxed); }

std::vector<EngineEvent> OboeAudioEngine::drainEvents(std::size_t maxEvents) {
  std::vector<EngineEvent> drained;
  drained.reserve(std::min<std::size_t>(maxEvents, 32));
  EngineEvent event;
  while (drained.size() < maxEvents && events_.pop(event)) {
    drained.push_back(event);
  }
  return drained;
}

void OboeAudioEngine::pushEvent(EventType type, int32_t deck, int32_t pad) {
  EngineEvent event;
  event.type = type;
  event.deck = deck;
  event.pad = pad;
  events_.push(event);
}

// ── command application (audio thread) ─────────────────────────────────────

void OboeAudioEngine::handleCommand(const AudioCommand& command) {
  if (command.deck < 0 || command.deck >= kMaxDecks) return;
  Deck& deck = decks_[static_cast<std::size_t>(command.deck)];

  switch (command.type) {
    case CommandType::kTriggerPad: {
      const int32_t slot = bankSlot(command.deck, command.a);
      Clip* clip = clipBank_[static_cast<std::size_t>(slot)].load(std::memory_order_acquire);
      if (clip == nullptr || !clip->ok) return;

      // Prefer a free voice; otherwise steal the one furthest into its clip.
      Voice* target = nullptr;
      for (auto& voice : deck.voices) {
        if (!voice.active) {
          target = &voice;
          break;
        }
        if (target == nullptr || voice.position > target->position) target = &voice;
      }
      if (target == nullptr) return;

      target->clip = clip;
      target->position = 0.0;
      target->pad = command.a;
      target->velocity = std::clamp(command.value, 0.f, 1.f);
      target->fade = 0.f;
      target->active = true;
      target->releasing = false;
      const double base = static_cast<double>(clip->sampleRate) / static_cast<double>(sampleRate_);
      const double tempo = transportBpm_.load(std::memory_order_relaxed) / clip->bpm;
      target->baseIncrement = base * (tempo > 0 ? tempo : 1.0);
      target->increment = target->baseIncrement * deck.rate;
      break;
    }
    case CommandType::kStopDeck: {
      for (auto& voice : deck.voices) {
        if (voice.active) voice.releasing = true;
      }
      break;
    }
    case CommandType::kDeckGain:
      deck.gain = std::clamp(command.value, 0.f, 1.5f);
      break;
    case CommandType::kStemGain: {
      if (command.a >= 0 && command.a < kStemsPerVoice) {
        deck.stemGain[static_cast<std::size_t>(command.a)] = std::clamp(command.value, 0.f, 1.5f);
      }
      break;
    }
    case CommandType::kFx: {
      const float value = std::clamp(command.value, 0.f, 1.f);
      switch (static_cast<FxSlot>(command.a)) {
        case FxSlot::kFilterCutoff:
          deck.cutoff = value;
          deck.filterL.setCutoff(value);
          deck.filterR.setCutoff(value);
          break;
        case FxSlot::kFilterResonance:
          deck.resonance = value;
          deck.filterL.setResonance(value);
          deck.filterR.setResonance(value);
          break;
        case FxSlot::kFilterMode: {
          const auto mode = value < 0.5f ? SvfFilter::Mode::kLowpass : SvfFilter::Mode::kHighpass;
          deck.filterL.setMode(mode);
          deck.filterR.setMode(mode);
          break;
        }
        case FxSlot::kStutterRate:
          deck.stutterRate = value;
          break;
        case FxSlot::kStutterMix:
          deck.stutterMix = value;
          break;
        case FxSlot::kDelayMix:
          deck.delayMix = value;
          break;
        case FxSlot::kDelayFeedback:
          deck.delayFeedback = value * 0.92f;
          break;
        case FxSlot::kDelayDrift:
          deck.delayDrift = value;
          break;
        case FxSlot::kDrive:
          deck.drive = 1.f + value * 3.f;
          break;
      }
      break;
    }
    case CommandType::kSetLoop: {
      if (command.frameB > command.frameA && command.frameA >= 0) {
        deck.loopStart = command.frameA;
        deck.loopEnd = command.frameB;
        deck.loopEnabled = true;
      }
      break;
    }
    case CommandType::kClearLoop: {
      deck.loopEnabled = false;
      deck.loopStart = 0;
      deck.loopEnd = 0;
      break;
    }
    case CommandType::kDeckRate: {
      const float rate = command.value < 0.25f ? 0.25f : (command.value > 4.f ? 4.f : command.value);
      deck.rate = rate;
      for (auto& voice : deck.voices) {
        voice.increment = voice.baseIncrement * rate;
      }
      break;
    }
    case CommandType::kSeek: {
      for (auto& voice : deck.voices) {
        if (!voice.active || voice.clip == nullptr) continue;
        const double target = static_cast<double>(command.frameA);
        voice.position = target < static_cast<double>(voice.clip->frames) ? target : 0.0;
      }
      break;
    }
    case CommandType::kUnloadClip: {
      const int32_t slot = command.a;
      if (slot >= 0 && slot < kClipSlots) clipBank_[static_cast<std::size_t>(slot)].store(nullptr);
      break;
    }
    default:
      break;
  }
}

// ── render ─────────────────────────────────────────────────────────────────

void OboeAudioEngine::renderDeck(Deck& deck, float* outLeft, float* outRight, int32_t frames) {
  const int32_t deckIndex = static_cast<int32_t>(&deck - decks_.data());
  std::fill(outLeft, outLeft + frames, 0.f);
  std::fill(outRight, outRight + frames, 0.f);

  const double fadeIncrement = 1.0 / (static_cast<double>(sampleRate_) * kDeclickMs / 1000.0);
  const double releaseIncrement = 1.0 / (static_cast<double>(sampleRate_) * kStopDeclickMs / 1000.0);

  // 1. voices → dry mix
  for (auto& voice : deck.voices) {
    if (!voice.active || voice.clip == nullptr) continue;
    Clip* clip = voice.clip;
    const bool stemsAvailable = clip->stemCount > 1;
    for (int32_t i = 0; i < frames; ++i) {
      if (voice.position >= static_cast<double>(clip->frames)) {
        voice.active = false;
        pushEvent(EventType::kVoiceEnded, deckIndex, voice.pad);
        break;
      }
      const int64_t index = static_cast<int64_t>(voice.position);
      const double fract = voice.position - static_cast<double>(index);
      const std::size_t base = static_cast<std::size_t>(index) * 2;

      float left = 0.f;
      float right = 0.f;

      if (stemsAvailable) {
        for (int stem = 0; stem < clip->stemCount && stem < kStemsPerVoice; ++stem) {
          const std::vector<float>& buffer = clip->stems[static_cast<std::size_t>(stem)];
          if (base + 3 >= buffer.size()) continue;
          const float gain = deck.stemGain[static_cast<std::size_t>(stem)];
          const float l0 = buffer[base];
          const float r0 = buffer[base + 1];
          const float l1 = buffer[base + 2];
          const float r1 = buffer[base + 3];
          left += (l0 + (l1 - l0) * static_cast<float>(fract)) * gain;
          right += (r0 + (r1 - r0) * static_cast<float>(fract)) * gain;
        }
      } else {
        const std::vector<float>& buffer = clip->stems[0];
        if (base + 3 < buffer.size()) {
          const float gain = deck.stemGain[0];
          const float l0 = buffer[base];
          const float r0 = buffer[base + 1];
          const float l1 = buffer[base + 2];
          const float r1 = buffer[base + 3];
          left = (l0 + (l1 - l0) * static_cast<float>(fract)) * gain;
          right = (r0 + (r1 - r0) * static_cast<float>(fract)) * gain;
        }
      }

      // Declick: fade in on start, fade out on release. Clicks are the one
      // artefact a crowd always hears.
      if (voice.fade < 1.0) voice.fade = std::min(1.0, voice.fade + fadeIncrement);
      if (voice.releasing) voice.fade = std::max(0.0, voice.fade - releaseIncrement);
      const float envelope = static_cast<float>(voice.fade) * voice.velocity;
      if (voice.releasing && voice.fade <= 0.0) {
        voice.active = false;
        pushEvent(EventType::kVoiceEnded, deckIndex, voice.pad);
        break;
      }

      outLeft[i] += left * envelope;
      outRight[i] += right * envelope;
      voice.position += voice.increment;

      // Loop wrap, sample accurate: subtract the loop length once, which keeps
      // the phase exact even if the increment is fractional (beat-matched).
      if (deck.loopEnabled && deck.loopEnd > deck.loopStart &&
          voice.position >= static_cast<double>(deck.loopEnd)) {
        const double length = static_cast<double>(deck.loopEnd - deck.loopStart);
        while (voice.position >= static_cast<double>(deck.loopEnd)) voice.position -= length;
      }
    }
  }

  // 2. per-channel filter, 3. stutter, 4. tape delay
  const double stutterAdvance = 1.0 + deck.stutterRate * 3.0;
  const double driftLfo = 2.0 * 3.14159265358979323846 * 0.35 / static_cast<double>(sampleRate_);
  const std::size_t captureMask = static_cast<std::size_t>(kCaptureFrames - 1);
  const std::size_t delaySize = deck.delayL.size();
  if (delaySize == 0) return;

  for (int32_t i = 0; i < frames; ++i) {
    float left = deck.filterL.process(outLeft[i]);
    float right = deck.filterR.process(outRight[i]);
    const float dryLeft = left;
    const float dryRight = right;

    // Capture ring feeds the granular stutter.
    deck.captureL[deck.captureWrite & captureMask] = left;
    deck.captureR[deck.captureWrite & captureMask] = right;

    if (deck.stutterMix > 0.001f) {
      deck.stutterRead += stutterAdvance;
      if (deck.stutterRead >= static_cast<double>(kCaptureFrames)) {
        deck.stutterRead -= static_cast<double>(kCaptureFrames);
      }
      const std::size_t readIndex = static_cast<std::size_t>(deck.stutterRead) & captureMask;
      const float wetLeft = deck.captureL[readIndex];
      const float wetRight = deck.captureR[readIndex];
      const float mix = deck.stutterMix;
      left = dryLeft * (1.f - mix) + wetLeft * mix;
      right = dryRight * (1.f - mix) + wetRight * mix;
    }
    deck.captureWrite = (deck.captureWrite + 1) & captureMask;

    // Tape delay: fixed 250 ms with a drift LFO on the read pointer.
    deck.driftPhase += driftLfo;
    if (deck.driftPhase > 2.0 * 3.14159265358979323846) deck.driftPhase -= 2.0 * 3.14159265358979323846;
    const double drift = 1.0 + deck.delayDrift * 0.03 * std::sin(deck.driftPhase);
    const double readOffset = deck.delaySamples * drift;
    double readPos = static_cast<double>(deck.delayWrite) - readOffset;
    while (readPos < 0.0) readPos += static_cast<double>(delaySize);
    const std::size_t readIndex = static_cast<std::size_t>(readPos) % delaySize;
    const float delayedLeft = deck.delayL[readIndex];
    const float delayedRight = deck.delayR[readIndex];

    deck.delayL[deck.delayWrite] = left + delayedLeft * deck.delayFeedback;
    deck.delayR[deck.delayWrite] = right + delayedRight * deck.delayFeedback;
    deck.delayWrite = (deck.delayWrite + 1) % delaySize;

    if (deck.delayMix > 0.001f) {
      left += delayedLeft * deck.delayMix;
      right += delayedRight * deck.delayMix;
    }

    outLeft[i] = left;
    outRight[i] = right;
  }

  // 5. gain, crossfader envelope, peak
  const float crossfade = deck.crossfadeGain;
  float peak = deck.peak;
  for (int32_t i = 0; i < frames; ++i) {
    outLeft[i] *= deck.gain * crossfade;
    outRight[i] *= deck.gain * crossfade;
    const float magnitude = std::max(std::fabs(outLeft[i]), std::fabs(outRight[i]));
    if (magnitude > peak) peak = magnitude;
  }
  // 200 ms release so the meter looks like a meter, not a lie.
  deck.peak = peak * 0.85f;
}

oboe::DataCallbackResult OboeAudioEngine::onAudioReady(oboe::AudioStream* stream, void* audioData,
                                                       int32_t numFrames) {
  const auto startTime = std::chrono::steady_clock::now();
  float* output = static_cast<float*>(audioData);
  if (output == nullptr || numFrames <= 0) return oboe::DataCallbackResult::Continue;

  // 1. apply pending control changes
  AudioCommand command;
  for (int32_t processed = 0; processed < kMaxCommandsPerBlock; ++processed) {
    if (!commands_.pop(command)) break;
    handleCommand(command);
  }

  // 2. crossfader gains (A/B pair on decks 1-2, deck gain covers the rest)
  const float fader = crossfader_.load(std::memory_order_relaxed);
  decks_[0].crossfadeGain = 1.f - fader;
  decks_[1].crossfadeGain = fader;
  decks_[2].crossfadeGain = 1.f;
  decks_[3].crossfadeGain = 1.f;

  // 3. render decks into the interleaved output
  constexpr int32_t kMaxBlock = 2048;
  float scratchLeft[kMaxBlock];
  float scratchRight[kMaxBlock];
  if (numFrames > kMaxBlock) return oboe::DataCallbackResult::Continue;

  std::fill(output, output + numFrames * 2, 0.f);

  int32_t voices = 0;
  for (auto& deck : decks_) {
    for (const auto& voice : deck.voices) {
      if (voice.active) ++voices;
    }
    renderDeck(deck, scratchLeft, scratchRight, numFrames);
    for (int32_t i = 0; i < numFrames; ++i) {
      output[i * 2] += scratchLeft[i];
      output[i * 2 + 1] += scratchRight[i];
    }
  }

  // 4. master gain + limiter
  const float master = masterGain_.load(std::memory_order_relaxed);
  float peak = 0.f;
  for (int32_t i = 0; i < numFrames; ++i) {
    float left = softClip(output[i * 2] * master, 1.6f);
    float right = softClip(output[i * 2 + 1] * master, 1.6f);
    output[i * 2] = left;
    output[i * 2 + 1] = right;
    const float magnitude = std::max(std::fabs(left), std::fabs(right));
    if (magnitude > peak) peak = magnitude;
  }

  // 5. transport + telemetry
  const double bpm = transportBpm_.load(std::memory_order_relaxed);
  const double beatsPerFrame = bpm / 60.0 / static_cast<double>(sampleRate_);
  transportBeats_.store(transportBeats_.load(std::memory_order_relaxed) + beatsPerFrame * numFrames,
                        std::memory_order_relaxed);
  activeVoices_.store(voices, std::memory_order_relaxed);
  masterPeak_.store(peak, std::memory_order_relaxed);

  const double elapsed = std::chrono::duration<double>(
                             std::chrono::steady_clock::now() - startTime)
                             .count();
  const double budget = static_cast<double>(numFrames) / static_cast<double>(sampleRate_);
  const double instant = budget > 0 ? elapsed / budget : 0.0;
  const double smoothed = cpuLoad_.load(std::memory_order_relaxed) * 0.9 + instant * 0.1;
  cpuLoad_.store(smoothed, std::memory_order_relaxed);
  if (instant > 1.0) xruns_.fetch_add(1, std::memory_order_relaxed);

  return oboe::DataCallbackResult::Continue;
}

void OboeAudioEngine::onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) {
  // Disconnected output (headphones yanked, USB DAC unplugged). Report it and
  // try one restart: a silent stage is worse than a click.
  AURA_ERR("stream error after close: %s", oboe::convertToText(error));
  pushEvent(EventType::kUnderrun, 0, 0);
  running_.store(false, std::memory_order_release);
  (void)stream;
  start(sampleRate_, framesPerBuffer_, maxDelaySeconds_);
}

}  // namespace auragrid
