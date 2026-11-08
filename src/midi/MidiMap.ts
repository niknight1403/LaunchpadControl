/**
 * MIDI learn: bind a controller to an action without editing code.
 *
 * The Launchpad has a fixed layout, but the second controller on the rider rarely
 * does. Learn mode records "this CC drives that parameter", with a curve and a
 * range, and the binding survives a restart in the session snapshot.
 */

export interface MidiMessage {
  type: 'cc' | 'note';
  /** 0..15 */
  channel: number;
  /** CC number, or note number. */
  number: number;
  /** Normalised 0..1 (velocity for notes). */
  value: number;
}

export type MappingTarget =
  | { kind: 'fx'; deck: number; param: string }
  | { kind: 'deck'; deck: number; action: 'play' | 'cue' | 'loop' | 'sync' }
  | { kind: 'transport'; action: 'play' | 'stop' | 'record' };

export type MappingCurve = 'linear' | 'quadratic' | 'sqrt';

export interface Mapping {
  id: string;
  message: { type: 'cc' | 'note'; channel: number; number: number };
  target: MappingTarget;
  curve: MappingCurve;
  /** Output range applied after the curve. */
  min: number;
  max: number;
}

export type HandleResult =
  | { kind: 'learned'; mapping: Mapping; replaced: Mapping | null }
  | { kind: 'value'; mapping: Mapping; value: number }
  | { kind: 'ignored'; reason: string };

export interface MidiMapOptions {
  now?: () => number;
  /** Optional filter: ignore messages on other channels. */
  channel?: number | null;
}

const CURVES: Record<MappingCurve, (value: number) => number> = {
  linear: (value) => value,
  quadratic: (value) => value * value,
  sqrt: (value) => Math.sqrt(value),
};

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

function messageOf(message: MidiMessage): string {
  return `${message.type}:${message.channel}:${message.number}`;
}

export function targetKey(target: MappingTarget): string {
  if (target.kind === 'fx') return `fx:${target.deck}:${target.param}`;
  if (target.kind === 'deck') return `deck:${target.deck}:${target.action}`;
  return `transport:${target.action}`;
}

export class MidiMap {
  private mappings = new Map<string, Mapping>();
  private learning: MappingTarget | null = null;
  private now: () => number;
  private channel: number | null;
  private counter = 0;

  constructor(options: MidiMapOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.channel = options.channel ?? null;
  }

  get isLearning(): boolean {
    return this.learning !== null;
  }

  get learningTarget(): MappingTarget | null {
    return this.learning;
  }

  beginLearn(target: MappingTarget): void {
    this.learning = target;
  }

  cancelLearn(): void {
    this.learning = null;
  }

  bindings(): Mapping[] {
    return [...this.mappings.values()];
  }

  /** Inbound message: captures during learn, otherwise resolves a binding. */
  handle(message: MidiMessage): HandleResult {
    if (this.channel !== null && message.channel !== this.channel) {
      return { kind: 'ignored', reason: `channel ${message.channel} is filtered out` };
    }

    if (this.learning) {
      const target = this.learning;
      this.learning = null;
      const id = `map-${this.now().toString(36)}-${(this.counter += 1)}`;
      // A controller that "learns" its own default is almost always a mistake:
      // an unmapped CC that is already bound must replace the old binding.
      const existingKey = messageOf(message);
      const replaced = this.findByMessage(existingKey) ?? null;
      if (replaced) this.mappings.delete(replaced.id);
      const mapping: Mapping = {
        id,
        message: { type: message.type, channel: message.channel, number: message.number },
        target,
        curve: 'linear',
        min: 0,
        max: 1,
      };
      this.mappings.set(id, mapping);
      return { kind: 'learned', mapping, replaced };
    }

    const mapping = this.findByMessage(messageOf(message));
    if (!mapping) return { kind: 'ignored', reason: 'no binding for this message' };
    return { kind: 'value', mapping, value: this.resolve(mapping, message.value) };
  }

  /** Resolves a raw 0..1 value through the binding's curve and range. */
  resolve(mapping: Mapping, raw: number): number {
    const curved = CURVES[mapping.curve](clamp01(raw));
    const value = mapping.min + curved * (mapping.max - mapping.min);
    return Math.round(value * 1000) / 1000;
  }

  /** Applies a fresh binding definition to an existing mapping id. */
  reconfigure(id: string, patch: Partial<Pick<Mapping, 'curve' | 'min' | 'max'>>): Mapping | null {
    const existing = this.mappings.get(id);
    if (!existing) return null;
    const updated: Mapping = {
      ...existing,
      ...patch,
      min: patch.min ?? existing.min,
      max: patch.max ?? existing.max,
    };
    if (updated.min > updated.max) {
      return null;
    }
    this.mappings.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.mappings.delete(id);
  }

  /** Everything bound to one target, used by the UI to grey out unmapped pads. */
  forTarget(target: MappingTarget): Mapping[] {
    const key = targetKey(target);
    return this.bindings().filter((mapping) => targetKey(mapping.target) === key);
  }

  /** Two bindings on one target fight each other; report them so the UI can warn. */
  conflicts(): Mapping[] {
    const seen = new Map<string, Mapping[]>();
    for (const mapping of this.mappings.values()) {
      const key = targetKey(mapping.target);
      seen.set(key, [...(seen.get(key) ?? []), mapping]);
    }
    return [...seen.values()].filter((group) => group.length > 1).flat();
  }

  toJSON(): Mapping[] {
    return this.bindings();
  }

  static fromJSON(raw: unknown, options: MidiMapOptions = {}): { map: MidiMap; warnings: string[] } {
    const map = new MidiMap(options);
    const warnings: string[] = [];
    if (!Array.isArray(raw)) return { map, warnings: ['mapping file is not an array'] };
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        warnings.push('skipped a mapping that is not an object');
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      const message = candidate.message as Record<string, unknown> | undefined;
      const target = candidate.target as MappingTarget | undefined;
      if (!message || typeof message.number !== 'number' || !target || typeof target.kind !== 'string') {
        warnings.push('skipped an incomplete mapping');
        continue;
      }
      const id = typeof candidate.id === 'string' ? candidate.id : `map-import-${map.mappings.size + 1}`;
      map.mappings.set(id, {
        id,
        message: {
          type: message.type === 'note' ? 'note' : 'cc',
          channel: typeof message.channel === 'number' ? message.channel : 0,
          number: message.number,
        },
        target,
        curve: candidate.curve === 'quadratic' || candidate.curve === 'sqrt' ? candidate.curve : 'linear',
        min: typeof candidate.min === 'number' ? candidate.min : 0,
        max: typeof candidate.max === 'number' ? candidate.max : 1,
      });
    }
    return { map, warnings };
  }

  private findByMessage(key: string): Mapping | undefined {
    for (const mapping of this.mappings.values()) {
      if (messageOf({ ...mapping.message, value: 0 }) === key) return mapping;
    }
    return undefined;
  }
}
