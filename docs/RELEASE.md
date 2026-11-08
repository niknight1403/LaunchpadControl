# Release 1.0.0

What is in this release, what it was checked against, and what it still cannot do.

## Verify it yourself

```bash
npm install          # only needed for the full type check
tools/ci/check.sh    # type check + 314 logic checks + 18 core checks
```

The check script needs `typescript`, `esbuild` and `g++`. It does not need the
Android SDK — that is deliberate, so the logic can be verified on any machine.

## What was verified, and how

| Area | Evidence |
|---|---|
| Tempo detection | 120/128/85 BPM click tracks within ±2 BPM, silence returns nothing |
| Key detection | A-minor triad → 8A, C-major → 8B, chroma sums to 1 |
| FFT | tone lands in its own bin, Parseval energy conserved, non-pow2 rejected |
| Deck maths | beat→frame conversion, loop wrap frames, half/double-time sync, nudge clamps |
| Loops in the core | sample-accurate wrap, 64-bit frame fields |
| FX automation | LFO values from scheduled time, clamped, no writes after stop |
| Recording | WAV header sizes, clipping clamp, marker offsets, refused start |
| Presets | v1→v2 migration, roundtrip through storage, autosave coalescing |
| Mesh | preset propagation, master wins conflicts, takeover after loss, bar-aligned launch |
| Set builder | tempo window, no duplicate tracks, transition precedence, runner order |
| Diagnostics | scaled warn/fail verdicts, xrun-per-minute, silent-engine detection |

## What is not verified here

- **Audio on a device.** No emulator can tell you whether the Oboe stream is
  glitch-free. Load a set at 128 frames and watch the diagnostics screen.
- **MIDI against real hardware.** The driver is tested against its own protocol
  model and the mock transport. Plug in an MK3 and confirm the pad grid lights.
- **Long-run stability.** The checks are deterministic and short; a two-hour set
  exercises different things (memory, thermals, battery saver).

## Known limits

1. **Stem separation needs a model file.** The inference path exists; the weights
   do not ship. `docs/BUILD.md` explains how to supply them.
2. **No NDK = no sound.** The silent core is a feature (UI and MIDI stay usable),
   not a fallback that pretends to work.
3. **Mesh transport is in-process.** `MeshBus`/`LoopbackMeshTransport` are for
   development and soundcheck. A UDP or WebRTC transport implements the same small
   interface; nothing above it changes.
4. **Android build not in CI.** Gradle + NDK + Oboe needs the Android SDK image.

## Release checklist (for the next one)

1. `tools/ci/check.sh` green.
2. Version bumped in `package.json` and `app.json` (plus `versionCode`).
3. `CHANGELOG.md` has a section for the version.
4. Device smoke test: launch, load two tracks, 4-bar loop, record 30 s, play back.
5. Tag: `git tag -a vX.Y.Z -m "..."` and push with `--tags`.
