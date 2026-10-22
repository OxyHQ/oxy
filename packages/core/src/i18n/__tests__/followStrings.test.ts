/**
 * The follow buttons' strings exist in EVERY locale, with the same
 * `{{placeholders}}` as English: a missing one would fall back to English
 * beside translated text, a wrong placeholder would print `{{name}}`.
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
import bnBD from '../locales/bn-BD';
import hiIN from '../locales/hi-IN';
import idID from '../locales/id-ID';
import ruRU from '../locales/ru-RU';
import trTR from '../locales/tr-TR';
import type { LocaleDict } from '..';

const LOCALES: Record<string, LocaleDict> = {
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
  'bn-BD': bnBD,
  'hi-IN': hiIN,
  'id-ID': idID,
  'ru-RU': ruRU,
  'tr-TR': trTR,
};

/** Every leaf under English's `follow`, as `[dotted key, English text]`. */
function leaves(node: unknown, prefix: string): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, `${prefix}.${key}`),
  );
}

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

const ENGLISH = leaves(enUS.follow, 'follow');

describe('follow button strings', () => {
  it.each(Object.keys(LOCALES))('%s has every key, with English placeholders', (locale) => {
    for (const [key, english] of ENGLISH) {
      const value = lookup(LOCALES[locale], key);
      expect({ key, type: typeof value }).toEqual({ key, type: 'string' });
      expect({ key, placeholders: placeholders(value as string) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });
});
