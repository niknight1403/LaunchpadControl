# Launchpad MIDI protocol (as implemented)

Source of truth for the wire format used by `src/midi/LaunchpadMidiManager.ts`.
Constants live in `src/midi/LaunchpadProfiles.ts`; change them there, not in the driver.

## Device identification

| Model | SysEx model byte | Notes |
|---|---|---|
| Launchpad Mini MK3 | `0x0D` | RGB LEDs, 8x8 grid |
| Launchpad X | `0x0C` | RGB, velocity sensitive |
| Launchpad Pro MK3 | `0x0F` | RGB, aftertouch |

Header: `F0 00 20 29 <model>` (Novation manufacturer ID = `00 20 29`).

## Lighting

```
F0 00 20 29 <model> 03 <type> <led> <r> <g> <b> [<led> <r> <g> <b> ...] F7
```

- `type`: `0` static, `1` flashing, `2` pulsing
- `<r> <g> <b>` are **0..127**, not 0..255 (`toWireChannel()` converts)
- `<led>` is the note number for grid pads, the CC number for side buttons
- Multiple triplets per message are allowed; the driver chunks at 32 triplets
  (134 bytes) to stay well inside a single USB-MIDI transfer

## Note / LED index math

Programmer mode, row 0 = bottom:

```
note = (row + 1) * 10 + (col + 1)      // bottom-left = 11, top-right = 88
row  = floor(note / 10) - 1
col  = note % 10 - 1
```

The UI is top-down (`y = 0` is the top row), so the driver flips once:

```ts
const row = 7 - y;
```

## Input

| Message | Meaning |
|---|---|
| `0x90 note velocity` | pad pressed, velocity 1..127 |
| `0x80 note 0` / `0x90 note 0` | pad released |
| `0xB0 cc value` | side button; `value > 0` = pressed |

Side buttons: top row CCs `104..111`, right column CCs `89, 79, 69, 59, 49, 39, 29, 19`.

> Firmware note: if a unit maps its side column differently, correct
> `rightColumnCC` in the profile. Nothing else needs to change.

## Traffic budget

- 60 Hz flush, changed LEDs only (diff ledger), 4 bytes per LED + 6 bytes overhead
- Punching 8 pads during a transition ≈ 38 bytes per frame ≈ 2.3 kB/s
- Full 64-pad repaint is only sent by `clearAll()` (mode switch / disconnect)

## Verification on hardware

1. `LaunchpadMidiManager.open()` enters programmer mode and clears the grid.
2. Press any pad: the console shows `{kind:'pad', row, col, velocity}`.
3. `paintMeter(0, 0.6, cyan)` should light 5 pads bottom-up in column 0.
4. Unplug and replug: the Android USB attach event restarts the transport.
