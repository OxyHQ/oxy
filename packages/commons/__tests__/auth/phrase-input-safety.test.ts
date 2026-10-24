/**
 * Recovery-phrase and private-key inputs.
 *
 * 1. A paste must hold exactly 12 words. Every paste handler used to keep the
 *    first 12 of a 24-word paste: about one truncation in sixteen passes the
 *    BIP-39 checksum, and the import then made a NEW identity instead of
 *    restoring the user's. Any other count vanished silently.
 * 2. Every secret input turns off autofill saving and keyboard learning.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPastedPhrase, WRONG_WORD_COUNT_KEY } from '@/lib/recovery-phrase/paste';
import { SECRET_INPUT_PROPS } from '@/lib/recovery-phrase/secret-input';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

const TWELVE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('readPastedPhrase', () => {
  it('accepts exactly twelve words, normalised', () => {
    expect(readPastedPhrase(`  ${TWELVE.toUpperCase()}\n`)).toEqual({
      ok: true,
      words: TWELVE.split(' '),
    });
  });

  it('refuses a 24-word paste instead of keeping its first half', () => {
    expect(readPastedPhrase(`${TWELVE} ${TWELVE}`)).toEqual({ ok: false, count: 24 });
  });

  it('reports any other count', () => {
    expect(readPastedPhrase('one two three')).toEqual({ ok: false, count: 3 });
  });

  it('has its message in every locale', () => {
    const [group, step, key] = WRONG_WORD_COUNT_KEY.split('.');
    for (const dict of [en, es] as Record<string, Record<string, Record<string, string>>>[]) {
      expect(dict[group][step][key]).toContain('{{count}}');
    }
  });
});

describe('secret inputs', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  it('turn off autofill saving and keyboard learning', () => {
    expect(SECRET_INPUT_PROPS).toMatchObject({
      autoCorrect: false,
      spellCheck: false,
      autoComplete: 'off',
      importantForAutofill: 'no',
      keyboardType: 'visible-password',
    });
  });

  it.each(['components/auth/PhraseInputGrid.tsx', 'app/(auth)/import-identity/private-key.tsx'])(
    '%s spreads them on its input',
    (path) => {
      expect(read(path)).toContain('{...SECRET_INPUT_PROPS}');
    },
  );

  it.each([
    'app/(auth)/import-identity/index.tsx',
    'app/(auth)/import-identity/restore-from-backup.tsx',
    'app/(tabs)/(settings)/create-backup.tsx',
    'app/(tabs)/(settings)/rotate-key/current-phrase.tsx',
  ])('%s reads pastes through readPastedPhrase, never slicing', (path) => {
    const source = read(path);
    expect(source).toContain('readPastedPhrase(');
    expect(source).not.toMatch(/words\.length === 24/);
  });
});
