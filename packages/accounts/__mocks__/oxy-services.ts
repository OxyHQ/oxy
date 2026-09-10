/**
 * Lightweight `@oxy.so/services` stub for the accounts i18n unit tests.
 *
 * Mirrors the parts of the real SDK the `LocaleProvider` consumes: `useOxy()`
 * exposes the derived `currentLanguage` / `currentLanguages` and the guest
 * `setLanguage` writer, and `useUpdateProfile()` writes the account's ordered
 * locales. Both writers update the derived locale so consumers re-render — the
 * same way the real SDK's `currentLanguage` follows the refreshed account.
 *
 * `useOxy()` is implemented with `useSyncExternalStore` so that calls to
 * `__setOxyState({...})` outside of React are immediately reflected in any
 * mounted consumer's next render.
 */

import { useSyncExternalStore } from 'react';

interface MockOxyState {
  user: { username?: string; languages?: string[] } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** The active UI locale, as the real SDK derives it. */
  currentLanguage: string;
  /** The ordered account locales (primary first), or the single guest locale. */
  currentLanguages: string[];
}

function makeDefaultState(): MockOxyState {
  return {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    currentLanguage: 'en-US',
    currentLanguages: [],
  };
}

let state: MockOxyState = makeDefaultState();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function __setOxyState(next: Partial<MockOxyState>): void {
  state = { ...state, ...next };
  emit();
}

// Guest override writer: stores a single locale and makes it the active locale.
const setLanguage = jest.fn(async (locale: string): Promise<void> => {
  __setOxyState({ currentLanguage: locale, currentLanguages: [locale] });
});

// Account writer: `{ languages }` sets the ordered account locales; the derived
// `currentLanguage` then follows `languages[0]`.
const updateProfileMutateAsync = jest.fn(
  async (updates: { languages?: string[] }): Promise<void> => {
    const languages = updates.languages;
    if (languages && languages.length > 0) {
      __setOxyState({ currentLanguage: languages[0], currentLanguages: languages });
    }
  },
);

export function __resetOxyState(): void {
  state = makeDefaultState();
  setLanguage.mockClear();
  updateProfileMutateAsync.mockClear();
  emit();
}

/** Exposes the locale writer spies for call assertions. */
export function __getLanguageMocks(): {
  setLanguage: jest.Mock;
  updateProfileMutateAsync: jest.Mock;
} {
  return { setLanguage, updateProfileMutateAsync };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MockOxyState {
  return state;
}

export function useOxy(): MockOxyState & { setLanguage: jest.Mock } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, setLanguage };
}

export function useUpdateProfile(): { mutateAsync: jest.Mock; isPending: boolean } {
  return { mutateAsync: updateProfileMutateAsync, isPending: false };
}
