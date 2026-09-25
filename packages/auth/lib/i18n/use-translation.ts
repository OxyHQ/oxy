import { useCallback, useMemo } from 'react';
import { translate as coreTranslate } from '@oxy.so/core';
import { useLocale } from './locale';
import enAuth from './locales/en';
import esAuth from './locales/es';
import type {
  Locale,
  LocaleDict,
  LocaleNode,
  TranslateFn,
  TranslationVars,
} from './types';

/**
 * The IdP pages' own copy. A key resolves from the active locale's dict, then
 * core's dictionaries (all 11 locales), then the English dict — and only then
 * to the raw key, which marks copy that exists nowhere.
 */
const AUTH_DICTS: Partial<Record<Locale, LocaleDict>> = {
  'en-US': enAuth as LocaleDict,
  'es-ES': esAuth as LocaleDict,
};

function lookup(dict: LocaleDict | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  const parts = key.split('.');
  let node: LocaleNode | LocaleNode[] | undefined = dict;
  for (const part of parts) {
    if (Array.isArray(node)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isInteger(idx)) return undefined;
      node = node[idx];
    } else if (node && typeof node === 'object') {
      node = (node as Record<string, LocaleNode | LocaleNode[]>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  let out = template;
  for (const k of Object.keys(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(vars[k]));
  }
  return out;
}

/**
 * Append `_one` / `_other` / `_zero` suffixes based on the `count`
 * interpolation variable. Returns the original key if no plural variant
 * exists in the dictionary.
 */
function pluralizeKey(
  key: string,
  vars: TranslationVars | undefined,
  dict: LocaleDict | undefined,
): string {
  if (!vars || typeof vars.count !== 'number') return key;
  const count = vars.count;
  const variant = count === 0 ? 'zero' : count === 1 ? 'one' : 'other';
  const candidate = `${key}_${variant}`;
  if (lookup(dict, candidate) != null) return candidate;
  return key;
}

interface UseTranslationResult {
  t: TranslateFn;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/** The translation function, the page's locale, and its setter (see `AUTH_DICTS` for resolution). */
export function useTranslation(): UseTranslationResult {
  const { locale, setLocale } = useLocale();

  const dict = useMemo(() => AUTH_DICTS[locale], [locale]);

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      const resolvedKey = pluralizeKey(key, vars, dict);

      const local = lookup(dict, resolvedKey);
      if (local != null) return interpolate(local, vars);

      const fromCore = coreTranslate(locale, resolvedKey, vars);
      if (fromCore !== resolvedKey) return fromCore;

      // The IdP's own pages exist in English first; a locale without its own
      // copy reads that, never the raw key.
      const english = lookup(AUTH_DICTS['en-US'], resolvedKey);
      if (english != null) return interpolate(english, vars);

      return key;
    },
    [dict, locale],
  );

  return { t, locale, setLocale };
}
