import enUS from './locales/en-US';
import { getBaseLanguage } from '../utils/languageUtils';

/** A nested dictionary of strings. */
export interface LocaleDict {
  [key: string]: string | LocaleDict | LocaleDict[] | string[];
}

const FALLBACK = 'en-US';

/**
 * Every dictionary but English loads on demand: an app ships only the languages
 * its people actually use (~200 KB of the ~285 KB total is non-English). English
 * is the fallback for every missing key, so it is always present.
 */
const LOADERS: Record<string, () => Promise<{ default: LocaleDict }>> = {
  'es-ES': () => import('./locales/es-ES'),
  'ca-ES': () => import('./locales/ca-ES'),
  'fr-FR': () => import('./locales/fr-FR'),
  'de-DE': () => import('./locales/de-DE'),
  'it-IT': () => import('./locales/it-IT'),
  'pt-PT': () => import('./locales/pt-PT'),
  'ja-JP': () => import('./locales/ja-JP'),
  'ko-KR': () => import('./locales/ko-KR'),
  'zh-CN': () => import('./locales/zh-CN'),
  'ar-SA': () => import('./locales/ar-SA'),
};

/** Base subtag → the dictionary that serves it. */
const ALIASES: Record<string, string> = {
  en: 'en-US', es: 'es-ES', ca: 'ca-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
  pt: 'pt-PT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA',
};

const DICTS: Record<string, LocaleDict> = { [FALLBACK]: enUS };
const pending = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
let version = 0;

/** The dictionary key serving `locale`, whether or not it is loaded yet. */
function dictionaryFor(locale: string | undefined): string {
  if (locale) {
    if (locale === FALLBACK || LOADERS[locale]) return locale;
    const base = ALIASES[getBaseLanguage(locale)];
    if (base) return base;
  }
  return FALLBACK;
}

/**
 * Load the dictionary serving `locale`. Resolves `true` once it is available
 * (immediately for English or one already loaded), `false` if it failed to load
 * — `translate` then keeps serving English.
 */
export function loadLocale(locale: string | undefined): Promise<boolean> {
  const key = dictionaryFor(locale);
  if (DICTS[key]) return Promise.resolve(true);
  let load = pending.get(key);
  if (!load) {
    load = LOADERS[key]()
      .then((mod) => {
        DICTS[key] = mod.default;
        version++;
        for (const listener of listeners) listener();
        return true;
      })
      .catch(() => false)
      .finally(() => pending.delete(key));
    pending.set(key, load);
  }
  return load;
}

/** Whether the dictionary serving `locale` is loaded (English always is). */
export function isLocaleLoaded(locale: string | undefined): boolean {
  return Boolean(DICTS[dictionaryFor(locale)]);
}

/**
 * Subscribe to dictionaries finishing loading (for re-rendering once a
 * language arrives). Returns the unsubscribe. Pair with {@link getLocalesVersion}
 * in `useSyncExternalStore`.
 */
export function subscribeLocales(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps each time a dictionary loads. */
export function getLocalesVersion(): number {
  return version;
}

/**
 * Resolve a locale tag to the LOADED dictionary that should serve it.
 *
 * Account locales are full BCP-47 tags (e.g. `es-MX`, `pt-BR`), but a
 * dictionary is shipped per language: the exact tag, else its base subtag,
 * else English. A dictionary not loaded yet serves English for now and starts
 * loading — `subscribeLocales` announces its arrival.
 */
function resolveLang(locale: string | undefined): string {
  const key = dictionaryFor(locale);
  if (DICTS[key]) return key;
  void loadLocale(key);
  return FALLBACK;
}

function getNested(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' && (acc as Record<string, unknown>)[key] != null ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

export function translate(locale: string | undefined, key: string, vars?: Record<string, string | number>): string {
  const lang = resolveLang(locale);
  const dict = DICTS[lang] || DICTS[FALLBACK];
  let val = getNested(dict, key);
  // Per-key fallback to the English dictionary when a key is missing from the
  // resolved (non-English) locale. Without this, a key present in en-US but not
  // yet translated in e.g. es-ES would render the raw dotted key to users.
  if (typeof val !== 'string' && lang !== FALLBACK) {
    val = getNested(DICTS[FALLBACK], key);
  }
  if (typeof val !== 'string') return key; // last resort: echo the key when truly absent everywhere
  let text = val;
  if (vars) {
    for (const k of Object.keys(vars)) {
      text = text.split(`{{${k}}}`).join(String(vars[k]));
    }
  }
  return text;
}

export function hasKey(locale: string | undefined, key: string): boolean {
  const lang = resolveLang(locale);
  return getNested(DICTS[lang], key) != null || getNested(DICTS[FALLBACK], key) != null;
}
