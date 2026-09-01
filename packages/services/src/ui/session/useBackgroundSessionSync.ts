/**
 * Keeps the native background credential in step with the session, so an app
 * enables background authentication with one prop and writes no session code of
 * its own.
 *
 * See `./backgroundSession` for what the credential is and why it is separate
 * from the rotating device secret.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { OxyServices } from '@oxyhq/core';
import {
  clearBackgroundSession,
  isBackgroundSessionSupported,
  syncBackgroundSession,
} from './backgroundSession';

export interface UseBackgroundSessionSyncInput {
  /** `OxyProviderProps.backgroundSession`. */
  enabled: boolean;
  oxyServices: OxyServices;
  /** The signed-in account, or `null` when signed out. */
  userId: string | null;
  /** Whether a bearer is available yet — provisioning needs one. */
  canUsePrivateApi: boolean;
}

/**
 * An effect is the right shape here, unusually for this codebase: the work is a
 * side effect on native storage, and it has to react both to an identity change
 * (a value) and to the app being foregrounded (a subscription). There is no
 * derived-state or React Query formulation of "write a credential to the
 * keystore when the user changes or the app comes back".
 *
 * Re-runs on identity change, which is what makes sign-out and account switching
 * work: `syncBackgroundSession` clears a credential belonging to anyone other
 * than `userId` before it does any network work.
 */
export function useBackgroundSessionSync({
  enabled,
  oxyServices,
  userId,
  canUsePrivateApi,
}: UseBackgroundSessionSyncInput): void {
  useEffect(() => {
    if (!isBackgroundSessionSupported()) {
      return;
    }

    if (!enabled) {
      // An app that leaves the feature off must not keep a credential THIS app
      // provisioned earlier. The store is package-scoped (see
      // OxyBackgroundSessionStore), so this cannot revoke a sibling Oxy app's
      // credential under the shared UID.
      void clearBackgroundSession();
      return;
    }

    // A run that is superseded (unmount, or another identity change) must not
    // write the credential it was about to write.
    let current = true;
    // Deliberately NOT caught. `syncBackgroundSession` already handles every
    // runtime failure internally and throws for exactly one thing: an installed
    // `@oxyhq/core` too old to provision. That is a dependency mistake which must
    // surface, so it is allowed to reject — adding a `.catch()` here would put it
    // back behind the silence it was moved out of.
    const run = () => {
      void syncBackgroundSession({
        oxyServices,
        userId,
        canUsePrivateApi,
        isCurrent: () => current,
      });
    };

    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        run();
      }
    });

    return () => {
      current = false;
      subscription.remove();
      // Deliberately NOT clearing here. Unmount is the app closing, which is
      // precisely when the credential has to survive — clearing on teardown
      // would defeat the entire feature. Revocation happens on sign-out (via a
      // `userId` of null), on the server, or when the credential expires.
    };
  }, [enabled, oxyServices, userId, canUsePrivateApi]);
}
