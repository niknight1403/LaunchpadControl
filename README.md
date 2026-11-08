# LaunchpadControl — Codename **AuraGrid**

Low-latency live-audio performance & DJ system for Android phones and tablets.
Hardware-first: a Novation Launchpad MK3 is the primary surface, the touch
screen is the second surface. Built for stage and club use, not for demos.

| | |
|---|---|
| **Platform** | Android 10+ (API 29), arm64-v8a primary, armeabi-v7a secondary |
| **Framework** | Expo SDK 54 · React Native 0.81 · TypeScript (strict) |
| **DSP core** | C++20 · Google Oboe (AAudio / OpenSL ES) via JSI, no bridge hops on the audio path |
| **Round-trip target** | < 8 ms buffer latency (device dependent, measured, not assumed) |
| **Control surface** | Novation Launchpad Mini MK3 / X / Pro MK3 over USB-C host mode |
| **State** | Architecture + core code complete, native build required for audio |

## What is in here

```
src/engine/       TS control plane for the native realtime core (JSI bridge, transport, telemetry)
src/midi/         Bidirectional Launchpad driver: SysEx RGB protocol, input decode, frame flushing
src/agent/        AuraGrid agent: harmonic/BPM matching, co-pilot transitions, stem jobs, P2P mesh clock
src/components/   AuraGrid UI: 8x8 pad matrix, mixer drawer, waveform, XY FX surface
src/theme/        Cyber-neon OLED design tokens
android/          Oboe engine, JSI bindings, USB-MIDI bridge, foreground audio service
docs/             Architecture, latency budget, build + verification
```

## Quick start

```bash
npm install
npx expo install --fix        # align native module versions with SDK 54
npx expo prebuild --platform android
npm run android               # builds the C++ core through CMake
```

The app **runs without the native core**: `src/engine/AuraNative.ts` falls back to
a transport-accurate silent bridge, so UI, MIDI logic and the agent are testable
on a simulator. Real audio needs the prebuild. See [docs/BUILD.md](docs/BUILD.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system diagram, thread model, latency budget, folder map
- [docs/BUILD.md](docs/BUILD.md) — NDK, CMake, foreground service, on-device latency verification
- [docs/MIDI.md](docs/MIDI.md) — Launchpad SysEx protocol, LED index math, control mapping

## Design language

Pitch-black OLED base `#0B0F19`, glass surfaces `#161C2E` at 60% with 1 px borders,
accents Cyber Cyan `#00F2FE`, Cyber Pink `#FF007F`, Acid Green `#39FF14`.
Haptics scale with pad velocity. Layout adapts: vertical quick-deck on phones,
horizontal dual-grid studio on tablets.

## Status / honest limitations

- The stem separator ships as an interface plus job runner. The separation model
  (ONNX Runtime Mobile, 4-stem) is **not** bundled: it is a multi-hundred-megabyte
  artifact and a licensing decision, not a code decision. See `src/agent/StemSeparator.ts`.
- P2P mesh sync ships with a transport-agnostic clock protocol and a loopback
  transport. Wiring it to `react-native-udp` or `react-native-webrtc` is a few
  lines in `src/agent/MeshTransport.ts`; no server is involved.
- Hardware constants (LED index math, side-column CCs) are data in
  `src/midi/LaunchpadProfiles.ts`. If a firmware revision disagrees, fix the table,
  not the engine.
