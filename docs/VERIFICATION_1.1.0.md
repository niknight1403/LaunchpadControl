# Verification: sprints 11 to 20 in v1.1.0

Every sprint below was executed on its own, not just as part of the aggregate suite, so
a regression in one sprint cannot hide behind another sprint's green.

```
cd LaunchpadControl
tools/ci/check.sh          # aggregate: 741 logic checks, 32 core checks
```

Date of this run: 2026-11-08. `main` = `5e922d4`, tag `v1.1.0` = `351cdcb`.

| # | Sprint | Commit | Module | Checks (isolated) |
|---|---|---|---|---|
| 11 | Session-Restore | `dc4fc58` | `src/state/SessionStore.ts` | 38 |
| 12 | MIDI-Learn | `84a9d0f` | `src/midi/MidiMap.ts` | 40 |
| 13 | Beat-Grid & Tap-Tempo | `5721aea` | `src/analysis/BeatGrid.ts` | 33 |
| 14 | Drei-Band-Stem-Split | `815205f` | `src/analysis/StemSplit.ts` | 26 |
| 15 | Waveform-Daten | `5e6c686` | `src/analysis/WaveformData.ts` | 29 |
| 16 | Take-Export | `c9ac2a0` | `src/recording/PostProcess.ts` | 39 |
| 17 | UDP-Transport | `e773e44` | `src/agent/UdpTransport.ts` | 37 |
| 18 | Latenz-Governor | `e0c8818` | `src/engine/LatencyGovernor.ts` | 35 |
| 19 | Backup-Bundle | `2544f29` | `src/state/BackupBundle.ts` | 36 |
| 20 | Lokalisierung & Kontrast | `ebaf80e` | `src/i18n/strings.ts`, `src/theme/contrast.ts` | 32 + 30 |

**Sprints 11-20: 375 Checks, 0 Fehler.** Die restlichen 366 der 741 Gesamtchecks
gehören zu den Sprints 1-10 und den Phasen-Ergänzungen.

## Tag-Inhalt

Alle zehn Sprint-Commits sind Vorfahren von `v1.1.0` (geprüft per
`git merge-base --is-ancestor`), und jede Sprint-Datei ist im Tag enthalten:

```
dc4fc58 84a9d0f 5721aea 815205f 5e6c686 c9ac2a0 e773e44 e0c8818 2544f29 ebaf80e
```

Nach dem Tag auf `main`, bewusst nicht im Tag:

- `f5323d3` Phase 3: MeshSyncEngine
- `5e922d4` Phase 1: FLAC-Erkennung

Der Tag wurde nicht verschoben, weil er bereits veröffentlicht ist: ein bewegter Tag
bricht jeden Build, der ihn schon gezogen hat. Wenn er die beiden Commits enthalten
soll, gehört das in ein 1.1.1 oder 1.2.0, nicht in ein umgeschriebenes v1.1.0.

## Wie einzeln geprüft wird

Ein Sprint lässt sich ohne den Aggregator ausführen, indem nur sein Testmodul
gebündelt wird:

```bash
cat > /tmp/one.ts <<'TS'
import { run } from '/pfad/zu/scripts/tests/beat-grid.test';
import { totals } from '/pfad/zu/scripts/tests/harness';
run().then(() => console.log(totals()));
TS
npx esbuild /tmp/one.ts --bundle --platform=node --format=cjs --outfile=/tmp/one.cjs
node /tmp/one.cjs
```
