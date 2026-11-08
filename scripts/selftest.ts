/**
 * Logic self-test aggregator.
 *
 * Run:  npm run test:logic
 * Both this and the host-compiled C++ checks (android/.../cpp/tests) are green
 * in CI; a red one blocks a release.
 */
import { check, section, totals } from './tests/harness';
import { run as presets } from './tests/presets.test';
import { run as library } from './tests/library.test';
import { run as analysis } from './tests/analysis.test';
import { run as deck } from './tests/deck.test';
import { run as fx } from './tests/fx.test';
import { run as recording } from './tests/recording.test';
import { run as meshSwarm } from './tests/mesh-swarm.test';
import { run as setbuilder } from './tests/setbuilder.test';
import { run as diagnostics } from './tests/diagnostics.test';
import { run as sessionStore } from './tests/session-store.test';
import { run as midiMap } from './tests/midi-map.test';
import { run as beatGrid } from './tests/beat-grid.test';
import { run as stemSplit } from './tests/stem-split.test';
import { run as waveformData } from './tests/waveform-data.test';
import { run as postProcess } from './tests/post-process.test';
import { run as udpTransport } from './tests/udp-transport.test';
import { run as latencyGovernor } from './tests/latency-governor.test';
import { run as backupBundle } from './tests/backup-bundle.test';
import { run as i18n } from './tests/i18n.test';
import { run as contrast } from './tests/contrast.test';
import { run as meshSyncEngine } from './tests/mesh-sync-engine.test';
import { run as wiringSession } from './tests/wiring-session.test';
import { run as wiringMidiLearn } from './tests/wiring-midi-learn.test';
import { run as wiringBeatGrid } from './tests/wiring-beat-grid.test';
import { run as wiringStemsWaveformExport } from './tests/wiring-stems-waveform-export.test';
import { run as wiringMeshLatency } from './tests/wiring-mesh-latency.test';
import { run as wiringBackupI18n } from './tests/wiring-backup-i18n.test';
import { run as harmonic } from './tests/harmonic.test';
import { run as midi } from './tests/midi.test';
import { run as timeline } from './tests/timeline.test';
import { run as meshClock } from './tests/mesh-clock.test';

async function main(): Promise<void> {
  console.log('AuraGrid logic self-test');
  const startedAt = Date.now();

  await presets();
  await library();
  await analysis();
  await deck();
  await fx();
  await recording();
  await meshSwarm();
  await setbuilder();
  await diagnostics();
  await sessionStore();
  await midiMap();
  await beatGrid();
  await stemSplit();
  await waveformData();
  await postProcess();
  await udpTransport();
  await latencyGovernor();
  await backupBundle();
  await i18n();
  await contrast();
  await meshSyncEngine();
  await wiringSession();
  await wiringMidiLearn();
  await wiringBeatGrid();
  await wiringStemsWaveformExport();
  await wiringMeshLatency();
  await wiringBackupI18n();
  await harmonic();
  await midi();
  await timeline();
  await meshClock();

  const { passed, failed } = totals();
  section('Summary');
  check('no failures', failed === 0);
  console.log(
    `\n${passed} passed, ${failed} failed in ${Date.now() - startedAt} ms`,
  );
  // Exit explicitly: a leaked timer from a component under test must not turn a
  // green suite into a hung CI job.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
