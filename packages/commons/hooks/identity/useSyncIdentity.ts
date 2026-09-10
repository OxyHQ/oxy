import { useCallback, useEffect } from 'react';
import { useOxy, useAuthStore, handleAuthError } from '@oxy.so/services';
import type { User } from '@oxy.so/core';
import { useSilentKeySignIn } from '../useSilentKeySignIn';
import {
  useIdentityStore,
  persistIdentitySyncState,
  getIdentitySyncStateFromStorage,
} from './identityStore';
import { syncIdentityWithServer } from './syncService';
import { acquireSyncLock, isSyncLockAborted } from './syncLock';

const REGISTER_ERROR_CODE = 'REGISTER_ERROR';

export interface UseSyncIdentityResult {
  /** Sync the local identity with the server (register-if-needed + key sign-in). */
  syncIdentity: () => Promise<User>;
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
 * public key to the server (`checkPublicKeyRegistered` → `register`) and then
 * concluding it with a session so the username step has a bearer.
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
    async (): Promise<User> => {
      if (!oxyServices) throw new Error('OxyServices not initialized');

      // Acquire global sync lock
      const lock = acquireSyncLock();
      setSyncing(true);

      try {
        const result = await syncIdentityWithServer({
          oxyServices,
          signIn: signInWithKeySilent,
          isAlreadySynced: isSynced,
          signal: lock.signal,
          onSessionExpired: async () => {
            setSynced(false);
            await persistIdentitySyncState(false);
          },
        });

        setSynced(true);
        await persistIdentitySyncState(true);

        return result.user;
      } catch (error) {
        if (isSyncLockAborted(error)) {
          throw new Error('Sync was cancelled');
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
