/**
 * useAccountTheme / useAccountThemeControls
 *
 * The Oxy account carries a portable theme (`user.themePreference`: a mode and
 * a colour preset) that every Oxy app can wear. The COLOUR is the account
 * colour and always applies (`useAccountColor`). Whether an app also follows
 * the account's MODE is the viewer's choice per device: the theme SOURCE.
 *
 * - `account` (the default): the account's mode is applied to Bloom, and a mode
 *   chosen here is written back to the account for the other Oxy apps.
 * - `app`: the mode stays on this device; nothing is written to the account.
 *
 * The source is a local preference, never sent anywhere. On web it is read
 * synchronously, so the first paint already knows it; on native it resolves
 * from AsyncStorage right after mount. Bloom's own persistence still paints the
 * last theme instantly on cold boot, so the account theme lands without a flash
 * once the session resolves.
 */

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { logger, type User } from '@oxy.so/core';
import { useBloomTheme, type AppColorName, type ThemeMode } from '@oxy.so/bloom/theme';
import { createPlatformStorage, isReactNative } from '../utils/storageHelpers';
import { resolveAccountColor, useAccountColor } from './useAccountColor';
import { useAuth } from './useAuth';
import { useUpdateProfile } from './mutations/useAccountMutations';

/** Where the app's theme MODE comes from on this device. */
export type ThemeSource = 'app' | 'account';

type PortableThemeMode = NonNullable<User['themePreference']>['mode'];

const THEME_SOURCE_KEY = 'oxy.theme.source';

function normalizeSource(stored: string | null | undefined): ThemeSource {
  return stored === 'app' ? 'app' : 'account';
}

/**
 * Bloom's richer mode set onto the portable subset the account stores
 * (`adaptive` has no cross-app meaning, so it is `system`).
 */
function toPortableMode(mode: ThemeMode): PortableThemeMode {
  return mode === 'light' || mode === 'dark' ? mode : 'system';
}

/** Web reads `localStorage` synchronously; native resolves in `hydrate`. */
function readInitialSource(): { source: ThemeSource; hydrated: boolean } {
  if (isReactNative() || typeof window === 'undefined') {
    return { source: 'account', hydrated: false };
  }
  try {
    return {
      source: normalizeSource(window.localStorage?.getItem(THEME_SOURCE_KEY)),
      hydrated: true,
    };
  } catch {
    // A sandboxed document's storage getter throws: no stored choice.
    return { source: 'account', hydrated: true };
  }
}

interface ThemeSourceState {
  source: ThemeSource;
  /** True once the stored source is known (at once on web). */
  hydrated: boolean;
  setSource: (source: ThemeSource) => void;
  hydrate: () => Promise<void>;
}

const useThemeSourceStore = create<ThemeSourceState>((set, get) => ({
  ...readInitialSource(),
  setSource(source) {
    set({ source, hydrated: true });
    void createPlatformStorage()
      .then((storage) => storage.setItem(THEME_SOURCE_KEY, source))
      .catch(() => undefined);
  },
  async hydrate() {
    if (get().hydrated) return;
    const stored = await createPlatformStorage()
      .then((storage) => storage.getItem(THEME_SOURCE_KEY))
      .catch(() => null);
    // A choice made while storage was being read wins over the stored one.
    if (!get().hydrated) set({ source: normalizeSource(stored), hydrated: true });
  },
}));

/**
 * Apply the account theme to Bloom: the colour always (through
 * `useAccountColor`, which `canUse` can narrow), the mode while this device's
 * source is `account`. Mount ONCE, inside `OxyProvider` and Bloom's theme
 * provider.
 */
export function useAccountTheme({
  canUse,
}: {
  canUse?: (name: AppColorName) => boolean;
} = {}): void {
  const { isAuthenticated, user } = useAuth();
  const source = useThemeSourceStore((state) => state.source);
  const hydrated = useThemeSourceStore((state) => state.hydrated);
  const hydrate = useThemeSourceStore((state) => state.hydrate);
  const { setMode } = useBloomTheme();
  useAccountColor({ canUse });

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const accountMode = user?.themePreference?.mode;
  useEffect(() => {
    if (!hydrated || !isAuthenticated || source !== 'account' || !accountMode) return;
    setMode(accountMode);
  }, [hydrated, isAuthenticated, source, accountMode, setMode]);
}

export interface AccountThemeControls {
  /** The effective source: `app` whenever no session can reach the account. */
  source: ThemeSource;
  /** Switch this device's source; enabling `account` seeds an account with no theme yet. */
  changeThemeSource: (source: ThemeSource) => void;
  /** Change the mode now; on the `account` source, also write it to the account. */
  changeThemeMode: (mode: ThemeMode) => Promise<void>;
}

/**
 * Source-aware theme mode changes for a settings screen. Bloom changes at once;
 * on the `account` source the account's portable theme follows. Without a
 * usable session the effective source is `app`, so changes stay local, and the
 * stored choice applies again once signed in. The colour is chosen with
 * `useAccountColorSave`.
 */
export function useAccountThemeControls(): AccountThemeControls {
  const { user, canUsePrivateApi } = useAuth();
  const { mode, colorPreset, setMode } = useBloomTheme();
  const { mutateAsync } = useUpdateProfile();
  const storedSource = useThemeSourceStore((state) => state.source);
  const setSource = useThemeSourceStore((state) => state.setSource);
  const source: ThemeSource = canUsePrivateApi ? storedSource : 'app';

  const persist = useCallback(
    async (next: { mode: ThemeMode; colorPreset: AppColorName }) => {
      await mutateAsync({
        themePreference: { mode: toPortableMode(next.mode), colorPreset: next.colorPreset },
      });
    },
    [mutateAsync],
  );

  const changeThemeMode = useCallback(
    async (nextMode: ThemeMode) => {
      setMode(nextMode);
      if (source === 'account') await persist({ mode: nextMode, colorPreset });
    },
    [setMode, source, persist, colorPreset],
  );

  const accountTheme = user?.themePreference;
  const hasAccountTheme =
    !!accountTheme && resolveAccountColor({ themePreference: accountTheme }) !== null;
  const changeThemeSource = useCallback(
    (nextSource: ThemeSource) => {
      setSource(nextSource);
      // An existing account theme is applied by `useAccountTheme`; only an
      // account without one is seeded, from what the viewer sees now.
      if (nextSource !== 'account' || !canUsePrivateApi || hasAccountTheme) return;
      persist({ mode, colorPreset }).catch((error: unknown) => {
        logger.error('Failed to seed the account theme', error);
      });
    },
    [setSource, canUsePrivateApi, hasAccountTheme, persist, mode, colorPreset],
  );

  return { source, changeThemeSource, changeThemeMode };
}
