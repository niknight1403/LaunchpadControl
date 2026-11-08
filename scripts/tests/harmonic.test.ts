import {
  estimateKey,
  harmonicCompatibility,
  keyFromCamelot,
  makeKey,
  nextKeyCandidates,
  requiredTempoShift,
  tempoMatchScore,
} from '../../src/agent/harmonic';
import { check, near, section } from './harness';

export async function run(): Promise<void> {
  section('Camelot / harmonic');
  const cMajor = makeKey(0, 'major');
  const aMinor = makeKey(9, 'minor');
  const fSharpMinor = makeKey(6, 'minor');

  check('C major is 8B', cMajor.camelot === '8B', cMajor.camelot);
  check('A minor is 8A', aMinor.camelot === '8A', aMinor.camelot);
  check('F# minor is 11A', fSharpMinor.camelot === '11A', fSharpMinor.camelot);
  check(
    'every code round-trips',
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((root) => {
      const key = makeKey(root as 0, 'major');
      const parsed = keyFromCamelot(key.camelot);
      return parsed !== null && parsed.root === key.root && parsed.mode === 'major';
    }),
  );
  check('same key scores 1.0', harmonicCompatibility(aMinor, aMinor) === 1);
  check('relative major scores 0.95', harmonicCompatibility(aMinor, cMajor) === 0.95);
  check('energy neighbour scores 0.9', harmonicCompatibility(aMinor, makeKey(4, 'minor')) === 0.9);
  const candidates = nextKeyCandidates(aMinor);
  check('candidates include the relative major', candidates.some((entry) => entry.key.camelot === '8B'));
  check(
    'candidates are sorted by score',
    candidates.every((entry, index) => index === 0 || candidates[index - 1]!.score >= entry.score),
  );

  section('Key estimation');
  // A minor tonality: A, C, E strongly weighted.
  const chroma = [5, 0, 3, 0, 4, 2, 0, 1, 0, 6, 0, 1];
  const estimate = estimateKey(chroma);
  check('estimate returns a key', estimate !== null);
  check('estimates A minor', estimate?.camelot === '8A', estimate?.camelot);
  check('confidence is plausible', (estimate?.confidence ?? 0) > 0.5, String(estimate?.confidence));
  check('rejects a malformed vector', estimateKey([1, 2, 3]) === null);

  section('Tempo matching');
  check('87 vs 174 BPM is a match (half time)', tempoMatchScore(87, 174) > 0.95);
  check('128 vs 128 is perfect', tempoMatchScore(128, 128) === 1);
  check('128 vs 150 is poor', tempoMatchScore(128, 150) < 0.2);
  check('shift needed 128 → 132 is +3.1 %', near(requiredTempoShift(128, 132), 0.031, 0.002));
}
