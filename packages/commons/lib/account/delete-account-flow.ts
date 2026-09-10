/**
 * Account-deletion sequence (identity-safety critical).
 *
 * Encapsulates the exact ordering required to delete an Oxy account without
 * leaving "zombie" key material — or a "zombie" push registration — on the
 * device:
 *
 *   0. Retire this installation's push token, while the outgoing identity's
 *      bearer is still valid.
 *   1. Delete the account server-side (signed request).
 *   2. ONLY if (1) succeeded — purge the local identity key AND its backup.
 *   3. Sign out of all local sessions.
 *
 * Why this lives outside the React screen: the ordering invariants below are
 * security-critical and must be verifiable in isolation, without rendering a
 * native screen or mocking the entire UI tree. The screen is a thin caller.
 *
 * INVARIANTS (enforced + tested):
 *   - `retirePushToken` runs **first**, before the account is deleted and long
 *     before sign-out. `DELETE /notifications/push-token` is scoped to the
 *     identity holding the bearer, so this is the only moment at which the
 *     outgoing identity's registration can actually be removed. Retiring it
 *     later (or after the vault has been re-onboarded with a different
 *     identity) would delete the wrong row and leave this device woken by
 *     sign-in requests for an identity it no longer holds.
 *   - A `retirePushToken` failure is **non-fatal** and never blocks deletion —
 *     an unreachable push registry must not trap a user who wants their account
 *     gone. Deleting the account also makes the stale row undeliverable.
 *   - The local identity is purged **only** inside the success branch of the
 *     server delete. If the server delete throws/rejects, `purgeIdentity` is
 *     NEVER called — the user keeps the keys for an account that still exists.
 *   - The purge runs **before** `signOutAll`, so the device never sits in a
 *     "signed in, but identity already gone" intermediate state.
 *   - A failure of the local purge (after the server already deleted the
 *     account) is **non-fatal**: it is logged and surfaced as a warning, and
 *     the flow still proceeds to `signOutAll`. The account is gone server-side
 *     regardless, so blocking sign-out would only trap the user in a dead
 *     session.
 */

import { logger } from '@oxy.so/core';

/**
 * Side-effecting collaborators for {@link runAccountDeletion}. Injected so the
 * sequence can be unit-tested against the real ordering contract without any
 * native modules, and so the screen wires in the live SDK / KeyManager.
 */
export interface AccountDeletionDeps {
  /**
   * Retire this installation's push token for the identity being deleted.
   * Runs FIRST, while that identity's bearer is still valid — see the
   * invariants above. Failures are swallowed.
   */
  retirePushToken: () => Promise<unknown>;
  /**
   * Delete the account server-side. Must reject if the server did not delete
   * the account — rejection is the signal that the local identity MUST be
   * preserved.
   */
  deleteAccount: (confirmText: string) => Promise<unknown>;
  /**
   * Purge the local identity (primary key + backup) from secure storage.
   * Called at most once, and only after `deleteAccount` has resolved.
   */
  purgeIdentity: () => Promise<void>;
  /** Sign out of every local session on this device. */
  signOutAll: () => Promise<void>;
}

/** Outcome of a successful (server-side) account deletion. */
export interface AccountDeletionResult {
  /**
   * `true` when the local identity (primary + backup) was purged cleanly.
   * `false` when the server delete succeeded but the local purge failed — the
   * caller should surface a non-fatal warning in that case.
   */
  localIdentityPurged: boolean;
}

/**
 * Run the account-deletion sequence.
 *
 * Resolves with {@link AccountDeletionResult} once the account has been
 * deleted server-side and sign-out has completed (whether or not the local
 * purge succeeded).
 *
 * Rejects (without touching the local identity or signing out) if the
 * server-side delete fails — propagate the error so the caller can show the
 * failure to the user and let them retry.
 */
export async function runAccountDeletion(
  confirmText: string,
  deps: AccountDeletionDeps,
): Promise<AccountDeletionResult> {
  // Step 0: stop this installation from being woken for an identity it is about
  // to give up. This has to happen while the outgoing bearer is still valid —
  // the registry scopes the delete to the authenticated identity, so there is
  // no later moment at which this row can be removed. Best-effort: a push
  // registry that is down must never block a deletion the user asked for.
  try {
    await deps.retirePushToken();
  } catch (error) {
    logger.warn(
      'Could not retire this device\'s push token before deleting the account. It may keep receiving sign-in requests until it expires.',
      { component: 'DeleteAccountScreen' },
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Step 1: server-side delete. If this throws, it propagates to the caller
  // and NOTHING below runs — the local identity is left fully intact.
  await deps.deleteAccount(confirmText);

  // Step 2: the account is provably gone server-side. Purge the local identity
  // (primary + backup) so `useIdentity` cannot auto-restore a zombie key for a
  // deleted account on the next mount. A failure here is non-fatal: the account
  // no longer exists, so we log it and continue to sign-out rather than trapping
  // the user in a dead session.
  let localIdentityPurged = true;
  try {
    await deps.purgeIdentity();
  } catch (error) {
    localIdentityPurged = false;
    logger.warn(
      'Account deleted server-side, but purging the local identity key failed. The key/backup may remain on this device.',
      { component: 'DeleteAccountScreen' },
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Step 3: drop all local sessions and let the caller route back to auth.
  await deps.signOutAll();

  return { localIdentityPurged };
}
