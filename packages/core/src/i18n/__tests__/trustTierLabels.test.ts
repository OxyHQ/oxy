import { TRUST_TIERS } from '@oxyhq/contracts';
import { EN_TRUST_TIER_LABELS, trustTierLabel } from '../trustTierLabels';

const SHIPPED_LOCALES = [
  'en-US',
  'es-ES',
  'ca-ES',
  'fr-FR',
  'de-DE',
  'it-IT',
  'pt-PT',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'ar-SA',
] as const;
const REGION_VARIANT = 'es-MX';
const UNSHIPPED_LOCALE = 'nl-NL';

describe('trustTierLabel', () => {
  it('covers the whole vocabulary', () => {
    expect(TRUST_TIERS.length).toBe(5);
    expect(Object.keys(EN_TRUST_TIER_LABELS)).toHaveLength(TRUST_TIERS.length);
  });

  it.each([...SHIPPED_LOCALES, REGION_VARIANT, UNSHIPPED_LOCALE])(
    'names every tier in %s — never a key, never a slug, never empty',
    (locale) => {
      for (const tier of TRUST_TIERS) {
        const label = trustTierLabel(locale, tier);
        expect(label).not.toBe('');
        expect(label).not.toBe(`trust.tiers.${tier}`);
      }
    },
  );

  it('falls back to English for a language with no tier translations', () => {
    expect(trustTierLabel('de-DE', 'high_trust')).toBe(
      EN_TRUST_TIER_LABELS.high_trust,
    );
  });

  it('resolves a region variant through its base language', () => {
    expect(trustTierLabel('es-MX', 'verified')).toBe(trustTierLabel('es-ES', 'verified'));
    expect(trustTierLabel('es-MX', 'verified')).not.toBe(EN_TRUST_TIER_LABELS.verified);
  });
});
