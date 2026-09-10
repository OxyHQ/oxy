import { useCallback, useMemo } from 'react';
import { translate as coreTranslate } from '@oxy.so/core';
import { useLocale } from './locale-context';
import enAccounts from './locales/en.json';
import esAccounts from './locales/es.json';
import type {
  Locale,
  LocaleDict,
  LocaleNode,
  TranslateFn,
  TranslationVars,
} from './types';

/**
 * Accounts-namespaced dictionaries loaded at module init. Only English and
 * Spanish are populated; other supported locales fall back to English for
 * accounts-only keys, then to core's larger dictionary and then to the raw key.
 */
const ACCOUNTS_DICTS: Partial<Record<Locale, LocaleDict>> = {
  'en-US': enAccounts as LocaleDict,
  'es-ES': esAccounts as LocaleDict,
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
 * Pick the right pluralization variant by appending `_zero` / `_one` suffixes
 * based on the `count` interpolation variable, matching the convention used
 * in core's `signin.actions.openAccountSwitcherSubtitle_singular` family of
 * keys. Returns the original key if no plural variant exists.
 */
function pluralizeKey(
  key: string,
  vars: TranslationVars | undefined,
  dict: LocaleDict | undefined,
): string {
  if (!vars || typeof vars.count !== 'number') return key;
  const count = vars.count;
  const variant = count === 0 ? 'zero' : count === 1 ? 'one' : null;
  if (!variant) return key;
  const candidate = `${key}_${variant}`;
  if (lookup(dict, candidate) != null) return candidate;
  return key;
}

interface UseTranslationResult {
  t: TranslateFn;
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
}

/**
 * Returns the translation function plus the current locale and a setter.
 *
 * Resolution order:
 *   1. Accounts-namespaced dict for the active locale (`en.json` / `es.json`)
 *   2. English accounts dict when the active locale has no accounts overlay
 *   3. Core's `translate(locale, key, vars)` (covers all 11 locales for shared
 *      strings like `signin.*`, `signup.*`, etc.)
 *   4. The raw key string, so missing translations surface visibly without
 *      breaking the UI.
 */
export function useTranslation(): UseTranslationResult {
  const { locale, setLocale } = useLocale();

  const dict = useMemo(
    () => ACCOUNTS_DICTS[locale] ?? ACCOUNTS_DICTS['en-US'],
    [locale],
  );

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      const resolvedKey = pluralizeKey(key, vars, dict);

      const local = lookup(dict, resolvedKey);
      if (local != null) return interpolate(local, vars);

      const fromCore = coreTranslate(locale, resolvedKey, vars);
      if (fromCore !== resolvedKey) return fromCore;

      // Both layers missed — return the original key for visibility.
      return key;
    },
    [dict, locale],
  );

  return { t, locale, setLocale };
}
