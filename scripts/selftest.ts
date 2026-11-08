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
