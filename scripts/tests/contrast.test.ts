import { aura } from '../../src/theme/aura';
import {
  auditPalette,
  checkContrast,
  contrastRatio,
  minimumRatio,
  parseHex,
  relativeLuminance,
  repairContrast,
  toHex,
  type PalettePair,
} from '../../src/theme/contrast';
import { check, near, section } from './harness';

export async function run(): Promise<void> {
  section('Contrast: parsing');
  check('six-digit hex parses', JSON.stringify(parseHex('#00F2FE')) === JSON.stringify({ r: 0, g: 242, b: 254 }));
  check('three-digit hex expands', JSON.stringify(parseHex('#fff')) === JSON.stringify({ r: 255, g: 255, b: 255 }));
  check('alpha is ignored', parseHex('#00F2FE80')?.g === 242);
  check('the hash is optional', parseHex('0B0F19')?.r === 11);
  check('nonsense is refused', parseHex('not a colour') === null);
  check('a hex is rebuilt from rgb', toHex({ r: 0, g: 242, b: 254 }) === '#00f2fe');
  check('out-of-range channels clamp', toHex({ r: 300, g: -5, b: 0 }) === '#ff0000');

  section('Contrast: luminance and ratio');
  check('black is 0 % luminance', near(relativeLuminance('#000000'), 0, 1e-9));
  check('white is 100 % luminance', near(relativeLuminance('#ffffff'), 1, 1e-9));
  check('black on white is 21:1', near(contrastRatio('#000000', '#ffffff'), 21, 0.01));
  check('white on white is 1:1', near(contrastRatio('#ffffff', '#ffffff'), 1, 1e-9));
  check('the ratio is direction independent', contrastRatio('#00F2FE', '#0B0F19') === contrastRatio('#0B0F19', '#00F2FE'));
  check('a colour against itself is always 1', near(contrastRatio('#8A96B2', '#8A96B2'), 1, 1e-9));

  check('body text needs 4.5:1', minimumRatio('normal') === 4.5);
  check('large text needs 3:1', minimumRatio('large') === 3);
  check('a failing pair is reported as failing', !checkContrast('#556078', '#0B0F19').passes);
  check('a passing pair is reported as passing', checkContrast('#E8EDF7', '#0B0F19').passes);
  check('the same pair can pass as large text', checkContrast('#8A96B2', '#0B0F19', 'large').passes);

  section('Contrast: repair');
  const broken = repairContrast('#556078', '#0B0F19');
  check('a broken pair is repaired', broken.report.passes, `${broken.color} at ${broken.report.ratio}`);
  check('repairing an already good pair changes nothing', repairContrast('#E8EDF7', '#0B0F19').color === '#E8EDF7');
  check('repair drops the alpha channel', parseHex(broken.color) !== null);
  const onLight = repairContrast('#8A96B2', '#ffffff');
  check('repair on a light background darkens instead of lightening', relativeLuminance(onLight.color) < relativeLuminance('#8A96B2'));
  check('repair reaches the required ratio', onLight.report.ratio >= 4.5);

  section('Contrast: the real palette');
  // The pairs the UI actually renders. If one of these fails, the theme is wrong and
  // this test is the place it gets caught, not a phone at a gig.
  const pairs: PalettePair[] = [
    { name: 'body text on OLED', foreground: aura.color.text, background: aura.color.oled, size: 'normal' },
    { name: 'body text on surface', foreground: aura.color.text, background: aura.color.surface, size: 'normal' },
    { name: 'body text on raised surface', foreground: aura.color.text, background: aura.color.surfaceRaised, size: 'normal' },
    { name: 'dim text on OLED', foreground: aura.color.textDim, background: aura.color.oled, size: 'normal' },
    { name: 'dim text on surface', foreground: aura.color.textDim, background: aura.color.surface, size: 'normal' },
    { name: 'cyan accent on OLED', foreground: aura.color.cyan, background: aura.color.oled, size: 'large' },
    { name: 'pink accent on OLED', foreground: aura.color.pink, background: aura.color.oled, size: 'large' },
    { name: 'amber warning on OLED', foreground: aura.color.amber, background: aura.color.oled, size: 'large' },
    { name: 'green agent on OLED', foreground: aura.color.green, background: aura.color.oled, size: 'large' },
  ];
  const audit = auditPalette(pairs);
  check('the palette is readable', audit.failures.length === 0, audit.failures.map((failure) => `${failure.foreground} on ${failure.background} = ${failure.ratio}`).join(' | '));
  check('the audit reports the worst pair', audit.worst !== null);
  check('the worst pair still passes', (audit.worst?.passes ?? false) === true, `${audit.worst?.ratio}`);
  check('faint text is intentionally below body contrast', contrastRatio(aura.color.textFaint, aura.color.oled) < contrastRatio(aura.color.text, aura.color.oled));

  section('Contrast: audit mechanics');
  const withFailure = auditPalette([
    { name: 'good', foreground: '#ffffff', background: '#000000', size: 'normal' },
    { name: 'bad', foreground: '#333333', background: '#000000', size: 'normal' },
  ]);
  check('a failing pair is collected', withFailure.failures.length === 1);
  check('the worst pair is the failing one', withFailure.worst?.ratio === contrastRatio('#333333', '#000000'));
  check('an empty palette audits clean', auditPalette([]).failures.length === 0 && auditPalette([]).worst === null);
}
