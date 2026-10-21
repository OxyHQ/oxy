/**
 * useAccountColor
 *
 * The account's colour is one value that every Oxy app wears: `users.color`, a
 * Bloom preset NAME the API only stores after its entitlement check (`oxy` and
 * `faircoin` belong to the account with that handle, `mono` to an active
 * benefit). This hook is the single place an app turns that stored name into its
 * Bloom theme, so two apps cannot disagree about which field wins.
 *
 * The portable `themePreference.colorPreset` is the fallback for an account that
 * has no `color` yet. Mode (light/dark) is deliberately out of scope: whether to
 * follow the account's mode is each app's own choice, the colour is not.
 *
 * An app with a stricter rule of its own (a plan the SDK cannot see) passes
 * `canUse`; a name it refuses is simply not applied, so the app keeps its own
 * default instead of a colour the viewer is not entitled to.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { User } from '@oxy.so/core';
import { APP_COLOR_PRESETS, useBloomTheme, type AppColorName } from '@oxy.so/bloom/theme';
import { USER_PROFILE_COLORS, USER_PROFILE_COLOR_PRESETS } from '@oxy.so/contracts/client';
import { useAuth } from './useAuth';
import { useUpdateProfile } from './mutations/useAccountMutations';

function isAppColorName(value: unknown): value is AppColorName {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_COLOR_PRESETS, value)
  );
}

/** The preset an account wears, or `null` when it has none Bloom knows. */
export function resolveAccountColor(
  user: Pick<User, 'color' | 'themePreference'> | null | undefined,
): AppColorName | null {
  const stored = user?.color ?? user?.themePreference?.colorPreset;
  return isAppColorName(stored) ? stored : null;
}

export function useAccountColor({
  canUse,
}: {
  canUse?: (name: AppColorName) => boolean;
} = {}): void {
  const { isAuthenticated, user } = useAuth();
  const { colorPreset, setColorPreset } = useBloomTheme();
  const accountColor = resolveAccountColor(user);
  const allowed = accountColor !== null && (canUse?.(accountColor) ?? true);

  useEffect(() => {
    if (!isAuthenticated || !accountColor || !allowed || accountColor === colorPreset) return;
    setColorPreset(accountColor);
  }, [isAuthenticated, accountColor, allowed, colorPreset, setColorPreset]);
}

type EntitlementSubject = Pick<User, 'username' | 'personalization'> | null | undefined;

/**
 * The presets this account may choose, from the contract's own gate table: a
 * free preset, the one named after the account's handle (`oxy`, `faircoin`), and
 * `mono` while the account holds the benefit that grants it. The API enforces
 * the same rule when it stores the value; this only keeps a picker from offering
 * what it would refuse.
 */
export function entitledAccountColors(
  user: EntitlementSubject,
  now: number = Date.now(),
): readonly AppColorName[] {
  const handle = user?.username?.trim().toLowerCase();
  const grant = user?.personalization?.mentionMono;
  const expires = grant?.expiresAt === null ? Infinity : Date.parse(grant?.expiresAt ?? '');
  const hasMono = grant?.allowed === true && expires > now;
  const supported = new Set<string>(USER_PROFILE_COLOR_PRESETS);
  return USER_PROFILE_COLORS.filter(({ name, gate }) => {
    if (!supported.has(name) || !isAppColorName(name)) return false;
    if (gate === null) return true;
    if (gate === 'handle') return name === handle;
    return name === 'mono' && hasMono;
  }).map(({ name }) => name as AppColorName);
}

/**
 * Choose the account's colour: one `updateMe` writes `color` and the portable
 * `themePreference.colorPreset` together (the mode already on the account is
 * kept), the Bloom theme follows at once, and the session user is updated
 * optimistically so `useAccountColor` agrees with it. `colors` is what the
 * picker should list.
 */
export function useAccountColorSave(): {
  colors: readonly AppColorName[];
  value: AppColorName;
  saveColor: (name: AppColorName) => Promise<void>;
  saving: boolean;
} {
  const { user } = useAuth();
  const { mode, colorPreset, setColorPreset } = useBloomTheme();
  const { mutateAsync, isPending } = useUpdateProfile();
  const colors = useMemo(() => entitledAccountColors(user), [user]);
  const saveColor = useCallback(
    async (name: AppColorName) => {
      if (!colors.includes(name)) throw new Error('Color is not available for this account');
      const previous = colorPreset;
      setColorPreset(name);
      try {
        await mutateAsync({
          color: name,
          themePreference: {
            mode:
              user?.themePreference?.mode ??
              (mode === 'light' || mode === 'dark' ? mode : 'system'),
            colorPreset: name,
          },
        });
      } catch (error) {
        setColorPreset(previous);
        throw error;
      }
    },
    [colors, colorPreset, setColorPreset, mutateAsync, user, mode],
  );
  return { colors, value: colorPreset, saveColor, saving: isPending };
}
