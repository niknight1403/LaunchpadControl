# Release notes

What a release contains, what it was checked against, and what it still cannot do.
Applies to 1.1.0; the 1.0.0 sections that are still true are marked as such.

## Verify it yourself

```bash
npm install          # only needed for the full type check
tools/ci/check.sh    # type check + 689 logic checks + 18 core checks
```

The script needs `typescript`, `esbuild` and `g++`. No Android SDK, no device.

## 1.1.0 — what was verified, and how

| Area | Evidence |
|---|---|
| Session restore | burst of changes writes once; clean and crashed restores differ; clamps rates, gains and negative positions |
| MIDI learn | learn captures the next message; curves and ranges; re-learning a used message replaces instead of duplicating; hostile import files are skipped with warnings |
| Beat grid | 500 ms taps read 120 BPM; jitter lowers confidence; a bounced double tap no longer halves the next interval; offset fitted to 0.13 s from onsets and drift falls below 8 ms |
| Band split | three stems reconstruct the input to 1e-6; muting the band containing a tone removes that tone; stereo channels independent |
| Waveform | 60 Hz reads as bass, 1 kHz as mid, 9 kHz as highs; markers land on beats and bar lines with no duplicate buckets |
| Export | exported WAV decodes, manifest duration matches the frames shipped, cue sheet lists markers |
| UDP transport | framing roundtrip, six kinds of junk refused, duplicate sequences dropped, oversized packets refused before sending |
| Latency governor | three consecutive hot samples act, alternation never does, a dropout climbs two steps at once, never beyond the ladder |
| Backup | checksum catches a tampered count, verification never throws, double restore is idempotent |
| Localisation | both catalogues have identical keys and identical placeholders; locale-aware number formatting |
| Accessibility | nine text/background pairs the UI renders all pass WCAG AA |

## What is not verified here

- **Audio on a device.** No emulator proves an Oboe stream is glitch-free. Load a set
  at 128 frames and watch the diagnostics screen.
- **MIDI against real hardware.** The driver and the map are tested against their own
  protocol models. Plug in an MK3 and confirm the grid lights.
- **Two phones over real Wi-Fi.** The UDP transport is tested against a fake socket.
  The radio, the router and the club's interference are not modelled.
- **Long-run stability.** The checks are deterministic and short; a two-hour set
  exercises memory, thermals and battery saver.

## Known limits

1. **Stem separation needs a model file.** 1.1.0 splits bands, not instruments. The
   inference path is documented in `docs/BUILD.md`.
2. **No NDK = no sound.** The silent core is a feature, not a pretence.
3. **The Android build is not in CI.** Gradle + NDK + Oboe needs the Android SDK image.
4. **Localisation covers the string catalogue, not every existing component.** New UI
   uses `t()`; older screens still hard-code German and are migrated as they are touched.

## Release checklist (next time)

1. `tools/ci/check.sh` green.
2. Version in `package.json` and `app.json` (plus `versionCode`).
3. `CHANGELOG.md` has a section for the version.
4. Device smoke test: launch, load two tracks, 4-bar loop, record 30 s, export, restore
   the session after a force-stop.
5. Tag: `git tag -a vX.Y.Z -m "..."` and push with `--tags`.
