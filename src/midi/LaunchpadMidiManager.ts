import {
  DEFAULT_PROFILE,
  PROFILES,
  SYSEX_TYPE_FLASH,
  SYSEX_TYPE_PULSE,
  SYSEX_TYPE_STATIC,
  scaleRgb,
  sysexPrefix,
  toWireChannel,
  velocityBrightness,
  type LaunchpadModel,
  type LaunchpadProfile,
} from './LaunchpadProfiles';
import type { CellRef, ControlArea, ControlHit, MidiTransport, PadHit, PadLed, SurfaceHit } from './types';

export type SurfaceMode = 'session' | 'note' | 'fx';

type LedKey = string;

const MAX_TRIPLETS_PER_SYSEX = 32; // 5-byte prefix + 1 type + 32*4 = 134 bytes, safe to chunk
const FRAME_MS = 16;

/**
 * Bidirectional Launchpad engine.
 *
 * Outbound: a diff ledger holds the intended LED state; a 60 Hz tick sends only
 * the pads that changed, in chunked SysEx. A full 64-pad repaint every frame
 * would be needless USB traffic and visible tearing.
 *
 * Inbound: raw MIDI bytes are decoded into surface hits. Nothing else lives here:
 * no audio, no React.
 */
export class LaunchpadMidiManager {
  private profile: LaunchpadProfile;
  private transport: MidiTransport;

  private ledger = new Map<LedKey, string>();
  private scratch: { index: number; color: string }[] = [];
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private opened = false;

  private mode: SurfaceMode = 'session';
  private heldPads = new Set<number>();
  private lastHitAt = 0;

  private padListeners = new Set<(hit: PadHit) => void>();
  private controlListeners = new Set<(hit: ControlHit) => void>();
  private surfaceListeners = new Set<(hit: SurfaceHit) => void>();
  private errorListeners = new Set<(error: Error) => void>();

  constructor(transport: MidiTransport, profileId: LaunchpadModel = DEFAULT_PROFILE) {
    this.transport = transport;
    this.profile = PROFILES[profileId];
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.opened) return;
    try {
      await this.transport.start((bytes) => this.handleMessage(bytes));
    } catch (error) {
      this.emitError(error);
      return;
    }
    this.opened = true;
    this.sendControl(this.profile.programmerMode);
    this.clearAll();
    this.frameTimer = setInterval(() => this.flush(), FRAME_MS);
  }

  async close(): Promise<void> {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    if (!this.opened) return;
    this.clearAll();
    this.flush();
    await this.transport.stop();
    this.opened = false;
    this.ledger.clear();
    this.heldPads.clear();
  }

  get activeProfile(): LaunchpadProfile {
    return this.profile;
  }

  get currentMode(): SurfaceMode {
    return this.mode;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Milliseconds since the last physical hit; the co-pilot uses it to guess attention. */
  get msSinceLastHit(): number {
    return this.lastHitAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastHitAt;
  }

  setProfile(profileId: LaunchpadModel): void {
    this.profile = PROFILES[profileId];
    this.ledger.clear();
    this.sendControl(this.profile.programmerMode);
    this.flush();
  }

  setMode(mode: SurfaceMode): void {
    this.mode = mode;
  }

  // ── outbound: LED painting ───────────────────────────────────────────────

  /**
   * Set one grid pad. x = column 0..7 left to right, y = row 0..7 top to bottom
   * (screen orientation). The hardware row is flipped here, once.
   */
  setPad(x: number, y: number, led: PadLed): void {
    const row = this.profile.gridRows - 1 - clampIndex(y, this.profile.gridRows);
    const col = clampIndex(x, this.profile.gridCols);
    const note = this.profile.noteForCell(row, col);
    this.writeLed(`pad:${note}`, note, led);
  }

  /** Paint a complete 8x8 frame: frame[y][x], y = 0 is the top visual row. */
  paintFrame(frame: readonly (readonly (PadLed | null)[])[]): void {
    for (let y = 0; y < this.profile.gridRows; y += 1) {
      const row = frame[y];
      if (!row) continue;
      for (let x = 0; x < this.profile.gridCols; x += 1) {
        const led = row[x];
        if (led) this.setPad(x, y, led);
      }
    }
  }

  /** Side buttons: `top` = scene row, `right` = mode column (top to bottom). */
  setControl(area: ControlArea, index: number, led: PadLed): void {
    const cc = area === 'top' ? this.profile.topRowCC[index] : this.profile.rightColumnCC[index];
    if (cc === undefined) return;
    this.writeLed(`ctrl:${area}:${index}`, cc, led);
  }

  /** Convenience: same colour on both side strips, e.g. on mode change. */
  paintControlStrip(area: ControlArea, leds: readonly (PadLed | null)[]): void {
    const count = area === 'top' ? this.profile.topRowCC.length : this.profile.rightColumnCC.length;
    for (let i = 0; i < count; i += 1) {
      const led = leds[i];
      if (led) this.setControl(area, i, led);
    }
  }

  /** Velocity-blended brightness, used when a pad is physically pressed. */
  highlightPress(x: number, y: number, led: PadLed, velocity: number): void {
    this.setPad(x, y, scaleRgb(led, velocityBrightness(velocity)) as PadLed);
  }

  clearAll(): void {
    this.ledger.clear();
    for (let row = 0; row < this.profile.gridRows; row += 1) {
      for (let col = 0; col < this.profile.gridCols; col += 1) {
        const note = this.profile.noteForCell(row, col);
        this.writeLed(`pad:${note}`, note, { r: 0, g: 0, b: 0 });
      }
    }
    for (let i = 0; i < this.profile.topRowCC.length; i += 1) {
      this.setControl('top', i, { r: 0, g: 0, b: 0 });
      this.setControl('right', i, { r: 0, g: 0, b: 0 });
    }
    this.flush();
  }

  /**
   * Send one horizontal level bar as an 8-step meter, bottom row up.
   * Cheap and it looks like a real VU on hardware.
   */
  paintMeter(column: number, level: number, color: PadLed): void {
    const steps = Math.round(Math.max(0, Math.min(1, level)) * this.profile.gridRows);
    for (let i = 0; i < this.profile.gridRows; i += 1) {
      const lit = i < steps;
      this.setPad(column, this.profile.gridRows - 1 - i, lit ? color : { r: 0, g: 0, b: 0 });
    }
  }

  private writeLed(key: LedKey, ledIndex: number, led: PadLed): void {
    const encoded = this.encodeLed(led);
    if (this.ledger.get(key) === encoded) return;
    this.ledger.set(key, encoded);
    this.scratch.push({ index: ledIndex, color: encoded });
  }

  private encodeLed(led: PadLed): string {
    const brightness = led.mode === 'pulse' ? 1 : 1;
    const channel = scaleRgb(led, brightness);
    const wire = `${toWireChannel(channel.r)},${toWireChannel(channel.g)},${toWireChannel(channel.b)}`;
    const type =
      led.mode === 'flash' ? SYSEX_TYPE_FLASH : led.mode === 'pulse' ? SYSEX_TYPE_PULSE : SYSEX_TYPE_STATIC;
    return `${type}:${wire}`;
  }

  /** Diff flush: one tick = only the changed LEDs, chunked to stay small. */
  flush(): void {
    if (this.scratch.length === 0) return;
    const pending = this.scratch;
    this.scratch = [];
    for (let offset = 0; offset < pending.length; offset += MAX_TRIPLETS_PER_SYSEX) {
      const chunk = pending.slice(offset, offset + MAX_TRIPLETS_PER_SYSEX);
      const type = Number(chunk[0]?.color.split(':')[0] ?? SYSEX_TYPE_STATIC);
      const message = [...sysexPrefix(this.profile), 0x03, type];
      for (const entry of chunk) {
        const value = entry.color.split(':')[1] ?? '0,0,0';
        const [r, g, b] = value.split(',').map((part) => Number(part) || 0);
        message.push(entry.index, r ?? 0, g ?? 0, b ?? 0);
      }
      message.push(0xf7);
      this.sendControl(message);
    }
  }

  private sendControl(bytes: readonly number[]): void {
    void this.transport.send(Uint8Array.from(bytes));
  }

  // ── inbound: decoding ────────────────────────────────────────────────────

  private handleMessage(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const status = bytes[0] ?? 0;

    // SysEx from the device is ignored on purpose: the layout is ours.
    if (status === 0xf0) return;

    const command = status & 0xf0;
    const data1 = bytes[1];
    const data2 = bytes[2];
    if (data1 === undefined || data2 === undefined) return;

    if (command === 0x90 || command === 0x80) {
      this.handlePadNote(data1, data2, command === 0x90 && data2 > 0);
      return;
    }
    if (command === 0xb0) {
      this.handleControlCC(data1, data2);
    }
  }

  private handlePadNote(note: number, velocity: number, pressed: boolean): void {
    const cell = this.profile.cellForNote(note);
    if (!cell) return;
    this.lastHitAt = Date.now();

    if (pressed) this.heldPads.add(note);
    else this.heldPads.delete(note);

    const hit: PadHit = {
      kind: 'pad',
      row: cell.row,
      col: cell.col,
      note,
      velocity: pressed ? Math.max(0.05, velocity / 127) : 0,
      pressed,
    };
    for (const listener of this.padListeners) listener(hit);
    for (const listener of this.surfaceListeners) listener(hit);
  }

  private handleControlCC(cc: number, value: number): void {
    const pressed = value > 0;
    const topIndex = this.profile.topRowCC.indexOf(cc);
    if (topIndex >= 0) {
      this.lastHitAt = Date.now();
      const hit: ControlHit = { kind: 'control', area: 'top', index: topIndex, cc, pressed };
      for (const listener of this.controlListeners) listener(hit);
      for (const listener of this.surfaceListeners) listener(hit);
      return;
    }
    const rightIndex = this.profile.rightColumnCC.indexOf(cc);
    if (rightIndex >= 0) {
      this.lastHitAt = Date.now();
      const hit: ControlHit = { kind: 'control', area: 'right', index: rightIndex, cc, pressed };
      for (const listener of this.controlListeners) listener(hit);
      for (const listener of this.surfaceListeners) listener(hit);
    }
  }

  // ── subscriptions ────────────────────────────────────────────────────────

  onPad(listener: (hit: PadHit) => void): () => void {
    this.padListeners.add(listener);
    return () => this.padListeners.delete(listener);
  }

  onControl(listener: (hit: ControlHit) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onSurface(listener: (hit: SurfaceHit) => void): () => void {
    this.surfaceListeners.add(listener);
    return () => this.surfaceListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitError(error: unknown): void {
    const normalised = error instanceof Error ? error : new Error(String(error));
    if (this.errorListeners.size === 0) return;
    for (const listener of this.errorListeners) listener(normalised);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Screen cell for a hardware note; used by the UI to mirror the layout. */
  screenCellForNote(note: number): CellRef | null {
    const cell = this.profile.cellForNote(note);
    if (!cell) return null;
    return { row: this.profile.gridRows - 1 - cell.row, col: cell.col };
  }

  isHeld(note: number): boolean {
    return this.heldPads.has(note);
  }
}

function clampIndex(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(size - 1, Math.trunc(value)));
}
