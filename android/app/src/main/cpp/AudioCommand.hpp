// AudioCommand.hpp — POD messages crossing the JSI/audio boundary.
//
// Two rules make this file boring in a good way:
//   1. Trivially copyable, fixed size. Nothing here may allocate.
//   2. Values are already normalised (0..1) on the JS side. The callback does
//      no unit conversion, no clamping loops, no validation branches.

#pragma once

#include <cstdint>

namespace auragrid {

enum class CommandType : int32_t {
  kNone = 0,
  kLoadClip = 1,     // deck, clipSlot, bpm
  kUnloadClip = 2,   // deck, clipSlot
  kTriggerPad = 3,   // deck, pad, value = velocity
  kStopDeck = 4,     // deck
  kDeckGain = 5,     // deck, value
  kStemGain = 6,     // deck, stem (a), value
  kFx = 7,           // deck, param (a), value
  kMasterGain = 8,   // value
  kTransport = 9,    // value = bpm, value2 = phase beats
  kCrossfader = 10,  // value
  kSetLoop = 11,     // deck, startFrame, endFrame (frames, not floats)
  kClearLoop = 12,   // deck
  kDeckRate = 13,    // deck, value = playback rate multiplier
  kSeek = 14,        // deck, frameA = target source frame
};

enum class FxSlot : int32_t {
  kFilterCutoff = 0,
  kFilterResonance = 1,
  kFilterMode = 2,
  kStutterRate = 3,
  kStutterMix = 4,
  kDelayMix = 5,
  kDelayFeedback = 6,
  kDelayDrift = 7,
  kDrive = 8,
};

enum class EventType : int32_t {
  kVoiceEnded = 1,
  kCommandDropped = 2,
  kUnderrun = 3,
};

struct AudioCommand {
  CommandType type = CommandType::kNone;
  int32_t deck = 0;
  int32_t a = 0;      // pad index, stem index, fx slot, clip slot
  int32_t b = 0;      // reserved
  float value = 0.f;  // normalised parameter or bpm
  float value2 = 0.f; // phase beats for transport
  // Loop boundaries in *frames*. float would lose precision past ~16 M frames,
  // which is only 6 minutes at 48 kHz — the length of a track.
  int64_t frameA = 0;
  int64_t frameB = 0;
};

/**
 * One interleaved stereo frame for the recording ring.
 * Trivially copyable so the SPSC ring can carry it without allocating.
 */
struct StereoFrame {
  float left = 0.f;
  float right = 0.f;
};

struct EngineEvent {
  EventType type = EventType::kVoiceEnded;
  int32_t deck = 0;
  int32_t pad = 0;
};

constexpr int kMaxDecks = 4;
constexpr int kStemsPerVoice = 4;
constexpr int kVoicesPerDeck = 2;
constexpr int kClipSlots = 32;

}  // namespace auragrid
