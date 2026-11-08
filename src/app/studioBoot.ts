import { Studio, MemoryStudioStorage, type StudioEngine, type StudioMidi, type StudioStorage } from './Studio';
import { Translator } from '../i18n/strings';
import { sessionPlugin } from './wiring/session';
import { midiLearnPlugin } from './wiring/midi-learn';
import { beatGridPlugin } from './wiring/beat-grid';
import { stemsPlugin } from './wiring/stems';
import { waveformPlugin } from './wiring/waveform';
import { exportPlugin, type ExportPluginOptions } from './wiring/export';
import { meshPlugin, type MeshPluginOptions } from './wiring/mesh';
import { latencyPlugin } from './wiring/latency';
import { backupPlugin, type BackupPluginOptions } from './wiring/backup';
import { i18nPlugin } from './wiring/i18n';

/**
 * The one place that decides which sprints are live and in what order.
 *
 * Order matters: session restore must run before anything that publishes commands (it
 * restores deck state those commands then act on), i18n last so its boot audit sees the
 * finished state.
 */
export interface StudioBootOptions {
  engine: StudioEngine;
  midi?: StudioMidi | null;
  storage?: StudioStorage;
  translator?: Translator;
  deckCount?: number;
  mesh?: MeshPluginOptions;
  export?: ExportPluginOptions;
  backup?: BackupPluginOptions;
  now?: () => number;
}

export interface BootedStudio {
  studio: Studio;
  translator: Translator;
  /** Sprint numbers in install order, for the diagnostics screen. */
  sprints: number[];
}

export async function bootStudio(options: StudioBootOptions): Promise<BootedStudio> {
  const translator = options.translator ?? new Translator();
  const studio = new Studio({
    engine: options.engine,
    midi: options.midi ?? null,
    storage: options.storage ?? new MemoryStudioStorage(),
    translator,
    deckCount: options.deckCount ?? 4,
    now: options.now,
  });

  const plugins = [
    sessionPlugin(),
    midiLearnPlugin(),
    beatGridPlugin(),
    stemsPlugin(),
    waveformPlugin(),
    exportPlugin(options.export),
    meshPlugin(options.mesh),
    latencyPlugin(),
    backupPlugin(options.backup),
    i18nPlugin(translator),
  ];

  await studio.boot(plugins);
  return { studio, translator, sprints: studio.installed.map((entry) => entry.sprint) };
}
