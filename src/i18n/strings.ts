/**
 * Localisation: German and English, with the failure modes handled.
 *
 * The app is used in German clubs and by English-speaking guests, and the people
 * who use it are under stage pressure: a missing string must never render as an
 * empty label or a crash. So a missing key falls back to the other language, then
 * to the key itself, and the catalogue records what was missing so a test can fail
 * on it instead of a DJ discovering it mid-set.
 */

export type Language = 'de' | 'en';

export const LANGUAGES: Language[] = ['de', 'en'];

export type Catalog = Record<string, string>;

/** Params are interpolated as {name}; numbers are formatted per language. */
export type StringParams = Record<string, string | number>;

const DE: Catalog = {
  'app.name': 'AuraGrid',
  'transport.play': 'Start',
  'transport.stop': 'Stopp',
  'transport.record': 'Aufnahme',
  'deck.label': 'Deck {index}',
  'deck.cue': 'Cue setzen',
  'deck.sync': 'Sync',
  'deck.loop': 'Loop {bars} Takte',
  'library.empty': 'Keine Tracks geladen',
  'library.import': '{count} Track(s) importiert',
  'analysis.running': 'Analyse läuft: {percent} %',
  'analysis.done': 'Analyse fertig in {seconds} s',
  'analysis.failed': 'Analyse fehlgeschlagen: {reason}',
  'recording.started': 'Aufnahme läuft',
  'recording.saved': 'Take gespeichert: {name}',
  'mesh.joined': 'Mit {count} Gerät(en) verbunden',
  'mesh.lost': 'Verbindung verloren, übernehme Master',
  'error.audioUnavailable': 'Audio-Engine nicht verfügbar',
  'error.storageFull': 'Speicher voll',
  'diag.cpu': 'Last {percent} %',
  'diag.xruns': '{count} Aussetzer',
  'diag.ok': 'Alles stabil',
  'backup.merged': '{added} neu, {replaced} ersetzt',
  'backup.verifyFailed': 'Sicherung beschädigt',
};

const EN: Catalog = {
  'app.name': 'AuraGrid',
  'transport.play': 'Play',
  'transport.stop': 'Stop',
  'transport.record': 'Record',
  'deck.label': 'Deck {index}',
  'deck.cue': 'Set cue',
  'deck.sync': 'Sync',
  'deck.loop': '{bars}-bar loop',
  'library.empty': 'No tracks loaded',
  'library.import': '{count} track(s) imported',
  'analysis.running': 'Analysing: {percent} %',
  'analysis.done': 'Analysis done in {seconds} s',
  'analysis.failed': 'Analysis failed: {reason}',
  'recording.started': 'Recording',
  'recording.saved': 'Take saved: {name}',
  'mesh.joined': 'Linked with {count} device(s)',
  'mesh.lost': 'Link lost, taking over as master',
  'error.audioUnavailable': 'Audio engine unavailable',
  'error.storageFull': 'Storage full',
  'diag.cpu': 'Load {percent} %',
  'diag.xruns': '{count} dropouts',
  'diag.ok': 'All stable',
  'backup.merged': '{added} new, {replaced} replaced',
  'backup.verifyFailed': 'Backup is damaged',
};

export const CATALOGS: Record<Language, Catalog> = { de: DE, en: EN };

export interface TranslatorOptions {
  language?: Language;
  /** Called for every key that could not be resolved. Tests assert this is empty. */
  onMissing?: (key: string, language: Language) => void;
}

export class Translator {
  private language: Language;
  private onMissing: (key: string, language: Language) => void;
  private missing = new Set<string>();

  constructor(options: TranslatorOptions = {}) {
    this.language = options.language ?? 'de';
    this.onMissing = options.onMissing ?? (() => undefined);
  }

  get current(): Language {
    return this.language;
  }

  setLanguage(language: Language): void {
    this.language = language;
  }

  get missingKeys(): string[] {
    return [...this.missing];
  }

  clearMissing(): void {
    this.missing.clear();
  }

  /** Resolves a key with interpolation and a documented fallback chain. */
  t(key: string, params: StringParams = {}): string {
    const primary = CATALOGS[this.language][key];
    const fallback = this.language === 'de' ? CATALOGS.en[key] : CATALOGS.de[key];
    const template = primary ?? fallback;
    if (template === undefined) {
      this.missing.add(key);
      this.onMissing(key, this.language);
      // Showing the key beats showing nothing: an operator can report "deck.cue"
      // and it can be fixed, whereas an empty button is invisible in a bug report.
      return key;
    }
    return interpolate(template, params, this.language);
  }

  /** Selects singular or plural form. German and English both use two forms. */
  plural(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
  }
}

const NUMBER_LOCALE: Record<Language, string> = { de: 'de-DE', en: 'en-GB' };

export function formatNumber(value: number, language: Language, digits = 1): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[language], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function interpolate(template: string, params: StringParams, language: Language = 'de'): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    if (typeof value === 'number') {
      // Integers stay integers: "128" not "128,0" when showing a BPM.
      return Number.isInteger(value) ? formatNumber(value, language, 0) : formatNumber(value, language, 1);
    }
    return value;
  });
}

/** Every key present in one catalogue but missing in the other. */
export function catalogueDrift(): { onlyDe: string[]; onlyEn: string[] } {
  const deKeys = new Set(Object.keys(DE));
  const enKeys = new Set(Object.keys(EN));
  return {
    onlyDe: [...deKeys].filter((key) => !enKeys.has(key)),
    onlyEn: [...enKeys].filter((key) => !deKeys.has(key)),
  };
}

/** Placeholders used by a template, for a test that catches a typo like {percnet}. */
export function placeholdersOf(key: string, language: Language = 'de'): string[] {
  const template = CATALOGS[language][key] ?? '';
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
}

/** Picks a language from a device locale string like "de-AT" or "en_US". */
export function languageFromLocale(locale: string | null | undefined): Language {
  if (!locale) return 'de';
  const normalized = locale.toLowerCase().replace('_', '-');
  return normalized.startsWith('de') ? 'de' : 'en';
}
