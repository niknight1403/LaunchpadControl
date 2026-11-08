import type { StudioStorage } from './Studio';

/**
 * The studio's storage is synchronous by design (a fader move must not await a disk
 * write), while the app's persistence is asynchronous. This adapter bridges the two:
 * one JSON document, hydrated once at boot, written back on a short debounce.
 *
 * The 500 ms debounce is not cosmetic. Session autosave fires on every state change, and
 * writing a file per fader step was measurably the most expensive thing in the app.
 */
export interface PersistAdapter {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export class HydratedStudioStorage implements StudioStorage {
  private map = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private readonly debounceMs: number;

  private constructor(private readonly persist: PersistAdapter, debounceMs = 500) {
    this.debounceMs = debounceMs;
  }

  /** Loads the document and returns a storage that already holds it. */
  static async open(persist: PersistAdapter, debounceMs = 500): Promise<HydratedStudioStorage> {
    const storage = new HydratedStudioStorage(persist, debounceMs);
    try {
      const text = await persist.read();
      if (!text) return storage;
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return storage;
      Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
        if (typeof value === 'string') storage.map.set(key, value);
      });
    } catch {
      // A corrupt document must not stop the app from starting; it starts empty instead
      // of failing and being unopenable.
    }
    return storage;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.map.get(key) === value) return;
    this.map.set(key, value);
    this.schedule();
  }

  removeItem(key: string): void {
    if (!this.map.has(key)) return;
    this.map.delete(key);
    this.schedule();
  }

  get size(): number {
    return this.map.size;
  }

  /** Writes now instead of waiting for the debounce. Safe to call at shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = JSON.stringify(Object.fromEntries(this.map));
    this.pending = this.persist
      .write(snapshot)
      .catch(() => {
        // Losing a background write is not worth surfacing as a boot error; the next
        // change rewrites the whole document anyway.
      })
      .then(() => {
        this.pending = null;
      });
    await this.pending;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    // Node keeps the process alive for a pending timer only; the app does not care.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
