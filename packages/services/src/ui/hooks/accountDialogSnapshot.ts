import { useCallback, useSyncExternalStore } from 'react';
import type { AccountDialogController, AccountDialogSnapshot } from '@oxy.so/core/session';

/**
 * The snapshot `useSyncExternalStore` reads before a controller exists.
 *
 * `useSyncExternalStore` calls `getSnapshot` several times per commit and
 * compares by identity, so the no-controller answer has to be one constant
 * reference — a fresh object literal loops.
 *
 * It is ONE constant because there were three, byte-identical, in the hook and
 * both dialog surfaces. Adding a field to `AccountDialogSnapshot` broke all
 * three at once and would have gone on doing so; a shared constant makes the
 * compiler point at one place.
 */
export const EMPTY_ACCOUNT_DIALOG_SNAPSHOT: AccountDialogSnapshot = {
  view: 'accounts',
  backView: null,
  hasSession: false,
  directory: null,
  activeContext: null,
  activatingContextId: null,
  removingContextId: null,
  removingPrincipalId: null,
  loading: false,
  error: null,
  signIn: {
    phase: 'idle',
    authorizeCode: null,
    qrPayload: null,
    expiresAt: null,
    error: null,
    failure: null,
    route: null,
    routeFailed: false,
    pushSentAt: null,
    openedAt: null,
    progress: 'idle',
    attempt: 0,
    inline: false,
  },
  commonsAvailability: 'unknown',
};

/**
 * Bind a surface to `controller`'s snapshot (the inert one while there is no
 * controller). `getSnapshot` returns a stable reference between changes, so
 * it is `useSyncExternalStore`-safe.
 */
export function useAccountDialogSnapshot(controller: AccountDialogController | null): AccountDialogSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined),
    [controller],
  );
  const getSnapshot = useCallback(
    () => (controller ? controller.getSnapshot() : EMPTY_ACCOUNT_DIALOG_SNAPSHOT),
    [controller],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
