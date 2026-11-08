import {
  CATALOGS,
  LANGUAGES,
  Translator,
  catalogueDrift,
  formatNumber,
  interpolate,
  languageFromLocale,
  placeholdersOf,
  type Language,
} from '../../src/i18n/strings';
import { check, section } from './harness';

export async function run(): Promise<void> {
  section('i18n: catalogues');
  const drift = catalogueDrift();
  check('German and English have the same keys', drift.onlyDe.length === 0 && drift.onlyEn.length === 0, `${drift.onlyDe.join(',')} | ${drift.onlyEn.join(',')}`);
  check('both catalogues are populated', Object.keys(CATALOGS.de).length > 20 && Object.keys(CATALOGS.en).length > 20);
  check('the app name is not translated', CATALOGS.de['app.name'] === CATALOGS.en['app.name']);

  // A placeholder typo would render as "{percnet}" on a screen; catch it here.
  const placeholderProblems: string[] = [];
  for (const key of Object.keys(CATALOGS.de)) {
    const german = placeholdersOf(key, 'de').sort().join(',');
    const english = placeholdersOf(key, 'en').sort().join(',');
    if (german !== english) placeholderProblems.push(`${key}: ${german} vs ${english}`);
  }
  check('every key uses the same placeholders in both languages', placeholderProblems.length === 0, placeholderProblems.join(' | '));

  section('i18n: translation');
  const translator = new Translator({ language: 'de' });
  check('German is the default', translator.current === 'de');
  check('a plain key resolves', translator.t('transport.play') === 'Start');
  const english = new Translator({ language: 'en' });
  check('English resolves the same key differently', english.t('transport.play') === 'Play');
  check('an unknown key returns the key itself', translator.t('nope.nothing') === 'nope.nothing');
  check('an unknown key is recorded', translator.missingKeys.includes('nope.nothing'));
  translator.clearMissing();
  check('the missing list can be cleared', translator.missingKeys.length === 0);

  const reported: string[] = [];
  const watched = new Translator({ language: 'en', onMissing: (key) => reported.push(key) });
  watched.t('also.missing');
  check('a missing key is reported to the observer', reported.includes('also.missing'));

  section('i18n: interpolation');
  check('a placeholder is filled', translator.t('deck.label', { index: 2 }) === 'Deck 2');
  check('a string parameter is taken literally', interpolate('{name}', { name: 'Peak Time' }) === 'Peak Time');
  check('a missing parameter leaves the placeholder visible', interpolate('Hi {name}', {}) === 'Hi {name}');
  check('a decimal parameter is localised', interpolate('{value} s', { value: 1.5 }, 'de') === '1,5 s', interpolate('{value} s', { value: 1.5 }, 'de'));
  check('English uses a decimal point', interpolate('{value} s', { value: 1.5 }, 'en') === '1.5 s');
  check('integers are not padded with decimals', interpolate('{percent} %', { percent: 42 }, 'de') === '42 %');
  check('several placeholders in one string', translator.t('backup.merged', { added: 3, replaced: 1 }) === '3 neu, 1 ersetzt');
  check('a percentage string formats', translator.t('diag.cpu', { percent: 71 }) === 'Last 71 %');

  section('i18n: language switching');
  translator.setLanguage('en');
  check('switching changes the output', translator.t('transport.stop') === 'Stop');
  translator.setLanguage('de');
  check('switching back works', translator.t('transport.stop') === 'Stopp');
  check('two translators are independent', english.t('transport.stop') === 'Stop' && translator.t('transport.stop') === 'Stopp');

  section('i18n: plural and locale');
  check('one uses the singular', translator.plural(1, 'Track', 'Tracks') === 'Track');
  check('zero uses the plural', translator.plural(0, 'Track', 'Tracks') === 'Tracks');
  check('a number is formatted with the language locale', formatNumber(1234.5, 'de') === '1.234,5', formatNumber(1234.5, 'de'));
  check('English groups with commas', formatNumber(1234.5, 'en') === '1,234.5');
  check('German device locale maps to German', languageFromLocale('de-AT') === 'de');
  check('underscore locales are handled', languageFromLocale('de_DE') === 'de');
  check('an English locale maps to English', languageFromLocale('en-GB') === 'en');
  // English is the fallback for every non-German locale: it is the lingua franca
  // of a guest DJ, and a French device showing German is worse than showing English.
  check('an unknown locale falls back to English', languageFromLocale('fr-FR') === 'en');
  check('no locale falls back to German', languageFromLocale(null) === 'de');
  check('every catalogue key exists for both languages', LANGUAGES.every((language: Language) => Object.keys(CATALOGS[language]).length === Object.keys(CATALOGS.de).length));
}
