import { useCallback, useSyncExternalStore } from 'react';
import type { OxyServices } from '@oxy.so/core';

/** Observe the bearer subject without retaining the bearer in React state. */
export function useKnownBearerSubject(oxyServices: OxyServices): string | null {
  const subscribe = useCallback(
    (notify: () => void) => oxyServices.session.onChange(notify),
    [oxyServices],
  );
  const snapshot = useCallback(() => oxyServices.session.userId ?? null, [oxyServices]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Preserve existing behavior without a userId/id claim; only a known mismatch closes the gate. */
export function hasKnownSubjectMismatch(
  accountId: string | null | undefined,
  bearerSubject: string | null,
): boolean {
  return !!accountId && bearerSubject !== null && accountId !== bearerSubject;
}
