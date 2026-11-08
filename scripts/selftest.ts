/**
 * Logic self-test aggregator.
 *
 * Run:  npm run test:logic
 * Both this and the host-compiled C++ checks (android/.../cpp/tests) are green
 * in CI; a red one blocks a release.
 */
import { check, section, totals } from './tests/harness';
import { run as presets } from './tests/presets.test';
import { run as harmonic } from './tests/harmonic.test';
import { run as midi } from './tests/midi.test';
import { run as timeline } from './tests/timeline.test';
import { run as meshClock } from './tests/mesh-clock.test';

async function main(): Promise<void> {
  console.log('AuraGrid logic self-test');
  const startedAt = Date.now();

  await presets();
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
  if (failed > 0) process.exitCode = 1;
}

void main();
