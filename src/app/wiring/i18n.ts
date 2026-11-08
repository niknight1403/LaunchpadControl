import { checkContrast, contrastRatio, minimumRatio, type TextSize } from '../../theme/contrast';
import type { Language, Translator } from '../../i18n/strings';
import type { StudioContext, StudioPlugin } from '../Studio';

/**
 * Sprint 20 wiring: language and legibility reach the surface.
 *
 * Two things were verified but never applied: the translation catalogues (nothing called
 * `t`) and the contrast audit (nothing checked the palette at runtime). Both are cheap
 * to wire and embarrassing to ship without.
 */
export interface I18nWiring {
  setLanguage(language: Language): void;
  language(): Language;
  t(key: string, params?: Record<string, string | number>): string;
  /** Runs the WCAG audit over the pairings the UI actually renders. */
  audit(): { failures: number; worstRatio: number; worstPair: string; checked: number };
}

export interface ThemePair {
  name: string;
  foreground: string;
  background: string;
  size?: TextSize;
}

/** The pairings this UI renders. Kept next to the wiring so a theme change updates both. */
export const THEME_PAIRS: ThemePair[] = [
  { name: 'body on panel', foreground: '#f7fafc', background: '#0b0f19' },
  { name: 'muted label on panel', foreground: '#8a93a8', background: '#0b0f19' },
  { name: 'accent on panel', foreground: '#00f2fe', background: '#0b0f19' },
  { name: 'warning on panel', foreground: '#ffb020', background: '#0b0f19' },
  { name: 'body on raised', foreground: '#f7fafc', background: '#141a29' },
  { name: 'accent on button', foreground: '#04121a', background: '#00f2fe' },
];

export function i18nPlugin(translator: Translator): StudioPlugin & { wiring: I18nWiring | null } {
  const plugin: StudioPlugin & { wiring: I18nWiring | null } = {
    name: 'i18n',
    sprint: 20,
    wiring: null,
    install(ctx: StudioContext) {
      const audit = () => {
        let failures = 0;
        let worstRatioNumber = Number.POSITIVE_INFINITY;
        let worstPair = '';
        THEME_PAIRS.forEach((pair) => {
          const report = checkContrast(pair.foreground, pair.background, pair.size ?? 'normal');
          const ratio = contrastRatio(pair.foreground, pair.background);
          if (ratio < worstRatioNumber) {
            worstRatioNumber = ratio;
            worstPair = pair.name;
          }
          if (!report.passes) {
            failures += 1;
            ctx.log('a11y', `${pair.name}: ${ratio.toFixed(2)}:1 is below ${minimumRatio(pair.size ?? 'normal').toFixed(1)}:1`);
          }
        });
        ctx.state.a11y = { failures, worstRatio: Number(worstRatioNumber.toFixed(2)) };
        ctx.notify();
        return { failures, worstRatio: ctx.state.a11y.worstRatio, worstPair, checked: THEME_PAIRS.length };
      };

      const wiring: I18nWiring = {
        setLanguage: (language) => {
          translator.setLanguage(language);
          ctx.state.language = translator.current;
          ctx.log('i18n', `language ${ctx.state.language}`);
          ctx.notify();
        },
        language: () => ctx.state.language,
        t: (key, params) => translator.t(key, params),
        audit,
      };
      plugin.wiring = wiring;

      ctx.provide('setLanguage', wiring.setLanguage);
      ctx.provide('t', wiring.t);
      ctx.provide('auditContrast', wiring.audit);

      ctx.state.language = translator.current;
      const result = audit();
      ctx.log('a11y', `${result.checked} pairings checked, ${result.failures} below minimum, worst ${result.worstRatio}:1 (${result.worstPair})`);
    },
    dispose() {
      /* the translator is owned by the app */
    },
  };
  return plugin;
}
