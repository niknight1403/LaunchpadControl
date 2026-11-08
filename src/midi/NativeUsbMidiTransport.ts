import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { MockMidiTransport } from './MockMidiTransport';
import type { MidiDeviceInfo, MidiTransport } from './types';

export { MockMidiTransport };

/**
 * USB host transport for the Launchpad.
 *
 * Native side: `android/app/src/main/java/com/auragrid/launchpad/MidiUsbModule.kt`.
 * The module emits `AuraMidi:message` with `{ bytes: number[] }` and
 * `AuraMidi:device` with `{ id, name, attached }`.
 */

interface AuraMidiNative {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(bytes: number[]): Promise<void>;
  listDevices(): Promise<MidiDeviceInfo[]>;
}

const nativeModule = (NativeModules as { AuraMidi?: AuraMidiNative }).AuraMidi;

/** Structural shape of the RN event emitter, so this file stays testable. */
interface EmitterLike {
  addListener(event: string, listener: (payload: { bytes?: number[] }) => void): { remove(): void };
}

class UsbMidiTransport implements MidiTransport {
  private emitter: EmitterLike | null = null;
  private subscriptions: { remove(): void }[] = [];

  async start(onMessage: (bytes: Uint8Array) => void): Promise<void> {
    if (!nativeModule) throw new Error('AuraMidi native module not linked. Run expo prebuild + rebuild.');
    this.emitter = new NativeEventEmitter(NativeModules.AuraMidi) as unknown as EmitterLike;
    this.subscriptions.push(
      this.emitter.addListener('AuraMidi:message', (payload) => {
        if (Array.isArray(payload?.bytes)) onMessage(Uint8Array.from(payload.bytes));
      }),
    );
    await nativeModule.start();
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    this.emitter = null;
    await nativeModule?.stop();
  }

  send(bytes: Uint8Array): void {
    // Fire and forget: awaiting each packet would add a microtask per LED chunk.
    void nativeModule?.send(Array.from(bytes)).catch(() => undefined);
  }

  async listDevices(): Promise<MidiDeviceInfo[]> {
    if (!nativeModule) return [];
    return nativeModule.listDevices();
  }
}

/**
 * Desktop / simulator transport. Parses nothing, sends nothing, but lets the
 * whole driver (ledger, diffing, chunking, decode) be exercised and unit tested.
 */
export function createMidiTransport(): MidiTransport {
  if (Platform.OS === 'android' && nativeModule) return new UsbMidiTransport();
  return new MockMidiTransport();
}
