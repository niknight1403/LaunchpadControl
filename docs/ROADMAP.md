# Roadmap — Sprint 1 to 10

Autonomous development plan for AuraGrid. Each sprint ships code **and** the
tests that prove it, and ends in its own commit. A sprint is only "done" when
`tools/ci/check.sh` is green.

| # | Sprint | Kern | Nachweis |
|---|---|---|---|
| 1 | Persistenz & Presets | versioniertes Schema, Migration v1→v2, Store mit Autosave, Export/Import, Capture aus Live-Engine | Schema-Validierung, Roundtrip, Autosave-Debounce, Reload |
| 2 | Bibliothek & BPM-Erkennung | Track-Bibliothek mit Suche/Filter, Onset-Autokorrelation zur BPM-Schätzung | 128-BPM-Klick-Track wird auf ±1 erkannt |
| 3 | Offline-Analyse | FFT, Chroma-Extraktion, Peaks/RMS, ein Analyse-Pass pro Track | A-Moll-Synthese wird als 8A erkannt, Peaks plausibel |
| 4 | Deck-Controller | Cue, Loops im Core, Beat-Sync, Nudge, Playhead-Mathe | Loop-Wrap im Core, Beat-Mathe gegen Handrechnung |
| 5 | FX-Chain & Automation | FX-Kette pro Deck, LFO-Automation auf der Timeline, Macro-Binding | LFO-Rampe trifft Zielwerte, keine Engine-Calls nach Stop |
| 6 | Recording | WAV-Writer, Recording-Tap im Core, Session-Recorder mit Markern | WAV-Header korrekt, Roundtrip über eigenen Decoder |
| 7 | Mesh-Swarm | Preset-Verteilung, Intent-Nachrichten, Konfliktregel über Master, Latenz-Kompensation | Zwei Knoten, ein Master, Preset konvergiert |
| 8 | Set-Builder | Energie-Bogen, harmonische Kette, Plan-Ausführung auf Bar-Grenzen | Plan erfüllt Bogen und Harmonie-Schwelle |
| 9 | Diagnose & CI | Perf-Monitor mit Budget-Watchdog, GitHub-Actions-CI, Abbruch bei Budget-Verletzung | Watchdog meldet Verletzung, CI-Job läuft |
| 10 | Release | Version 1.0.0, CHANGELOG, Release-Doku, Tag | vollständiger Check-Lauf, Tag gesetzt |

## Regeln

- Kein Sprint ohne Test. Ein Feature, das nur „geht", ist nicht fertig.
- Keine native Abhängigkeit ohne Fallback: ohne NDK-Build bleibt alles außer Ton bedienbar.
- Modell-Dateien (Stems) und Binaries bleiben draußen. Das ist eine Lizenz- und
  Verteilungsentscheidung, keine Code-Lücke.
