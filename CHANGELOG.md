# Changelog

All notable changes to LaunchpadControl (AuraGrid). Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [1.1.0] — 2026-11-08

Everything around the gig: recovering a session, mapping a borrowed controller,
splitting bands, exporting the take, running a swarm over Wi-Fi and keeping the
phone honest about its own performance. Full table in `docs/ROADMAP_1.1.md`.

### Added
- **Session restore** (`src/state/SessionStore.ts`): versioned snapshot of decks,
  positions, loops and UI state, debounced writes, a clean-shutdown marker so a
  crash is reported as a crash, and a migration path that clamps hostile values.
- **MIDI learn** (`src/midi/MidiMap.ts`): bind any CC or note to a deck, FX or
  transport target, with curves and ranges, conflict reporting and JSON export.
- **Beat grid and tap tempo** (`src/analysis/BeatGrid.ts`): tempo plus first-beat
  offset as one object, note-division snapping, bar lines, circular-mean offset
  refinement and a drift meter; a tap-tempo with median intervals that survives a
  bouncy pad.
- **Three-band stem split** (`src/analysis/StemSplit.ts`): zero-phase FFT
  overlap-add into bass/mid/highs that reconstructs the input exactly at unity.
- **Waveform data** (`src/analysis/WaveformData.ts`): per-bucket band energy plus
  beat and bar markers.
- **Take export** (`src/recording/PostProcess.ts`): normalisation with a ceiling,
  fades, relative silence trim, and a bundle of WAV, cue sheet and manifest.
- **UDP mesh transport** (`src/agent/UdpTransport.ts`): framed datagrams with magic,
  version, sequence dedupe, size limit and peer learning, behind a socket interface
  so it is testable without a port.
- **Latency governor** (`src/engine/LatencyGovernor.ts`): adaptive buffer size with
  hysteresis, cooldown, a ceiling and immediate reaction to dropouts.
- **Backup bundle** (`src/state/BackupBundle.ts`): checksummed single-file backup
  with an id-based merge that carries deletions.
- **Localisation and contrast audit** (`src/i18n/strings.ts`,
  `src/theme/contrast.ts`): German and English catalogues with a fallback chain, and
  WCAG checks over the palette the UI actually renders.

### Changed
- The logic suite grew from 314 to 689 checks.
- `docs/ROADMAP_1.1.md` documents this pass, including what was deliberately left out.

### Still true from 1.0.0
- Audio needs the NDK build; the stem model is not bundled; the Android app build is
  not part of CI.

## [1.0.0] — 2026-11-08

First complete build: architecture, realtime core, control surface, agent and the
tooling to verify all of it without a phone in hand.

### Added — engine and core
- C++20 Oboe engine (JSI, no bridge on the audio path) with 4 decks × 2 voices,
  lock-free SPSC rings, SVF filter, granular stutter, tape delay with drift and a
  soft-knee limiter with a hard ceiling.
- Loop boundaries and per-deck playback rate as core commands, sample-accurate
  loop wrap in the render loop, and a seek command.
- Lock-free recording tap: the audio callback pushes to a ring, a writer thread
  drains it into 16-bit stereo WAV and patches the RIFF sizes on stop.
- Silent fallback core so the UI, MIDI and agent remain usable when the native
  library is not built.

### Added — control surface
- Bidirectional Launchpad MK3 driver: SysEx RGB protocol, diff ledger, 60 Hz
  chunked flush, pad/CC decode, per-model profile table.
- USB host MIDI bridge and a foreground audio service with audio focus and wake
  lock.

### Added — musical logic
- Camelot wheel and Krumhansl key estimation, tempo matching with half/double
  time, lookahead timeline for sample-accurate scheduling.
- Tempo detection from an onset-flux autocorrelation, with an honest confidence
  figure.
- Offline analyser: own FFT, chroma extraction, key, energy and waveform peaks
  from one pass over a decoded buffer.
- Deck controller: cue, loops (halve/double, clamped), beatmatch, jog nudge.
- Per-deck FX chain with LFO automation scheduled on the timeline and evaluated at
  the scheduled beat.
- Auto-pilot transitions, a set builder with an energy arc and transition choice,
  and a mesh swarm with master-owned preset state and master-loss takeover.

### Added — state and workflow
- Versioned preset schema (v2) with v1 migration, preset store with debounced
  autosave, export/import, and capture from / apply to the live engine.
- Track library: path deduplication, partial upsert, query/filter, ranked
  similarity.
- Session recorder with takes, markers carrying transport position, and cue-sheet
  export.
- Performance monitor with cpu/latency/xrun/buffer budgets and a printable
  support report.

### Added — verification
- 314 logic checks (`npm run test:logic`) and 18 host-compiled C++ checks, plus a
  strict type check, all behind one command: `tools/ci/check.sh`.
- GitHub Actions workflow running the same checks on every push.

### Notes and limits
- The stem separation model is not bundled: it is hundreds of megabytes and a
  licensing question, not a code gap. See `docs/BUILD.md`.
- Without the NDK build the app runs on the silent core: everything except sound
  works, and recording produces a correct-length file with no audio.
- The Android app build (Gradle + NDK + Oboe) is not part of CI; it needs the
  Android SDK and a licensed NDK image.
