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

import { useEffect } from 'react';
import type { User } from '@oxy.so/core';
import { APP_COLOR_PRESETS, useBloomTheme, type AppColorName } from '@oxy.so/bloom/theme';
import { useAuth } from './useAuth';

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
