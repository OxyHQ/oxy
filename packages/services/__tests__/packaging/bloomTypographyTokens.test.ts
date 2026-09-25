/**
 * The account menu, the sign-in views and the other className-styled screens
 * set their type with Bloom's typography utilities (`text-body`,
 * `text-bodySmall`, `text-caption`, …). A consumer's native pipeline compiles
 * those against Bloom's `theme.css`, and react-native-css multiplies any
 * line-height that reaches it through `var()` by the font size. Bloom < 4.21
 * declared those line-heights in px, so `text-body` painted a 22 × 15 = 330dp
 * line on Android: the account menu's giant circular "Switch account" row and
 * 250dp-tall storage chips (OxyHQ/oxy#1375). Bloom 4.21 writes them as
 * unitless ratios.
 *
 * Services cannot ship its own tokens — the consumer compiles Bloom's — so the
 * guard is the peer floor, and that the Bloom this workspace builds against
 * carries ratio tokens for every utility these screens use.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const servicesPackage = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>;
};
const bloomRoot = dirname(require.resolve('@oxy.so/bloom/package.json'));
const themeCss = readFileSync(join(bloomRoot, 'src/design-tokens/theme.css'), 'utf8');

/** Every Bloom type-scale utility a Services component names in a className. */
const USED_TYPE_SCALE = ['body', 'bodySmall', 'caption', 'headerBold', 'sectionTitle', 'subtitle'];

describe("Bloom's typography tokens survive a native pipeline", () => {
  it('requires a Bloom whose type-scale line-heights are ratios', () => {
    const [major, minor, patch] = (servicesPackage.peerDependencies['@oxy.so/bloom'] ?? '')
      .replace(/^\^/, '')
      .split('.')
      .map(Number);
    expect(major).toBe(4);
    // 4.21.0: ratio line-heights. 4.21.1: the collapsed sheet header paints
    // its background on Android.
    expect((minor ?? 0) * 1000 + (patch ?? 0)).toBeGreaterThanOrEqual(21_001);
  });

  it.each(USED_TYPE_SCALE)('`text-%s` declares a unitless line-height', (step) => {
    const match = themeCss.match(new RegExp(`--text-${step}--line-height:\\s*([^;]+);`));
    expect(match).not.toBeNull();
    const value = match?.[1]?.trim() ?? '';
    // A px (or any unit) value is multiplied by the font size on native.
    expect(value).not.toMatch(/[a-z%]\s*$/i);
  });
});
