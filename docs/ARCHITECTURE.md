# AuraGrid — System Architecture

## 1. Layering

```
┌──────────────────────────────────────────────────────────────────────────┐
│  UI (React, TSX)          AuraGridInterface.tsx                          │
│  PadGrid · MixerDrawer · WaveformView · XYPad · usePadHaptics            │
└───────────────▲──────────────────────────────┬───────────────────────────┘
                │ 60 Hz state frames           │ intent (trigger, fx, deck)
┌───────────────┴──────────────────────────────▼───────────────────────────┐
│  Control plane (TS)                                                      │
│  AudioEngine (transport, decks, fx, stems, telemetry)                    │
│  LaunchpadMidiManager (ledger → SysEx frames, pad events out)            │
│  AuraGridAgent (key/bpm matching, co-pilot, mesh clock)                  │
└───────────────▲──────────────────────────────┬───────────────────────────┘
                │ lock-free rings (no alloc)   │ JSI host functions (sync)
┌───────────────┴──────────────────────────────▼───────────────────────────┐
│  Realtime core (C++20, Oboe)                                             │
│  OboeAudioEngine: 4 decks × 2 voices × 4 stems, biquad, stutter,         │
│  tape delay, master limiter, sample-accurate transport                   │
└───────────────▲──────────────────────────────┬───────────────────────────┘
                │ AAudio exclusive / low-latency│
┌───────────────┴──────────────────────────────▼───────────────────────────┐
│  Android: ForegroundAudioService · AudioFocus · USB-MIDI host bridge     │
└──────────────────────────────────────────────────────────────────────────┘
```

**Rule that keeps latency low:** the audio callback never touches JS, never
allocates, never locks, never logs. It reads a command ring buffer and writes an
event ring buffer. Everything else is bookkeeping that may be late.

## 2. Threads and their budgets

| Thread | Owner | Budget | Hard rule |
|---|---|---|---|
| Audio callback | Oboe / AAudio | frames / sampleRate (e.g. 128 @ 48 k = 2.67 ms) | no alloc, no lock, no syscall, no JNI |
| MIDI in/out | `MidiUsbModule.kt` | < 1 ms per packet | parse + enqueue only |
| JS event loop | React Native | 16.6 ms | no DSP, no per-frame allocation |
| LED flush | `LaunchpadMidiManager` | 16 ms tick, ≤ 512 B per SysEx | diff only, never repaint the full grid |
| Agent | `AuraGridAgent` | 50 ms tick | look-ahead scheduling, no audio work |

## 3. Latency budget (why sub-8 ms is a build target, not a promise)

```
touch → JS intent          ~2–4 ms   (batched, unavoidable in RN)
JSI call → command ring    < 0.1 ms
audio callback quantum      2.7 ms    (128 frames @ 48 kHz)
output buffer + HAL         2–4 ms    (exclusive mode, device codec)
────────────────────────────────────
median round-trip           4–8 ms    flagship device
```

Achieved only with: `PerformanceMode::LowLatency`, `SharingMode::Exclusive`,
`setSampleRate(48000)`, `setFramesPerCallback(128)`, and **no JS in the callback**.
`OboeAudioEngine::latencyMs()` reports the measured stream latency; the UI shows
the real number, never a constant.

## 4. Folder map

```
src/
  engine/
    types.ts             shared contracts (Deck, Stem, FxParam, telemetry)
    AuraNative.ts        JSI binding lookup + silent fallback bridge
    AudioEngine.ts       deck/transport/fx/stem API, telemetry, event pump
  midi/
    types.ts             PadState, DefineCoord, MidiTransport
    LaunchpadProfiles.ts device constants (sysex header, index math, CC map)
    LaunchpadMidiManager.ts   bidirectional engine, diff ledger, chunked SysEx
    NativeUsbMidiTransport.ts Android USB host transport (+ mock)
  agent/
    harmonic.ts          Camelot wheel, Krumhansl key estimation, compatibility
    MeshClockSync.ts     ping/pong offset + drift, master election
    MeshTransport.ts     transport interface, loopback impl
    StemSeparator.ts     job queue for on-device 4-stem separation
    AuraGridAgent.ts     matching, co-pilot transitions, suggestion engine
  components/            pad matrix, mixer drawer, waveform, xy pad, haptics
  theme/aura.ts          design tokens
android/app/src/main/
  cpp/
    OboeAudioEngine.hpp/.cpp  realtime core
    LockFreeRingBuffer.hpp    SPSC rings used by the core
    AudioCommand.hpp          POD command/event structs shared with JSI
    JsiAudioBindings.cpp      host object: installs globalThis.__AURAGRID_CORE__
    CMakeLists.txt
  java/com/auragrid/launchpad/
    MidiUsbModule.kt           USB host MIDI ↔ JS
    AudioForegroundService.kt  keeps the stream alive backgrounded
```

## 5. Data flow of a pad hit

1. USB-MIDI packet → `MidiUsbModule.kt` → JS event `AuraMidi:message`.
2. `LaunchpadMidiManager` decodes note/CC → `PadEvent{deck, pad, velocity}`.
3. `AuraGridInterface` calls `audioEngine.triggerPad(deck, pad, velocity)`.
4. JSI host function writes an `AudioCommand` into the SPSC command ring.
5. Oboe callback consumes the command, starts the voice, applies velocity gain.
6. Callback pushes `EngineEvent{voiceEnded}` into the event ring.
7. JS drains the event ring on a 60 Hz tick → LED returns to idle, UI meter drops.

## 6. Architectural decisions

- **JSI over the bridge.** A bridged call costs 0.5–2 ms and allocates. JSI host
  functions are synchronous and allocation-free at call time.
- **Deck = 2 voices.** Clip A plus incoming clip B gives crossfades and transitions
  without a per-pad voice pool; 4 stems ride along inside each voice.
- **LED diff ledger.** Repainting 64 pads per frame at 60 Hz is ~3.8 kB/s of USB
  SysEx. The ledger sends only changed pads, chunked to ≤ 128 payload bytes.
- **Agent look-ahead, not React state.** Transitions are scheduled on a monotonic
  timeline with 120 ms look-ahead so a dropped JS frame cannot smear a filter sweep.
- **Silent fallback bridge.** The app must not be dead on a simulator: the same
  `AudioEngine` API drives a transport-accurate no-audio bridge, so agent and UI
  logic is verifiable in CI without a device.
- **Profiles as data.** Firmware changes the LED map, not the engine.
