import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedApiCall, type UserPreferences } from '@oxy.so/core';
import { useOxy } from '../context/OxyContext';
import { useCurrentUser } from './queries/useAccountQueries';
import { queryKeys } from './queries/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { mutationKeys } from './mutations/mutationKeys';

export type DisplayCurrency = NonNullable<UserPreferences['displayCurrency']>;
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['USD', 'EUR', 'FAIR'];

let anonymousCurrency: DisplayCurrency = 'USD';
const anonymousListeners = new Set<() => void>();
const subscribeAnonymous = (listener: () => void) => {
  anonymousListeners.add(listener);
  return () => {
    anonymousListeners.delete(listener);
  };
};
const anonymousSnapshot = () => anonymousCurrency;

/** Account-scoped server preference. A late save can never replace another account. */
export function useDisplayCurrency() {
  const { oxyServices, activeSessionId, isAuthenticated, user } = useOxy();
  const current = useCurrentUser({ enabled: isAuthenticated });
  const client = useQueryClient();
  const anonymous = useSyncExternalStore(
    subscribeAnonymous,
    anonymousSnapshot,
    () => 'USD' as const,
  );
  const currency = isAuthenticated
    ? (current.data?.userPreferences?.displayCurrency ??
      user?.userPreferences?.displayCurrency ??
      'USD')
    : anonymous;
  const mutation = useMutation({
    mutationKey: [...mutationKeys.account.updateSettings],
    mutationFn: async (input: { currency: DisplayCurrency; sessionId: string; userId: string }) => {
      const updated = await authenticatedApiCall(oxyServices, input.sessionId, () =>
        oxyServices.users.updateMe({ userPreferences: { displayCurrency: input.currency } }),
      );
      if (updated.id !== input.userId) throw new Error('Account changed. Please try again.');
      return updated;
    },
    onSuccess: (updated, input) => {
      client.setQueryData(queryKeys.accounts.current(input.sessionId), updated);
      if (useAuthStore.getState().user?.id === input.userId)
        useAuthStore.getState().setUser(updated);
    },
  });
  function selectCurrency(next: DisplayCurrency) {
    if (!DISPLAY_CURRENCIES.includes(next)) return;
    if (!isAuthenticated) {
      anonymousCurrency = next;
      for (const listener of anonymousListeners) listener();
      return;
    }
    if (activeSessionId && user?.id)
      mutation.mutate({ currency: next, sessionId: activeSessionId, userId: user.id });
  }
  return { currency, selectCurrency, isSaving: mutation.isPending, error: mutation.error };
}
