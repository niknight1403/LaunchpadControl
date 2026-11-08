# Roadmap — Sprint 1 to 10

Autonomous development plan for AuraGrid. Each sprint ships code **and** the
tests that prove it, and ends in its own commit. A sprint is only "done" when
`tools/ci/check.sh` is green.

| # | Sprint | Kern | Nachweis | Status |
|---|---|---|---|---|
| 1 | Persistenz & Presets | versioniertes Schema, Migration v1→v2, Store mit Autosave, Export/Import, Capture aus Live-Engine | Schema-Validierung, Roundtrip, Autosave-Debounce, Reload | **fertig** |
| 2 | Bibliothek & BPM-Erkennung | Track-Bibliothek mit Suche/Filter, Onset-Autokorrelation zur BPM-Schätzung | 120/128/85 BPM auf ±2 erkannt, Stille ergibt nichts | **fertig** |
| 3 | Offline-Analyse | FFT, Chroma-Extraktion, Peaks/RMS, ein Analyse-Pass pro Track | A-Moll-Dreiklang → 8A, Parseval-Energie, Peaks plausibel | **fertig** |
| 4 | Deck-Controller | Cue, Loops im Core, Beat-Sync, Nudge, Playhead-Mathe | Loop-Wrap im Core, Beat-Mathe gegen Handrechnung | **fertig** |
| 5 | FX-Chain & Automation | FX-Kette pro Deck, LFO-Automation auf der Timeline, Macro-Binding | Werte aus geplanter Zeit, keine Writes nach Stop | **fertig** |
| 6 | Recording | WAV-Writer, Recording-Tap im Core, Session-Recorder mit Markern | WAV-Header korrekt, Roundtrip über eigenen Decoder | **fertig** |
| 7 | Mesh-Swarm | Preset-Verteilung, Intent-Nachrichten, Konfliktregel über Master, Master-Verlust | Zwei Knoten, ein Master, Takeover nach Verlust | **fertig** |
| 8 | Set-Builder | Energie-Bogen, harmonische Kette, Plan-Ausführung auf Bar-Grenzen | Bogen erfüllt, Übergangs-Wahl, Runner-Reihenfolge | **fertig** |
| 9 | Diagnose & CI | Perf-Monitor mit Budget-Watchdog, GitHub-Actions-CI | Verdict skaliert mit Abstand zum Budget, CI-Job definiert | **fertig** |
| 10 | Release | Version 1.0.0, CHANGELOG, Release-Doku, Tag | `tools/ci/check.sh` grün, Tag `v1.0.0` | **fertig** |

Stand: alle zehn Sprints abgeschlossen, siehe `CHANGELOG.md` und `docs/RELEASE.md`.
Gemeinsamer Nachweis: 314 Logik-Checks, 18 Core-Checks, strikter Type-Check.

## Regeln

- Kein Sprint ohne Test. Ein Feature, das nur „geht", ist nicht fertig.
- Keine native Abhängigkeit ohne Fallback: ohne NDK-Build bleibt alles außer Ton bedienbar.
- Modell-Dateien (Stems) und Binaries bleiben draußen. Das ist eine Lizenz- und
  Verteilungsentscheidung, keine Code-Lücke.
