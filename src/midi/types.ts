/** MIDI layer contracts. Kept free of React and of the audio engine. */

export interface RgbTriplet {
  r: number;
  g: number;
  b: number;
}

export type LedMode = 'static' | 'flash' | 'pulse';

export interface PadLed extends RgbTriplet {
  mode?: LedMode;
}

/** Grid coordinates. row 0 is the *bottom* row, matching the hardware. */
export interface CellRef {
  row: number;
  col: number;
}

export interface PadHit {
  kind: 'pad';
  row: number;
  col: number;
  note: number;
  velocity: number;
  pressed: boolean;
}

export type ControlArea = 'top' | 'right';

export interface ControlHit {
  kind: 'control';
  area: ControlArea;
  index: number;
  cc: number;
  pressed: boolean;
}

export type SurfaceHit = PadHit | ControlHit;

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

/**
 * Transport abstraction so the driver can be exercised on a desktop, in tests,
 * or over a different backend (USB host, BLE-MIDI, network MIDI) unchanged.
 */
export interface MidiTransport {
  start(onMessage: (bytes: Uint8Array) => void): Promise<void>;
  stop(): Promise<void>;
  send(bytes: Uint8Array): void | Promise<void>;
  listDevices(): Promise<MidiDeviceInfo[]>;
}
