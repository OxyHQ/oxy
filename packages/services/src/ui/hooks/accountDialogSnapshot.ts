import type { AccountDialogSnapshot } from '@oxyhq/core';

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
  accounts: [],
  activeAccountId: null,
  directory: null,
  activeContext: null,
  activatingContextId: null,
  loading: false,
  error: null,
  switchingAccountId: null,
  signIn: {
    phase: 'idle',
    authorizeCode: null,
    qrPayload: null,
    expiresAt: null,
    error: null,
    route: null,
    routeFailed: false,
    pushSentAt: null,
    openedAt: null,
    progress: 'idle',
  },
  commonsAvailability: 'unknown',
};
