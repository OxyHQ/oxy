import { useCallback, useMemo } from 'react';
import { translate as coreTranslate } from '@oxy.so/core';
import { useLocale } from './locale-context';
import enConsole from './locales/en';
import esConsole from './locales/es';
import type {
  Locale,
  LocaleDict,
  LocaleNode,
  TranslateFn,
  TranslationVars,
} from './types';

/**
 * Console-app namespaced dictionaries loaded at module init. Locales
 * without a populated console dict fall back to core's larger dictionary
 * (which covers shared `signin.*`, `signup.*`, etc.) and then to the raw
 * key for visibility.
 */
const CONSOLE_DICTS: Partial<Record<Locale, LocaleDict>> = {
  'en-US': enConsole,
  'es-ES': esConsole,
};

function lookup(dict: LocaleDict | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  const parts = key.split('.');
  let node: LocaleNode | Array<LocaleNode> | undefined = dict;
  for (const part of parts) {
    if (Array.isArray(node)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isInteger(idx)) return undefined;
      node = node[idx];
    } else if (node && typeof node === 'object') {
      node = (node as Record<string, LocaleNode | Array<LocaleNode>>)[part];
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

/**
 * Returns the translation function plus the current locale and a setter.
 *
 * Resolution order:
 *   1. Console-app dict for the active locale.
 *   2. Core's `translate(locale, key, vars)` covering all 11 locales for
 *      shared `signin.*` / `signup.*` strings.
 *   3. The raw key string, so missing translations surface visibly without
 *      breaking the UI.
 */
export function useTranslation(): UseTranslationResult {
  const { locale, setLocale } = useLocale();

  const dict = useMemo(() => CONSOLE_DICTS[locale], [locale]);

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      const resolvedKey = pluralizeKey(key, vars, dict);

      const local = lookup(dict, resolvedKey);
      if (local != null) return interpolate(local, vars);

      const fromCore = coreTranslate(locale, resolvedKey, vars);
      if (fromCore !== resolvedKey) return fromCore;

      return key;
    },
    [dict, locale],
  );

  return { t, locale, setLocale };
}
