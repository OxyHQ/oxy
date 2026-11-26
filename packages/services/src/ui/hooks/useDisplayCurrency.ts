import { useCallback } from 'react';
import { model, useAction, useModel, withStore } from '@oxy.so/bloom-data';
import type { UserPreferences } from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';
import { saveDisplayCurrency } from '../data/account';
import { deviceStorage } from '../data/deviceStorage';
import { useCurrentUser } from './queries/useAccountQueries';

export type DisplayCurrency = NonNullable<UserPreferences['displayCurrency']>;
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['USD', 'EUR', 'FAIR'];

/**
 * The currency a signed-out viewer picked: in memory, on the device (every
 * observer shares it), never written to an account.
 */
const SignedOutCurrency = model<DisplayCurrency>('oxy.display-currency.signed-out');

/** Account-scoped server preference. A late save can never replace another account. */
export function useDisplayCurrency() {
  const { oxyServices, activeSessionId, isAuthenticated, user } = useOxy();
  const current = useCurrentUser({ enabled: isAuthenticated });
  const device = deviceStorage().store;
  const signedOut = useModel(SignedOutCurrency, device);
  const save = useAction(saveDisplayCurrency);
  const { run } = save;
  const currency = isAuthenticated
    ? (current.value?.userPreferences?.displayCurrency ??
      user?.userPreferences?.displayCurrency ??
      'USD')
    : (signedOut ?? 'USD');
  const userId = user?.id;
  const selectCurrency = useCallback(
    (next: DisplayCurrency) => {
      if (!DISPLAY_CURRENCIES.includes(next)) return;
      if (!isAuthenticated) {
        withStore(device, () => SignedOutCurrency.set(next));
        return;
      }
      // The failure is kept in `error`.
      if (activeSessionId && userId)
        run(oxyServices, activeSessionId, userId, next).catch(() => undefined);
    },
    [isAuthenticated, device, activeSessionId, userId, run, oxyServices],
  );
  return { currency, selectCurrency, isSaving: save.isPending, error: save.error };
}
