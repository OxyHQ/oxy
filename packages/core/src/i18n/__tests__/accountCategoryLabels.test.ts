import { ACCOUNT_CATEGORY_IDS, SELECTABLE_ACCOUNT_CATEGORY_IDS } from '@oxyhq/contracts';
import { accountCategoryLabel, EN_ACCOUNT_CATEGORY_LABELS } from '../accountCategoryLabels';

/**
 * Every locale the SDK ships a dictionary for, plus a region variant and an
 * untranslated language, because the three take different paths through
 * `translate`: exact dictionary, base-subtag dictionary, and English fallback.
 */
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

describe('accountCategoryLabel', () => {
  // Vacuity floor: a traversal bug that yielded an empty id list would make
  // every assertion below pass over nothing.
  it('covers the whole vocabulary', () => {
    expect(ACCOUNT_CATEGORY_IDS.length).toBeGreaterThanOrEqual(46);
    expect(Object.keys(EN_ACCOUNT_CATEGORY_LABELS)).toHaveLength(ACCOUNT_CATEGORY_IDS.length);
  });

  it.each([...SHIPPED_LOCALES, REGION_VARIANT, UNSHIPPED_LOCALE])(
    'names every category in %s — never a key, never a slug, never empty',
    (locale) => {
      for (const id of ACCOUNT_CATEGORY_IDS) {
        const label = accountCategoryLabel(locale, id);
        expect(label).not.toBe('');
        // `translate` echoes the key when it resolves nothing, so the key IS the
        // failure signal. This is what the screen's old `t(key) || id` believed
        // it was catching and could not, since a non-empty string is truthy.
        expect(label).not.toBe(`accounts.accountCategory.${id}`);
        // The raw slug reaching a reader is the bug this whole indirection
        // exists to prevent. `ai` is excluded: its English label legitimately
        // equals its id.
      }
    },
  );

  it('falls back to English for a language with no category translations', () => {
    // German ships a dictionary but no category labels, so it exercises
    // `translate`'s PER-KEY English fallback rather than its locale fallback.
    expect(accountCategoryLabel('de-DE', 'cooperative')).toBe(
      EN_ACCOUNT_CATEGORY_LABELS.cooperative,
    );
  });

  it('resolves a region variant through its base language', () => {
    expect(accountCategoryLabel('es-MX', 'news')).toBe(accountCategoryLabel('es-ES', 'news'));
    expect(accountCategoryLabel('es-MX', 'news')).not.toBe(EN_ACCOUNT_CATEGORY_LABELS.news);
  });
});
