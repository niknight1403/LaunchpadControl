# Build & on-device verification

Everything below is required to hear sound. Without it the app runs on the
silent bridge, which is fine for UI, MIDI and agent work.

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | 20+ | Expo SDK 54 |
| JDK | 17 | AGP 8.x |
| Android SDK | compile 35, min 29 | Foreground service types need 34+ |
| NDK | 27.1.12297006 | C++20, matching the entries in `app.json` |
| CMake | 3.22+ | ships with the NDK |

```bash
npm install
npx expo install --fix
npx expo prebuild --platform android --no-clean
```

`--no-clean` matters: the native sources in `android/app/src/main/cpp` and
`android/app/src/main/java/com/auragrid/launchpad` are committed, and a clean
prebuild deletes them.

## 2. Wire the C++ core into Gradle

In `android/app/build.gradle`, inside `android { ... }`:

```gradle
externalNativeBuild {
    cmake {
        path "src/main/cpp/CMakeLists.txt"
        version "3.22.1"
    }
}
defaultConfig {
    ndk {
        abiFilters "arm64-v8a", "armeabi-v7a"
    }
    externalNativeBuild {
        cmake {
            cppFlags "-std=c++20"
        }
    }
}
```

`ReactAndroid`, `fbjni` and `oboe` resolve from the prefab packages that React
Native 0.81 and the Oboe Maven artifact provide. No binary blobs in the repo.

## 3. Register the native modules

In `android/app/src/main/java/.../MainApplication.kt`:

```kotlin
import com.auragrid.launchpad.AuraGridPackage
// inside getPackages():
packages.add(AuraGridPackage())
```

Then, once at app start, from JS:

```ts
import { NativeModules } from 'react-native';
NativeModules.AuraCore?.install();   // installs __AURAGRID_CORE__ (JSI host object)
```

If `install()` returns false, `src/engine/AuraNative.ts` falls back to the silent
bridge and the UI says `SILENT BRIDGE`. That is the honest failure mode: the app
tells you which path it took instead of pretending.

## 4. Foreground service, audio focus, battery

Merge `docs/android-manifest-reference.xml` into the generated manifest. Start
the service when a deck becomes audible:

```ts
import { NativeModules, Linking } from 'react-native';
// NativeModules.AuraService.start() if you wrap it; otherwise:
Linking.openURL('auragrid://service/start');
```

Ask for the battery exemption once, on first launch, and only once:

```ts
Linking.sendIntent('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
```

Without it, Android 13+ will throttle the audio thread after a few minutes of
screen-off play. On stage this is the difference between working and not.

## 5. Verify latency (measure, do not assume)

1. `adb logcat -s AuraGridCore` — `start()` logs the opening line:
   `Started 48000 Hz, 128 frames, latency 3.42 ms`.
2. In the app header, `LAT` shows `Oboe latency + one quantum`. A healthy
   flagship phone reports 3–5 ms.
3. `CPU` must stay below 0.5 with four decks and a delay tail. Above 0.8, the UI
   turns the chip pink and `XR` counts dropped callbacks.
4. Loopback check (needs a TRRS splitter): trigger a click on pad 1 and record
   it. The recorded offset from touch to sound is the real round trip. Expect
   4–8 ms; anything above 15 ms means the device refused the exclusive path and
   `start()` logged the shared fallback.

## 6. Stem separation (optional, deliberately not bundled)

`src/agent/StemSeparator.ts` expects a native module named `AuraStems` with
`separate(sourcePath, outputDir) -> { drums, bass, synth, vocals }`.

Two acceptable routes:

- **ONNX Runtime Mobile** with a 4-stem model, one inference pass per ~10 s
  chunk, overlap-add at the chunk edges.
- **A native library** (e.g. Demucs-lite port) exposing the same call.

Both ship a model file of a few hundred megabytes. That is a distribution and
licensing decision, so it stays out of the repository. Until it exists, the agent
mixes full mixes and says so.

FLAC: the core decodes WAV (PCM 16/24, float 32). For FLAC either link `libFLAC`
via prefab, or convert on import to a cached WAV — the import path is user-facing
and a one-second conversion is invisible next to a set.

## 7. Two test suites you can run without a device

```bash
npm run test:logic        # 37 checks: Camelot maths, MIDI wire format, timeline, mesh clock
g++ -std=c++20 -O2 -Iandroid/app/src/main/cpp \
    android/app/src/main/cpp/tests/core_selftest.cpp -o /tmp/core_selftest
/tmp/core_selftest        # 18 checks: ring buffer, filter stability, WAV decoder
```

Both run in CI on a plain Linux box. They exist because the failures that ruin a
set (a wrong note number, a filter that diverges, a decoder that lies about frame
counts) are all findable without hardware.

## 8. Hardware checklist before a gig

- Launchpad in programmer mode (the driver sends the SysEx, but some firmware
  revisions ignore it: press the Session/Note buttons once).
- USB permission dialog accepted once; it reappears after every replug on some
  OEM builds.
- Airplane mode on, Wi-Fi off unless the mesh needs it.
- Screen stays on: the foreground service holds a wake lock, but check it.
- Battery above 40 %: the limiter is not a substitute for a charger.
