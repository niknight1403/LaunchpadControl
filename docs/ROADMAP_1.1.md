# Roadmap 1.1.0 — sprints 11 to 20

The 1.0.0 release was ten sprints of building the instrument. This pass is about what
happens around a real gig: recovering a crashed session, mapping a borrowed
controller, splitting a track into bands, exporting the set, running a swarm over
Wi-Fi and keeping the phone honest about its own performance.

| # | Sprint | Kern | Nachweis |
|---|---|---|---|
| 11 | Session-Restore | versionierter Session-Snapshot, debounced Writes, Clean-Shutdown-Marker, Migration feindlicher Daten | Burst-Koaleszenz, sauberer vs. abgestürzter Restore, Clamping |
| 12 | MIDI-Learn | Learn-Modus, Kurven linear/quadratisch/sqrt, min..max, Ziel-Identität, JSON-Export/Import | Learn-Flow, Rebinding, Konflikte, kaputte Importe |
| 13 | Beat-Grid & Tap-Tempo | Tempo + Offset als ein Objekt, Snapping auf Notenteilungen, Circular-Mean-Offset-Fit, Drift-Meter | Tap-Tempo mit Jitter, Bounce-Tap, Offset-Refit |
| 14 | Drei-Band-Stem-Split | zero-phase FFT-Overlap-Add mit Masken, die sich zu eins summieren | Rekonstruktion exakt, Mute-Test pro Band |
| 15 | Waveform-Daten | Low/Mid/High-Energie pro Bucket, Beat- und Taktmarker | Bandfärbung pro Ton, Marker-Platzierung |
| 16 | Take-Export | Peak-Normalisierung mit Ceiling, Fades, relativer Stille-Trim, WAV + Cue-Sheet + Manifest | WAV dekodierbar, Manifest passt zu den Frames |
| 17 | UDP-Transport | Längenpräfix-Datagramme, Magic + Version, Sequenz-Dedupe, Peer-Learning | Framing, sechs Sorten Müll, Duplikate, Größenlimit |
| 18 | Latenz-Governor | Buffer-Leiter mit Hysterese, Cooldown, Ceiling, Sofort-Reaktion auf Xruns | alternierendes Rauschen, Wärme-Simulation über 40 Samples |
| 19 | Backup-Bundle | ein JSON mit Prüfsumme, Verifikation ohne Throw, Merge nach id mit Löschlisten-Transport | Manipulation erkannt, doppelter Restore idempotent |
| 20 | Lokalisierung & Kontrast | DE/EN-Katalog mit Fallback-Kette, WCAG-Kontrast-Audit der echten Palette | Katalog-Symmetrie, Platzhalter-Symmetrie, neun Palette-Paare |

Gemeinsamer Nachweis nach Sprint 20: **689 Logik-Checks**, 18 Core-Checks, strikter
Type-Check, CI auf GitHub.

## Was bewusst nicht drin ist

- **Echte Stem-Separation.** Sprint 14 trennt Bänder, keine Instrumente. Ein Modell in
  dieser Größe gehört nicht in ein Live-App-Bundle. `docs/BUILD.md` sagt, wie man eines
  nachrüstet, wenn man es will.
- **UDP-Transport im Audio-Callback.** Der Transport läuft im JS-Thread; die Clock im
  Core bleibt die Wahrheit. Netzwerk-Jitter darf nie einen Buffer bestimmen.
- **Kontrast-Reparatur zur Laufzeit.** `repairContrast` existiert für den Test. Wenn
  ein Token repariert werden muss, ist das Token falsch und wird in der Palette
  geändert, nicht im Betrieb umgerechnet.
