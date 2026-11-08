import { Studio, MemoryStudioStorage } from '../../src/app/Studio';
import { backupPlugin } from '../../src/app/wiring/backup';
import { i18nPlugin, THEME_PAIRS } from '../../src/app/wiring/i18n';
import { Translator } from '../../src/i18n/strings';
import { check, section } from './harness';
import { fakeEngine } from './wiring-session.test';

export async function run(): Promise<void> {
  section('Sprint 19 wiring: backup and restore');

  const storage = new MemoryStudioStorage();
  storage.setItem('auragrid.presets', JSON.stringify({ p1: { id: 'p1', name: 'Peak Time', updated_date: '2026-11-01T10:00:00Z' } }));
  storage.setItem('auragrid.tracks', JSON.stringify({ t1: { id: 't1', title: 'Aura', bpm: 128 } }));

  const studio = new Studio({ engine: fakeEngine(), translator: new Translator(), storage, deckCount: 2 });
  await studio.boot([backupPlugin()]);
  check('backup commands are published', ['exportBackup', 'restoreBackup', 'lastBackupChecksum'].every((name) => studio.commands.has(name)));

  const exported = studio.commands.get('exportBackup')!() as { text: string; checksum: string; bytes: number; sections: string[] };
  check('the export carries a checksum', exported.checksum.length > 0, exported.checksum);
  check('the export names its populated sections', exported.sections.includes('presets') && exported.sections.includes('tracks'), JSON.stringify(exported.sections));
  check('an empty section is not claimed', !exported.sections.includes('setPlans'), JSON.stringify(exported.sections));
  check('the export is stored', (storage.getItem('auragrid.backup') ?? '').length === exported.text.length);
  check('the checksum is remembered', studio.commands.get('lastBackupChecksum')!() === exported.checksum);

  // A tampered bundle must be refused and must not touch the library.
  const tampered = exported.text.replace('Peak Time', 'Peak Time!');
  storage.setItem('auragrid.presets', JSON.stringify({ p1: { id: 'p1', name: 'Local Name' } }));
  const refused = studio.commands.get('restoreBackup')!(tampered) as { ok: boolean; report: string; added: number };
  check('a tampered bundle is refused', refused.ok === false, refused.report);
  check('the refusal explains itself', /checksum|refused/i.test(refused.report), refused.report);
  check('a refused restore adds nothing', refused.added === 0);
  const untouched = JSON.parse(storage.getItem('auragrid.presets') ?? '{}');
  check('a refused restore leaves local data alone', untouched.p1.name === 'Local Name', JSON.stringify(untouched));

  // A valid bundle merges: new ids are added, unknown local data survives.
  storage.setItem('auragrid.presets', JSON.stringify({ p9: { id: 'p9', name: 'Local Only' } }));
  const applied = studio.commands.get('restoreBackup')!(exported.text) as { ok: boolean; added: number; report: string };
  check('a valid bundle is accepted', applied.ok === true, applied.report);
  check('it reports what it added', applied.added >= 1, applied.report);
  const merged = JSON.parse(storage.getItem('auragrid.presets') ?? '{}');
  check('the bundle content is back', merged.p1?.name === 'Peak Time', JSON.stringify(Object.keys(merged)));
  check('a local-only preset survives the merge', merged.p9?.name === 'Local Only', JSON.stringify(Object.keys(merged)));

  section('Sprint 20 wiring: language and contrast');

  const translator = new Translator();
  const ustudio = new Studio({ engine: fakeEngine(), translator, storage: new MemoryStudioStorage(), deckCount: 2 });
  await ustudio.boot([i18nPlugin(translator)]);

  check('i18n commands are published', ['setLanguage', 't', 'auditContrast'].every((name) => ustudio.commands.has(name)));
  check('the language is exposed to the UI', ustudio.ctx.state.language === translator.current, String(ustudio.ctx.state.language));

  const setLanguage = ustudio.commands.get('setLanguage')! as (language: string) => void;
  setLanguage('en');
  check('switching language updates the state', ustudio.ctx.state.language === 'en');
  check('switching language updates the translator', translator.current === 'en');
  check('switching back works', (setLanguage('de'), ustudio.ctx.state.language === 'de'));
  check('an unknown language does not break the state', (setLanguage('xx'), typeof ustudio.ctx.state.language === 'string'));

  const audit = ustudio.commands.get('auditContrast')!() as { failures: number; worstRatio: number; checked: number };
  check('every theme pairing is audited', audit.checked === THEME_PAIRS.length, JSON.stringify(audit));
  check('the worst ratio is recorded in state', ustudio.ctx.state.a11y?.worstRatio === audit.worstRatio, JSON.stringify(ustudio.ctx.state.a11y));
  check('the audit result is finite', Number.isFinite(audit.worstRatio) && audit.worstRatio > 0, String(audit.worstRatio));
  check('the audit reports failures honestly', audit.failures >= 0, JSON.stringify(audit));

  await ustudio.shutdown();
  check('shutdown leaves the translator untouched', translator.current === ustudio.ctx.state.language);
}
