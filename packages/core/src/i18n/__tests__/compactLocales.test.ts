import { hasKey, loadLocale, translate } from '..';
import { restoreCompactLocale } from '../compactLocale';
import enUS from '../locales/en-US';

const languages = [
  'ar-SA',
  'bn-BD',
  'ca-ES',
  'de-DE',
  'es-ES',
  'fr-FR',
  'hi-IN',
  'id-ID',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-PT',
  'ru-RU',
  'tr-TR',
  'zh-CN',
];

function allPaths(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const next = path ? `${path}.${key}` : key;
    return [next, ...allPaths(child, next)];
  });
}

function getNested(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    const next = (current as Record<string, unknown>)[key];
    return next == null ? undefined : next;
  }, value);
}

describe('compact lazy locales', () => {
  it('does not depend on a mutated English resource', async () => {
    const previous = enUS.notifications.title;
    try {
      enUS.notifications.title = 'mutated by consumer';
      const original = (await import('../locales/fr-FR')).default;
      const compact = (await import('../locales/compact/fr-FR.generated')).default;
      expect(JSON.stringify(compact)).toBe(JSON.stringify(original));
    } finally {
      enUS.notifications.title = previous;
    }
  });

  it('preserves complete original exports, value order, and public translations', async () => {
    for (const language of languages) {
      const original = (await import(`../locales/${language}`)).default;
      const compact = (await import(`../locales/compact/${language}.generated`)).default;
      expect(JSON.stringify(compact)).toBe(JSON.stringify(original));
      expect(compact).not.toBe(original);
      await expect(loadLocale(language)).resolves.toBe(true);
      const paths = new Set([...allPaths(original), ...allPaths(enUS), 'missing.key', '__proto__']);
      const vars = { name: 'Zoë {{count}}', count: 0, total: 2, n: 11 };
      for (const path of paths) {
        const local = getNested(original, path);
        const fallback = getNested(enUS, path);
        let expected =
          typeof local === 'string' ? local : typeof fallback === 'string' ? fallback : path;
        expect(translate(language, path)).toBe(expected);
        for (const [key, value] of Object.entries(vars)) {
          expected = expected.split(`{{${key}}}`).join(String(value));
        }
        expect(hasKey(language, path)).toBe(local != null || fallback != null);
        expect(translate(language, path, vars)).toBe(expected);
      }
    }
  });

  it('restores arrays, empty strings and nulls without shared objects', () => {
    const source = [0, '', null, { value: 'original' }];
    const restored = restoreCompactLocale({ empty: '', value: null, list: [-1, source] }) as {
      empty: string;
      value: null;
      list: typeof source;
    };
    expect(restored).toEqual({ empty: '', value: null, list: source });
    expect(restored.list).not.toBe(source);
    (restored.list[3] as { value: string }).value = 'changed';
    expect(source[3]).toEqual({ value: 'original' });
  });
});
