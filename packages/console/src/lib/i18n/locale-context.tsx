import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { getBaseLanguage, normalizeLocale } from '@oxyhq/core';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './types';
import type { ReactNode } from 'react';
import type { Locale } from './types';

const STORAGE_KEY = 'oxy_console_locale';

/** Coerce any candidate language tag to a supported `Locale`, or `null`. */
function coerceLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const canonical = normalizeLocale(value);
  if (canonical && SUPPORTED_LOCALES.includes(canonical as Locale)) {
    return canonical as Locale;
  }
  // Fall back to a supported locale sharing the same base language
  // (e.g. `en-GB` or bare `en` -> `en-US`, `es-419` -> `es-ES`).
  const base = getBaseLanguage(value);
  if (base) {
    const byBase = SUPPORTED_LOCALES.find((locale) => getBaseLanguage(locale) === base);
    if (byBase) return byBase;
  }
  return null;
}

/** Read browser navigator language and coerce to a supported locale. */
function getBrowserLocale(): Locale | null {
  if (typeof navigator === 'undefined') return null;
  const candidates: Array<string> = [];
  if (Array.isArray(navigator.languages)) {
    candidates.push(...navigator.languages);
  }
  if (navigator.language) {
    candidates.push(navigator.language);
  }
  for (const candidate of candidates) {
    const coerced = coerceLocale(candidate);
    if (coerced) return coerced;
  }
  return null;
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  isReady: boolean;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

interface LocaleProviderProps {
  children: ReactNode;
}

export function LocaleProvider({ children }: LocaleProviderProps) {
  // Read persisted preference synchronously so a Spanish-first user never
  // sees an English flash on first paint.
  const initialLocale = useMemo<Locale>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = coerceLocale(window.localStorage.getItem(STORAGE_KEY));
        if (stored) return stored;
      } catch {
        // localStorage may be unavailable (private mode); fall through.
      }
    }
    const fromBrowser = getBrowserLocale();
    if (fromBrowser) return fromBrowser;
    return DEFAULT_LOCALE;
  }, []);

  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; in-memory state is the source of truth.
      }
    }
  }, []);

  // Mirror `<html lang>` and `<html dir>` to the active locale so screen
  // readers, browser-native a11y and CSS `:dir()` selectors work even
  // before we mirror individual components for RTL.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.lang = locale;
    html.dir = locale === 'ar-SA' ? 'rtl' : 'ltr';
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, isReady: true }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error(
      'useLocale must be used inside <LocaleProvider>. Check src/routes/__root.tsx.',
    );
  }
  return ctx;
}
