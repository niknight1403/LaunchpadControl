import type { MidiDeviceInfo, MidiTransport } from './types';

export class MockMidiTransport implements MidiTransport {
  readonly sent: Uint8Array[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;

  async start(onMessage: (bytes: Uint8Array) => void): Promise<void> {
    this.handler = onMessage;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  send(bytes: Uint8Array): void {
    this.sent.push(Uint8Array.from(bytes));
  }

  async listDevices(): Promise<MidiDeviceInfo[]> {
    return [{ id: 'mock', name: 'Mock Launchpad Mini MK3' }];
  }

  /** Inject an inbound hardware message in tests. */
  inject(bytes: number[]): void {
    this.handler?.(Uint8Array.from(bytes));
  }

  /** Total SysEx payload the driver pushed out, for latency/bandwidth tests. */
  sentByteCount(): number {
    return this.sent.reduce((sum, packet) => sum + packet.length, 0);
  }
}
