/**
 * The file manager's "Apps with access" strings (ADR 0043 stage 4c) exist in
 * EVERY locale, with the same `{{placeholders}}` as English — a missing one
 * would fall back to English mid-screen, a wrong placeholder would print
 * `{{name}}` to a person.
 */
import arSA from '../locales/ar-SA';
import caES from '../locales/ca-ES';
import deDE from '../locales/de-DE';
import enUS from '../locales/en-US';
import esES from '../locales/es-ES';
import frFR from '../locales/fr-FR';
import itIT from '../locales/it-IT';
import jaJP from '../locales/ja-JP';
import koKR from '../locales/ko-KR';
import ptPT from '../locales/pt-PT';
import zhCN from '../locales/zh-CN';

const LOCALES: Record<string, unknown> = {
  'ar-SA': arSA,
  'ca-ES': caES,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
  'it-IT': itIT,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-PT': ptPT,
  'zh-CN': zhCN,
};

/** Every string key the "Apps with access" section and its revoke flow read. */
const KEYS = [
  'title',
  'description',
  'empty',
  'loadError',
  'via.upload',
  'via.link',
  'revoke',
  'confirm.title',
  'confirm.message',
  'toasts.revoked',
  'toasts.revokeFailed',
  'a11y.revoke',
].map((key) => `fileManagement.appAccess.${key}`);

function lookup(dict: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      dict,
    );
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('file manager "Apps with access" strings', () => {
  it.each(KEYS)('English has %s', (key) => {
    expect(typeof lookup(enUS, key)).toBe('string');
  });

  it.each(Object.keys(LOCALES))('%s has every key, with English placeholders', (locale) => {
    for (const key of KEYS) {
      const value = lookup(LOCALES[locale], key);
      expect({ key, type: typeof value }).toEqual({ key, type: 'string' });
      expect({ key, placeholders: placeholders(value as string) }).toEqual({
        key,
        placeholders: placeholders(lookup(enUS, key) as string),
      });
    }
  });

  it('names the app in the confirmation, the toasts and the accessibility label', () => {
    for (const key of ['confirm.title', 'confirm.message', 'toasts.revoked', 'a11y.revoke']) {
      expect(lookup(enUS, `fileManagement.appAccess.${key}`)).toMatch(/\{\{name\}\}/);
    }
  });
});
