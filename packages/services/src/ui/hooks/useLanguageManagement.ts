import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, User, SupportedLanguage } from '@oxy.so/core';
import {
  FALLBACK_LOCALE,
  SUPPORTED_LANGUAGES,
  getBaseLanguage,
  getLanguageMetadata,
  getLanguageName,
  getNativeLanguageName,
  getPrimaryLanguage,
  getUserLanguages,
  normalizeLocale,
} from '@oxy.so/core';
import type { StorageInterface } from '../utils/storageHelpers';
import { extractErrorMessage } from '../utils/errorHandlers';

export interface UseLanguageManagementOptions {
  storage: StorageInterface | null;
  languageKey: string;
  /**
   * The active account, when signed in. When present, the account's primary
   * locale (`languages[0]`) is authoritative for the app's UI locale; when
   * `null` the device locale (or a locally-chosen guest override) is used.
   */
  user: User | null;
  onError?: (error: ApiError) => void;
  logger?: (message: string, error?: unknown) => void;
}

export interface UseLanguageManagementResult {
  /**
   * The active UI locale (a canonical `language-REGION` tag). Derived, never
   * stored: the account's primary locale when signed in, otherwise the
   * locally-chosen guest override, otherwise the device locale.
   */
  currentLanguage: string;
  /**
   * The ordered account locales (primary first) when signed in, or the locally
   * persisted selection when signed out. Empty only before the guest override loads
   * and no device locale resolves.
   */
  languages: string[];
  metadata: SupportedLanguage | null;
  languageName: string;
  nativeLanguageName: string;
  /**
   * Persist a single locally-owned locale (guest / device override) and mark it
   * primary. For signed-in accounts, locale changes are written to the account
   * (`updateProfile({ languages })`) instead — the derived `currentLanguage`
   * then follows the refreshed `user`.
   */
  setLanguage: (locale: string) => Promise<void>;
  /** Persist an ordered guest selection, primary first. */
  setLanguages: (locales: readonly string[]) => Promise<void>;
  hydrateLanguage: () => Promise<void>;
}

/**
 * Append `locale` to an ordered locale list if not already present. Canonical
 * order is preserved; the new locale lands last (non-primary).
 */
export function addLocale(languages: readonly string[], locale: string): string[] {
  const canonical = normalizeLocale(locale);
  if (!canonical) return [...languages];
  if (languages.includes(canonical)) return [...languages];
  return [...languages, canonical];
}

/**
 * Remove `locale` from an ordered locale list. The list's new first element
 * becomes the primary locale.
 */
export function removeLocale(languages: readonly string[], locale: string): string[] {
  const canonical = normalizeLocale(locale);
  if (!canonical) return [...languages];
  return languages.filter((entry) => entry !== canonical);
}

/**
 * Move `locale` to the front of an ordered locale list, making it primary.
 * Adds it if it was not already present.
 */
export function setPrimaryLocale(languages: readonly string[], locale: string): string[] {
  const canonical = normalizeLocale(locale);
  if (!canonical) return [...languages];
  return [canonical, ...languages.filter((entry) => entry !== canonical)];
}

/**
 * Resolve the device/browser locale, mapped to a supported catalog locale.
 *
 * Reads the platform's ordered locale preferences (`navigator.languages` /
 * `navigator.language` on web, `Intl.DateTimeFormat().resolvedOptions().locale`
 * on Hermes) and returns the first that resolves to a supported locale —
 * either exactly or by base-language match (`fr-BE` → `fr-FR`). Falls back to
 * {@link FALLBACK_LOCALE} when nothing resolves. Pure and side-effect free.
 */
function resolveDeviceLocale(): string {
  const candidates: string[] = [];

  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { languages?: readonly string[] };
    if (Array.isArray(nav.languages)) {
      candidates.push(...nav.languages);
    }
    if (typeof nav.language === 'string') {
      candidates.push(nav.language);
    }
  }

  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (intlLocale) {
      candidates.push(intlLocale);
    }
  } catch {
    // Intl is unavailable or incomplete on this runtime — fall through to the
    // navigator-provided candidates (or the fallback locale below).
  }

  for (const candidate of candidates) {
    const exact = normalizeLocale(candidate);
    if (exact) return exact;
    const base = getBaseLanguage(candidate);
    const byBase = SUPPORTED_LANGUAGES.find((entry) => entry.language === base);
    if (byBase) return byBase.code;
  }

  return FALLBACK_LOCALE;
}

/**
 * Resolve and manage the app's active UI locale.
 *
 * The active locale is DERIVED, not stored:
 *  - Signed in  → the account's primary locale (`getPrimaryLanguage(user)`),
 *    falling back to {@link FALLBACK_LOCALE}. This is what makes every Oxy app
 *    follow the account's language automatically.
 *  - Signed out → a locally-chosen guest override if one exists, otherwise the
 *    device locale.
 *
 * The only external system this hook synchronizes with is local storage (the
 * guest override), which is loaded once on mount.
 */
export const useLanguageManagement = ({
  storage,
  languageKey,
  user,
  onError,
  logger,
}: UseLanguageManagementOptions): UseLanguageManagementResult => {
  // The device locale is fixed for the lifetime of the runtime.
  const deviceLanguage = useMemo(resolveDeviceLocale, []);

  // The guest selection is persisted in order, with the first locale primary.
  // Until it loads, the UI uses the device locale.
  const [guestLanguages, setGuestLanguages] = useState<string[]>([]);
  const selectionVersion = useRef(0);

  const loadLanguageFromStorage = useCallback(async (): Promise<void> => {
    if (!storage) {
      return;
    }

    const version = selectionVersion.current;
    try {
      const savedLanguageRaw = await storage.getItem(languageKey);
      // Migrate the former single locale without discarding existing preferences.
      let stored: unknown = savedLanguageRaw;
      if (savedLanguageRaw?.startsWith('[')) {
        stored = JSON.parse(savedLanguageRaw);
      }
      const entries = Array.isArray(stored) ? stored : [stored];
      const normalized = [
        ...new Set(
          entries.flatMap((entry) => {
            const locale = typeof entry === 'string' ? normalizeLocale(entry) : undefined;
            return locale ? [locale] : [];
          }),
        ),
      ];
      if (normalized.length && version === selectionVersion.current) {
        setGuestLanguages(normalized);
      }
    } catch (error) {
      const message = extractErrorMessage(error, 'Failed to load language preference');
      onError?.({
        message,
        code: 'LANGUAGE_LOAD_ERROR',
        status: 500,
      });
      if (logger) {
        logger(message, error);
      } else if (__DEV__) {
        console.warn('Failed to load language preference:', error);
      }
    }
  }, [languageKey, logger, onError, storage]);

  useEffect(() => {
    loadLanguageFromStorage().catch((error) => {
      if (logger) {
        logger('Unexpected error loading language', error);
      }
    });
  }, [loadLanguageFromStorage, logger]);

  const setLanguages = useCallback(
    async (locales: readonly string[]): Promise<void> => {
      if (!storage) {
        throw new Error('Storage not initialized');
      }

      const normalized = [
        ...new Set(
          locales.map((locale) => {
            const canonical = normalizeLocale(locale);
            if (!canonical) throw new Error(`Unsupported locale: ${locale}`);
            return canonical;
          }),
        ),
      ];
      if (!normalized.length) throw new Error('At least one language is required');
      const version = ++selectionVersion.current;
      try {
        await storage.setItem(languageKey, JSON.stringify(normalized));
        if (version === selectionVersion.current) setGuestLanguages(normalized);
      } catch (error) {
        const message = extractErrorMessage(error, 'Failed to save language preference');
        onError?.({
          message,
          code: 'LANGUAGE_SAVE_ERROR',
          status: 500,
        });
        if (logger) {
          logger(message, error);
        } else if (__DEV__) {
          console.warn('Failed to save language preference:', error);
        }
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [languageKey, logger, onError, storage],
  );

  const setLanguage = useCallback((locale: string) => setLanguages([locale]), [setLanguages]);

  const languages = useMemo<string[]>(() => {
    if (user) {
      return getUserLanguages(user);
    }
    return guestLanguages;
  }, [user, guestLanguages]);

  const currentLanguage = useMemo<string>(() => {
    if (user) {
      return getPrimaryLanguage(user) ?? FALLBACK_LOCALE;
    }
    return guestLanguages[0] ?? deviceLanguage;
  }, [user, guestLanguages, deviceLanguage]);

  const metadata = useMemo(() => getLanguageMetadata(currentLanguage), [currentLanguage]);
  const languageName = useMemo(() => getLanguageName(currentLanguage), [currentLanguage]);
  const nativeLanguageName = useMemo(
    () => getNativeLanguageName(currentLanguage),
    [currentLanguage],
  );

  return {
    currentLanguage,
    languages,
    metadata,
    languageName,
    nativeLanguageName,
    setLanguage,
    setLanguages,
    hydrateLanguage: loadLanguageFromStorage,
  };
};
