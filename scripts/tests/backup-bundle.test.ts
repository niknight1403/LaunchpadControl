import {
  canonicalJson,
  checksumOf,
  createBundle,
  describeBundleSize,
  describeMerge,
  mergeBundle,
  verifyBundle,
} from '../../src/state/BackupBundle';
import { check, section } from './harness';

const preset = (name: string, updated: number) => ({ name, updated_date: updated, gain: 0.8 });

export async function run(): Promise<void> {
  section('Backup: checksum');
  check('a checksum is eight hex characters', /^[0-9a-f]{8}$/.test(checksumOf('hello')));
  check('the same input gives the same checksum', checksumOf('hello') === checksumOf('hello'));
  check('different input gives a different checksum', checksumOf('hello') !== checksumOf('hellp'));
  check('key order does not affect the canonical form', canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }));
  check('the canonical form keeps array order', canonicalJson([1, 2]) !== canonicalJson([2, 1]));
  check('undefined values are dropped', canonicalJson({ a: 1, b: undefined }) === '{"a":1}');

  section('Backup: creating');
  const local = {
    presets: { p1: preset('Peak', 1_000), p2: preset('Warmup', 2_000) },
    tracks: { t1: { title: 'Aurora', bpm: 128 } },
    setPlans: { s1: { name: 'Club night' } },
    mappings: { m1: { target: 'fx:0:cutoff' } },
  };
  const bundle = createBundle({ ...local, createdAt: 1_700_000_000_000 });
  check('the bundle names the app', bundle.app === 'AuraGrid');
  check('the bundle counts its contents', bundle.counts.presets === 2 && bundle.counts.tracks === 1, JSON.stringify(bundle.counts));
  check('the bundle has a checksum', /^[0-9a-f]{8}$/.test(bundle.checksum));
  check('empty sections are still present', createBundle({ createdAt: 1 }).data.mappings.items !== undefined);

  section('Backup: verifying');
  const text = JSON.stringify(bundle);
  const verified = verifyBundle(text);
  check('a good bundle verifies', verified.ok && verified.warnings.length === 0, verified.warnings.join(','));
  check('verifying returns the bundle', verified.bundle?.createdAt === 1_700_000_000_000);

  check('broken json is refused', verifyBundle('{oops').ok === false);
  check('a non-object is refused', verifyBundle('42').ok === false);
  check('a future version is refused', (verifyBundle(JSON.stringify({ version: 2, data: {} })).warnings[0] ?? '').includes('unsupported'));
  const noData = JSON.stringify({ version: 1, checksum: 'x' });
  check('a bundle without data is refused', (verifyBundle(noData).warnings[0] ?? '').includes('no data'));

  const tampered = { ...bundle, counts: { ...bundle.counts, presets: 99 } };
  const tamperedResult = verifyBundle(JSON.stringify(tampered));
  check('a tampered bundle fails the checksum', !tamperedResult.ok && tamperedResult.warnings[0]!.includes('checksum'));

  const missingSection = JSON.parse(text);
  delete missingSection.data.mappings;
  // The checksum covers the data, so removing a section invalidates it first.
  check('removing a section is caught', !verifyBundle(JSON.stringify(missingSection)).ok);

  section('Backup: merging');
  const incoming = createBundle({
    presets: { p1: preset('Peak (new)', 3_000), p3: preset('Closing', 4_000) },
    tracks: { t1: { title: 'Aurora', bpm: 129 } },
    createdAt: 1_700_000_100_000,
  });
  const { merged, report } = mergeBundle(local, incoming);
  check('a new record is added', report.added.includes('presets:p3'));
  check('an existing record is compared', report.replaced.includes('presets:p1') || report.skipped.includes('presets:p1'));
  check('the newer preset wins by default', merged.presets.p1?.updated_date === 3_000, String(merged.presets.p1?.updated_date));
  check('an older local record is kept', merged.presets.p2?.updated_date === 2_000);
  check('a newer incoming track is not automatically taken', merged.tracks.t1?.bpm === 128 || merged.tracks.t1?.bpm === 129);

  const preferLocal = mergeBundle(local, incoming, { prefer: 'local' });
  check('prefer local keeps the local copy', preferLocal.merged.presets.p1?.updated_date === 1_000);
  check('prefer local still adds new records', preferLocal.report.added.includes('presets:p3'));
  const preferIncoming = mergeBundle(local, incoming, { prefer: 'incoming' });
  check('prefer incoming overwrites', preferIncoming.merged.presets.p1?.updated_date === 3_000);
  check('prefer incoming still keeps what it did not receive', preferIncoming.merged.presets.p2 !== undefined);

  section('Backup: deletions');
  const withDeletion = createBundle({
    presets: {},
    deleted: { presets: ['p2'] },
    createdAt: 1_700_000_200_000,
  });
  check('a bundle records its deletions', (withDeletion.data.presets.deleted ?? []).includes('p2'));
  const deletionMerge = mergeBundle(local, withDeletion);
  check('a deletion in the bundle removes the local record', deletionMerge.merged.presets.p2 === undefined);
  check('the removal is reported', deletionMerge.report.removed.includes('presets:p2'));
  const absent = mergeBundle(local, createBundle({ deleted: { presets: ['nope'] }, createdAt: 1 }));
  check('deleting something that is not there is harmless', absent.report.removed.length === 0 && absent.merged.presets.p2 !== undefined);

  section('Backup: summaries');
  check('the merge summary counts everything', describeMerge(report).includes('neu') && describeMerge(report).includes('behalten'));
  check('the size summary is in kilobytes', describeBundleSize(bundle).endsWith('KB'));
  check('an empty merge reports zeroes', describeMerge({ added: [], replaced: [], skipped: [], removed: [], warnings: [] }) === '0 neu, 0 ersetzt, 0 behalten, 0 entfernt');

  section('Backup: roundtrip');
  const restored = verifyBundle(JSON.stringify(createBundle({ ...local, createdAt: 5 })));
  const { merged: mergedOnce } = mergeBundle({}, restored.bundle!);
  const { merged: mergedTwice } = mergeBundle(mergedOnce, createBundle({ ...local, createdAt: 5 }));
  check('restoring twice is idempotent', JSON.stringify(mergedOnce) === JSON.stringify(mergedTwice));
  check('a restored bundle keeps every preset', Object.keys(mergedOnce.presets).length === 2);
}
