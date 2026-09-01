import { REPUTATION_CATEGORIES } from '@oxyhq/contracts';
import {
  EN_REPUTATION_CATEGORY_LABELS,
  reputationCategoryLabel,
} from '../reputationCategoryLabels';

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

describe('reputationCategoryLabel', () => {
  it('covers the whole vocabulary', () => {
    expect(REPUTATION_CATEGORIES.length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(EN_REPUTATION_CATEGORY_LABELS)).toHaveLength(
      REPUTATION_CATEGORIES.length,
    );
  });

  it.each([...SHIPPED_LOCALES, REGION_VARIANT, UNSHIPPED_LOCALE])(
    'names every category in %s — never a key, never a slug, never empty',
    (locale) => {
      for (const id of REPUTATION_CATEGORIES) {
        const label = reputationCategoryLabel(locale, id);
        expect(label).not.toBe('');
        expect(label).not.toBe(`trust.rules.categories.${id}`);
      }
    },
  );

  it('falls back to English for a language with no category translations', () => {
    expect(reputationCategoryLabel('de-DE', 'physical')).toBe(
      EN_REPUTATION_CATEGORY_LABELS.physical,
    );
  });

  it('resolves a region variant through its base language', () => {
    expect(reputationCategoryLabel('es-MX', 'content')).toBe(
      reputationCategoryLabel('es-ES', 'content'),
    );
    expect(reputationCategoryLabel('es-MX', 'content')).not.toBe(
      EN_REPUTATION_CATEGORY_LABELS.content,
    );
  });
});
