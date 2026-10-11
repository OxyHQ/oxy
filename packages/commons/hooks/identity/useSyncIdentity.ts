import { useCallback, useEffect } from 'react';
import { useOxy, useAuthStore, handleAuthError } from '@oxy.so/services';
import type { User } from '@oxy.so/core';
import { KeyManager } from '@oxy.so/core/crypto';
import { useSilentKeySignIn } from '../useSilentKeySignIn';
import { isUsernameRequiredError } from '@/utils/auth/errorUtils';
import {
  useIdentityStore,
  persistIdentitySyncState,
  getIdentitySyncStateFromStorage,
  getPendingUsernameFromStorage,
  persistPendingUsername,
} from './identityStore';
import { syncIdentityWithServer } from './syncService';
import { acquireSyncLock, isSyncLockAborted } from './syncLock';

const REGISTER_ERROR_CODE = 'REGISTER_ERROR';

export interface SyncIdentityOptions {
  /**
   * The username just chosen at the username step. It is persisted as the
   * pending username BEFORE the round-trip, so an offline or failed attempt
   * keeps it for the reconnect / resume sync.
   */
  username?: string;
}

export interface UseSyncIdentityResult {
  /**
   * Sync the local identity with the server: register-if-needed (with the
   * pending username) + key sign-in. Throws `UsernameRequiredError` for an
   * unregistered key with no username chosen yet.
   */
  syncIdentity: (options?: SyncIdentityOptions) => Promise<User>;
  /** Read + reconcile the persisted "synced with server" flag. */
  isIdentitySynced: () => Promise<boolean>;
  /** Reactive sync state. */
  identitySyncState: {
    isSynced: boolean;
    isSyncing: boolean;
  };
}

/**
 * The vault's single-flight identity → server sync, on its own.
 *
 * This is REGISTRATION sync, not cold-boot session restore: restoring an
 * already-registered identity's session is owned end-to-end by the SDK
 * (`sessionMode="identity"` → the `identity-key-signin` cold-boot step in
 * `@oxy.so/core`, plus its pinned re-mint / 401 / reconnect lanes). What stays
 * here is the half the SDK cannot do — publishing a brand-new or offline-created
 * public key to the server (`isKeyRegistered` → `registerKey`, which carries
 * the username the user chose) and then concluding it with a session. A key is
 * never registered without a username: until one is chosen (the pending
 * username in `identityStore`) the sync stops with `UsernameRequiredError`.
 *
 * Extracted from {@link useIdentity} so a consumer that only needs that sync
 * (the create/import resume paths, the network-reconnect scheduler, the
 * `SessionGate` retry) can reuse it WITHOUT also co-mounting `useIdentity`'s
 * network-reconnect poll loop and on-mount integrity/backup effect. `useIdentity`
 * composes this hook, so its public surface is unchanged — this is
 * decomposition, not a re-export shim.
 *
 * `syncIdentity` serializes globally via `acquireSyncLock` (throws
 * "Sync already in progress" if held), so concurrent callers never double-run;
 * it register-if-needed + signs in SILENTLY with the device's PRIMARY key (via
 * `useSilentKeySignIn`, NOT the biometric-gated wrapper — the network-reconnect
 * scheduler calls it from a timer, where a headless prompt would hang forever).
 * Every await is HttpService-bounded.
 */
export function useSyncIdentity(): UseSyncIdentityResult {
  const { oxyServices } = useOxy();
  // SILENT key sign-in (no biometric gate). `useNetworkReconnect` drives this
  // from a timer, where a headless biometric prompt would never resolve and
  // would hang the sync forever. Biometrics gate INTERACTIVE ops elsewhere.
  const { signInWithKeySilent } = useSilentKeySignIn();

  const isSynced = useIdentityStore((state) => state.isSynced);
  const isSyncing = useIdentityStore((state) => state.isSyncing);
  const setSynced = useIdentityStore((state) => state.setSynced);
  const setSyncing = useIdentityStore((state) => state.setSyncing);
  const hydrateStore = useIdentityStore((state) => state.hydrate);

  useEffect(() => {
    hydrateStore();
  }, [hydrateStore]);

  const isIdentitySynced = useCallback(async (): Promise<boolean> => {
    const synced = await getIdentitySyncStateFromStorage();
    setSynced(synced);
    return synced;
  }, [setSynced]);

  const syncIdentity = useCallback(
    async (options?: SyncIdentityOptions): Promise<User> => {
      if (!oxyServices) throw new Error('OxyServices not initialized');

      // Acquire global sync lock
      const lock = acquireSyncLock();
      setSyncing(true);

      try {
        const chosen = options?.username?.trim();
        if (chosen) {
          await persistPendingUsername(chosen);
        }
        const username = chosen || (await getPendingUsernameFromStorage());

        const result = await syncIdentityWithServer({
          oxyServices,
          signIn: signInWithKeySilent,
          isAlreadySynced: isSynced,
          signal: lock.signal,
          username,
          onSessionExpired: async () => {
            setSynced(false);
            await persistIdentitySyncState(false);
          },
        });

        setSynced(true);
        await persistIdentitySyncState(true);
        // Registered (or already was): nothing is pending any more.
        await persistPendingUsername(null);
        // Commons is the ONLY app that holds the identity; the other Oxy apps are
        // served its shared slot for silent "Sign in with Oxy". Mirror it now,
        // after sign-in, so it equals the server-registered primary. Idempotent,
        // native-only and error-swallowing: it can never fail the sync.
        await KeyManager.syncSharedIdentity();

        return result.user;
      } catch (error) {
        if (isSyncLockAborted(error)) {
          throw new Error('Sync was cancelled');
        }
        // An unregistered key waiting for its username is an expected state,
        // not a failure to report: the caller routes to the username step.
        if (isUsernameRequiredError(error)) {
          throw error;
        }
        handleAuthError(error, {
          defaultMessage: `Failed to sync identity: ${error instanceof Error ? error.message : String(error)}`,
          code: REGISTER_ERROR_CODE,
          setAuthError: (msg: string) => useAuthStore.setState({ error: msg }),
          logger: __DEV__ ? console.warn : undefined,
        });
        throw error;
      } finally {
        setSyncing(false);
        lock.release();
      }
    },
    [oxyServices, signInWithKeySilent, setSynced, setSyncing, isSynced],
  );

  return {
    syncIdentity,
    isIdentitySynced,
    identitySyncState: {
      isSynced: isSynced ?? false,
      isSyncing: isSyncing ?? false,
    },
  };
}
