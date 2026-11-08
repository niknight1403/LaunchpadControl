import { createBundle, describeMerge, mergeBundle, verifyBundle, type BackupBundle } from '../../state/BackupBundle';
import type { StudioContext, StudioPlugin } from '../Studio';

/**
 * Sprint 19 wiring: a backup is only useful if it can come back.
 *
 * The bundle knew checksums, verification and a merge that never silently overwrites a
 * newer local edit. What was missing is where the four sections come from, and what a
 * restore is allowed to do to a library that is currently open.
 *
 * Decision: a restore merges, it never replaces the live library. The one thing a DJ
 * cannot forgive is a restore that eats the set they were building.
 */
export interface BackupWiring {
  export(): { text: string; checksum: string; bytes: number; sections: string[] };
  /** Verifies first, then merges. A failed checksum changes nothing. */
  restore(text: string): { ok: boolean; report: string; added: number; replaced: number; skipped: number; warnings: string[] };
  lastChecksum(): string | null;
}

export interface BackupPluginOptions {
  /** Supplies the four sections. Defaults to reading them out of storage. */
  collect?: (ctx: StudioContext) => {
    presets: Record<string, Record<string, unknown>>;
    tracks: Record<string, Record<string, unknown>>;
    setPlans: Record<string, Record<string, unknown>>;
    mappings: Record<string, Record<string, unknown>>;
  };
  /** Receives the merged sections so the open library can be refreshed. */
  apply?: (sections: Record<string, Record<string, Record<string, unknown>>>, ctx: StudioContext) => void;
  app?: string;
}

const SECTIONS = ['presets', 'tracks', 'setPlans', 'mappings'] as const;

export function backupPlugin(options: BackupPluginOptions = {}): StudioPlugin & { wiring: BackupWiring | null } {
  let lastChecksum: string | null = null;
  const plugin: StudioPlugin & { wiring: BackupWiring | null } = {
    name: 'backup',
    sprint: 19,
    wiring: null,
    install(ctx: StudioContext) {
      const collect = (): Parameters<typeof createBundle>[0] => {
        if (options.collect) {
          const sections = options.collect(ctx);
          return { ...sections, createdAt: ctx.now(), app: options.app ?? 'auragrid' };
        }
        const read = (name: string): Record<string, Record<string, unknown>> => {
          const text = ctx.storage.getItem(`auragrid.${name}`);
          if (!text) return {};
          try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
          } catch {
            ctx.log('backup', `${name} in storage is not readable and is left out`);
            return {};
          }
        };
        return {
          presets: read('presets'),
          tracks: read('tracks'),
          setPlans: read('setPlans'),
          mappings: read('mappings'),
          createdAt: ctx.now(),
          app: options.app ?? 'auragrid',
        };
      };

      const wiring: BackupWiring = {
        export: () => {
          const bundle = createBundle(collect());
          const text = JSON.stringify(bundle);
          lastChecksum = bundle.checksum;
          ctx.storage.setItem('auragrid.backup', text);
          const bytes = text.length;
          const sections = SECTIONS.filter((name) => Object.keys(bundle.data[name]?.items ?? {}).length > 0);
          ctx.log('backup', `exported ${sections.join(', ') || 'nothing'} (${bytes} bytes)`);
          ctx.notify();
          return { text, checksum: bundle.checksum, bytes, sections };
        },
        restore: (text) => {
          const verified = verifyBundle(text);
          if (!verified.ok || !verified.bundle) {
            // A corrupt bundle must leave the library exactly as it was.
            const reason = verified.warnings.join('; ') || 'bundle failed its checksum';
            ctx.log('backup', `restore refused: ${reason}`);
            ctx.notify();
            return { ok: false, report: `restore refused: ${reason}`, added: 0, replaced: 0, skipped: 0, warnings: verified.warnings };
          }
          const incoming = verified.bundle;
          const local = options.collect
            ? options.collect(ctx)
            : {
                presets: JSON.parse(ctx.storage.getItem('auragrid.presets') ?? '{}'),
                tracks: JSON.parse(ctx.storage.getItem('auragrid.tracks') ?? '{}'),
                setPlans: JSON.parse(ctx.storage.getItem('auragrid.setPlans') ?? '{}'),
                mappings: JSON.parse(ctx.storage.getItem('auragrid.mappings') ?? '{}'),
              };
          // `newest` keeps a newer local edit instead of overwriting it with an old file.
          const { merged, report } = mergeBundle(local, incoming, { prefer: 'newest' });
          options.apply?.(merged, ctx);
          SECTIONS.forEach((name) => ctx.storage.setItem(`auragrid.${name}`, JSON.stringify(merged[name] ?? {})));
          lastChecksum = incoming.checksum;
          ctx.log('backup', describeMerge(report));
          ctx.notify();
          return {
            ok: true,
            report: describeMerge(report),
            added: report.added.length,
            replaced: report.replaced.length,
            skipped: report.skipped.length,
            warnings: report.warnings,
          };
        },
        lastChecksum: () => lastChecksum,
      };
      plugin.wiring = wiring;

      ctx.provide('exportBackup', wiring.export);
      ctx.provide('restoreBackup', wiring.restore);
      ctx.provide('lastBackupChecksum', wiring.lastChecksum);
    },
    dispose() {
      /* nothing held */
    },
  };
  return plugin;
}
