import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy, useAuthStore, handleAuthError } from '@oxy.so/services';
import {
  KeyManager,
  RecoveryPhraseService,
  SignatureService,
  IdentityAlreadyExistsError,
  IdentityPersistError,
  IdentityUnavailableError,
  readIdentityMarker,
} from '@oxy.so/core';
import type { User } from '@oxy.so/core';
import { useBiometricSignIn } from './useBiometricSignIn';
import { useIdentityStore, persistIdentitySyncState, persistOnboardingComplete, persistOnboardingFlow } from './identity/identityStore';
import { useNetworkReconnect } from './identity/useNetworkReconnect';
import { useSyncIdentity } from './identity/useSyncIdentity';
import { isAlreadyRegisteredError, isIdentityPreflightRefusal, IdentityMayExistError } from './identity/identityErrors';
import { ONBOARDING_IDENTITY_QUERY_KEY, ONBOARDING_COMPLETE_QUERY_KEY, ONBOARDING_FLOW_QUERY_KEY } from './useOnboardingStatus';

const REGISTER_ERROR_CODE = 'REGISTER_ERROR';

/**
 * Module-scoped promise used to serialize identity-creation across React
 * re-renders / strict-mode double invocations / accidental double-taps.
 *
 * Without this lock, two concurrent `createIdentity()` calls would both
 * call `RecoveryPhraseService.generateIdentityWithRecovery()` and the
 * second would silently overwrite the first identity (and its recovery
 * phrase would be the only valid one) — catastrophic account loss for
 * any user whose flow re-fires the effect.
 */
let inFlightCreateIdentity: Promise<{ recoveryPhrase: string[]; synced: boolean; user?: User }> | null = null;
let inFlightImportIdentity: Promise<{ synced: boolean }> | null = null;
let inFlightImportPrivateKey: Promise<{ synced: boolean }> | null = null;

export interface UseIdentityResult {
  /**
   * Create a new identity locally (offline-first) and optionally sync with server.
   * Pass `{ skipSync: true }` (e.g. when the caller already detected no
   * connectivity) to skip the register + signIn round-trip entirely instead of
   * blocking on a ~19s DNS timeout — the identity is still created locally and
   * the sync is deferred to the reconnect handler / username step.
   */
  createIdentity: (opts?: { skipSync?: boolean }) => Promise<{ recoveryPhrase: string[]; synced: boolean; user?: User }>;
  /** Import an existing identity from recovery phrase */
  importIdentity: (phrase: string, opts?: { skipSync?: boolean }) => Promise<{ synced: boolean }>;
  /**
   * Import an existing identity from a raw private key (hex) — the recovery
   * path for a user who exported their private key but has NO recovery phrase.
   * Mirrors {@link importIdentity} minus the mnemonic steps: it stores the key
   * directly and (online) registers-if-needed + signs in. No phrase is
   * persisted, so the re-reveal surface correctly reports none.
   */
  importIdentityFromPrivateKey: (privateKeyHex: string, opts?: { skipSync?: boolean }) => Promise<{ synced: boolean }>;
  /** Sync local identity with server (when online) */
  syncIdentity: () => Promise<User>;
  /** Check if device has an identity stored */
  hasIdentity: () => Promise<boolean>;
  /** Get the public key of the stored identity */
  getPublicKey: () => Promise<string | null>;
  /** Check if identity is synced with server */
  isIdentitySynced: () => Promise<boolean>;
  /** Identity sync state (reactive) */
  identitySyncState: {
    isSynced: boolean;
    isSyncing: boolean;
  };
}

/**
 * Identity management hook for accounts app.
 * Handles identity creation, import, sync, and network reconnect sync logic.
 * Uses oxy services for server operations (registration, sign-in, sessions).
 */
export const useIdentity = (): UseIdentityResult => {
  const { oxyServices, isAuthenticated } = useOxy();
  const { signIn } = useBiometricSignIn();
  const queryClient = useQueryClient();

  const setSynced = useIdentityStore((state) => state.setSynced);

  // The single-flight identity → session sync (register-if-needed + key sign-in)
  // and the reactive sync state come from the extracted lean hook. `useIdentity`
  // composes it and layers on create/import, the network-reconnect scheduler, and
  // the on-mount integrity/backup effect — so its public surface is unchanged.
  const { syncIdentity, isIdentitySynced, identitySyncState } = useSyncIdentity();

  const createIdentity = useCallback(
    async (opts?: { skipSync?: boolean }): Promise<{ recoveryPhrase: string[]; synced: boolean; user?: User }> => {
      if (!oxyServices) throw new Error('OxyServices not initialized');
      if (!signIn) throw new Error('signIn not available');

      // Serialize concurrent calls. Without this guard a fast double-tap
      // or React strict-mode double effect would generate (and persist)
      // two separate identities, losing access to the first one. The
      // recovery phrase shown to the user would only match the LAST one
      // written, so a user who already wrote down the first phrase would
      // be locked out.
      if (inFlightCreateIdentity) {
        return inFlightCreateIdentity;
      }

      const run = async (): Promise<{ recoveryPhrase: string[]; synced: boolean; user?: User }> => {
        // Pre-flight interlock (four independent locks against silently
        // overwriting a real identity). Use a DIRECT, cache-bypassing verdict —
        // never the poisoned in-memory cache the old `getPublicKey()` preflight
        // trusted:
        //   - `present`     → a healthy identity exists → resume/sign-in UX.
        //   - `unavailable` → storage is unreadable (locked keychain) → REFUSE;
        //                     a locked keystore is not a blank device.
        //   - `lost`        → keys gone but a marker records a prior identity →
        //                     REFUSE and route to recovery, never overwrite.
        //   - `absent`      → additionally re-check the independent marker store
        //                     in case one landed concurrently (fourth lock).
        const status = await KeyManager.getIdentityStatus({ bypassCache: true });
        if (status.state === 'present') {
          // Caller routes this to sign-in or a confirmation screen.
          throw new IdentityAlreadyExistsError(status.publicKey);
        }
        if (status.state === 'unavailable') {
          throw new IdentityUnavailableError(
            'Cannot create an identity while identity storage is unavailable.',
            status.cause,
          );
        }
        if (status.state === 'lost') {
          throw new IdentityMayExistError(status.marker.publicKey);
        }
        const concurrentMarker = await readIdentityMarker();
        if (concurrentMarker) {
          throw new IdentityMayExistError(concurrentMarker.publicKey);
        }

        let words: string[];
        let publicKey: string;
        try {
          const result = await RecoveryPhraseService.generateIdentityWithRecovery();
          words = result.words;
          publicKey = result.publicKey;
        } catch (genError) {
          // Generation/persistence failed — there is no identity stored
          // locally, no phrase the user could have written down, and no
          // server state. Safe to surface the error as-is.
          console.error('[useIdentity] Failed to generate identity', genError);
          throw genError;
        }

        // From this point on, the identity exists locally. If we throw,
        // we MUST still return the phrase to the caller so it can be
        // shown to the user — losing it permanently would lock them out
        // the next time they wipe the app.

        // Persist the phrase into its dedicated device-only keychain slot so the
        // user can re-reveal it from Settings later. Best-effort: a storage
        // failure must never fail identity creation — the phrase is still
        // returned to the caller for the mandatory acknowledgement screen.
        try {
          await KeyManager.storeRecoveryMnemonic(words.join(' '));
        } catch (mnemonicError) {
          console.warn('[useIdentity] Failed to persist recovery mnemonic for re-reveal', mnemonicError);
        }

        setSynced(false);
        await persistIdentitySyncState(false);
        // A brand-new identity has NOT finished onboarding yet. Reset the
        // local milestone so this identity starts fresh — otherwise a stale
        // `true` left by a prior (deleted) identity on the same device would
        // route the new one straight to the vault, skipping its onboarding
        // wizard. It flips back to `true` only when THIS identity genuinely
        // completes (username + session) in `useOnboardingStatus`.
        await persistOnboardingComplete(false);
        await persistOnboardingFlow('create');

        // Caller detected no connectivity: skip the register + signIn round-trip
        // rather than stalling the "Setting up your account…" screen on a ~19s
        // DNS timeout. The identity already exists locally (keys generated
        // above); sync is deferred to the reconnect handler / username step.
        if (opts?.skipSync) {
          console.warn('[useIdentity] Offline during create — identity stored locally, server sync deferred');
          return { recoveryPhrase: words, synced: false };
        }

        try {
          const { signature, timestamp } = await SignatureService.createRegistrationSignature();

          try {
            await oxyServices.register(publicKey, signature, timestamp);
          } catch (registerError: unknown) {
            // 409 means already registered — that's fine, just sign in.
            if (!isAlreadyRegisteredError(registerError)) {
              throw registerError;
            }
          }

          const user = await signIn(publicKey);

          setSynced(true);
          await persistIdentitySyncState(true);

          // Commons is the ONLY app that writes the cross-app shared identity
          // slot other Oxy apps read for silent "Sign in with Oxy". Mirror it
          // now — after `signIn` — so the shared public key equals the
          // server-registered primary. Idempotent (guarded by
          // `hasSharedIdentity`), native-only (no-op on web), and swallows its
          // own errors, so it can never regress identity creation.
          await KeyManager.migrateToSharedIdentity();

          return {
            recoveryPhrase: words,
            synced: true,
            user,
          };
        } catch (syncError) {
          // Sync failed — identity exists locally, but the server doesn't
          // know about it yet. Log the underlying cause so devs can
          // distinguish a transient network blip from a real server
          // failure (the previous version silently swallowed all sync
          // errors which made debugging account-loss reports impossible).
          console.error('[useIdentity] Identity created locally but server sync failed', syncError);
          return { recoveryPhrase: words, synced: false };
        }
      };

      inFlightCreateIdentity = run();
      try {
        const result = await inFlightCreateIdentity;
        // Identity now exists on-device → refresh the shared onboarding probes so
        // routing (`useOnboardingStatus`) reflects both the new identity AND its
        // reset onboarding-complete milestone without a per-component re-check.
        queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY });
        return result;
      } catch (error) {
        // The typed preflight refusals (already-exists / may-exist / storage-
        // unavailable) are NOT hard failures — the caller maps them to the
        // resume / recovery / retry UX. Only genuinely unexpected errors get the
        // generic "Failed to create identity" toast.
        if (!isIdentityPreflightRefusal(error)) {
          handleAuthError(error, {
            defaultMessage: 'Failed to create identity',
            code: REGISTER_ERROR_CODE,
            setAuthError: (msg: string) => useAuthStore.setState({ error: msg }),
            logger: __DEV__ ? console.warn : undefined,
          });
        }
        setSynced(false);
        await persistIdentitySyncState(false).catch(() => undefined);
        throw error;
      } finally {
        inFlightCreateIdentity = null;
      }
    },
    [oxyServices, signIn, setSynced, queryClient],
  );

  const importIdentity = useCallback(
    async (phrase: string, opts?: { skipSync?: boolean }): Promise<{ synced: boolean }> => {
      if (!oxyServices) throw new Error('OxyServices not initialized');
      if (!signIn) throw new Error('signIn not available');

      // Serialize concurrent imports for the same reasons as createIdentity.
      if (inFlightImportIdentity) {
        return inFlightImportIdentity;
      }

      const run = async (): Promise<{ synced: boolean }> => {
        // Pre-flight interlock via a DIRECT, cache-bypassing verdict. Importing
        // is intentionally a recovery path, so the SAME-identity case is always
        // allowed; we only refuse when overwriting would clobber a DIFFERENT,
        // still-recoverable identity. `KeyManager.importKeyPair` enforces the
        // authoritative atomic guard too — this just yields clearer errors.
        const incomingPublicKey = await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase);
        const status = await KeyManager.getIdentityStatus({ bypassCache: true });
        if (status.state === 'unavailable') {
          throw new IdentityUnavailableError(
            'Cannot import an identity while identity storage is unavailable.',
            status.cause,
          );
        }
        if (status.state === 'present' && status.publicKey !== incomingPublicKey) {
          throw new IdentityAlreadyExistsError(status.publicKey);
        }
        if (status.state === 'lost' && status.marker.publicKey !== incomingPublicKey) {
          // A DIFFERENT identity is recoverable here — importing this phrase
          // would overwrite it. Refuse; recovering the marked account (or an
          // explicit "different identity" confirmation) is the correct path.
          throw new IdentityMayExistError(status.marker.publicKey);
        }
        if (status.state === 'absent') {
          const concurrentMarker = await readIdentityMarker();
          if (concurrentMarker && concurrentMarker.publicKey !== incomingPublicKey) {
            throw new IdentityMayExistError(concurrentMarker.publicKey);
          }
        }

        const publicKey = await RecoveryPhraseService.restoreFromPhrase(phrase);

        // Persist the just-entered phrase so the user can re-reveal it from
        // Settings. Best-effort — a storage failure must never fail the import
        // (the user already holds the written phrase they just typed).
        try {
          await KeyManager.storeRecoveryMnemonic(phrase);
        } catch (mnemonicError) {
          console.warn('[useIdentity] Failed to persist recovery mnemonic for re-reveal', mnemonicError);
        }

        setSynced(false);
        await persistIdentitySyncState(false);
        // Reset the local onboarding milestone for the freshly-imported identity
        // (see the matching reset in `createIdentity`). It flips back to `true`
        // only when this identity completes onboarding in `useOnboardingStatus`.
        await persistOnboardingComplete(false);
        await persistOnboardingFlow('import');

        // Offline: skip register + signIn (same ~19s DNS-timeout stall as create).
        if (opts?.skipSync) {
          console.warn('[useIdentity] Offline during import — identity stored locally, server sync deferred');
          return { synced: false };
        }

        try {
          const { registered } = await oxyServices.checkPublicKeyRegistered(publicKey);

          if (!registered) {
            try {
              const { signature, timestamp } = await SignatureService.createRegistrationSignature();
              await oxyServices.register(publicKey, signature, timestamp);
            } catch (registerError: unknown) {
              if (!isAlreadyRegisteredError(registerError)) {
                throw registerError;
              }
            }
          }

          await signIn(publicKey);

          setSynced(true);
          await persistIdentitySyncState(true);

          // Populate the cross-app shared identity slot (see createIdentity).
          // Idempotent, native-only, error-swallowing — never regresses import.
          await KeyManager.migrateToSharedIdentity();

          return { synced: true };
        } catch (syncError) {
          console.error('[useIdentity] Identity imported locally but server sync failed', syncError);
          return { synced: false };
        }
      };

      inFlightImportIdentity = run();
      try {
        const result = await inFlightImportIdentity;
        // Identity now exists on-device → refresh the shared onboarding probes so
        // routing (`useOnboardingStatus`) reflects both the new identity AND its
        // reset onboarding-complete milestone without a per-component re-check.
        queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY });
        return result;
      } catch (error) {
        // Typed preflight refusals (already-exists / may-exist / unavailable)
        // and the atomic-write persist error carry their own UX; only genuinely
        // unexpected errors get the generic "Failed to import identity" toast.
        if (!isIdentityPreflightRefusal(error) && !(error instanceof IdentityPersistError)) {
          handleAuthError(error, {
            defaultMessage: 'Failed to import identity',
            code: REGISTER_ERROR_CODE,
            setAuthError: (msg: string) => useAuthStore.setState({ error: msg }),
            logger: __DEV__ ? console.warn : undefined,
          });
        }
        throw error;
      } finally {
        inFlightImportIdentity = null;
      }
    },
    [oxyServices, signIn, setSynced, queryClient],
  );

  const importIdentityFromPrivateKey = useCallback(
    async (privateKeyHex: string, opts?: { skipSync?: boolean }): Promise<{ synced: boolean }> => {
      if (!oxyServices) throw new Error('OxyServices not initialized');
      if (!signIn) throw new Error('signIn not available');

      // Serialize concurrent imports (see importIdentity for rationale).
      if (inFlightImportPrivateKey) {
        return inFlightImportPrivateKey;
      }

      const run = async (): Promise<{ synced: boolean }> => {
        const normalizedKey = privateKeyHex.trim().toLowerCase();
        if (!KeyManager.isValidPrivateKey(normalizedKey)) {
          throw new Error('Invalid private key. Check the value and try again.');
        }

        // Same preflight interlock as importIdentity: a raw-key import is a
        // recovery path, so the SAME-identity case is allowed; we only refuse
        // when overwriting would clobber a DIFFERENT, still-recoverable identity.
        const incomingPublicKey = KeyManager.derivePublicKey(normalizedKey);
        const status = await KeyManager.getIdentityStatus({ bypassCache: true });
        if (status.state === 'unavailable') {
          throw new IdentityUnavailableError(
            'Cannot import an identity while identity storage is unavailable.',
            status.cause,
          );
        }
        if (status.state === 'present' && status.publicKey !== incomingPublicKey) {
          throw new IdentityAlreadyExistsError(status.publicKey);
        }
        if (status.state === 'lost' && status.marker.publicKey !== incomingPublicKey) {
          throw new IdentityMayExistError(status.marker.publicKey);
        }
        if (status.state === 'absent') {
          const concurrentMarker = await readIdentityMarker();
          if (concurrentMarker && concurrentMarker.publicKey !== incomingPublicKey) {
            throw new IdentityMayExistError(concurrentMarker.publicKey);
          }
        }

        // Store the key directly. Unlike the phrase path there is NO mnemonic to
        // persist for re-reveal — the user recovered from a raw key export.
        const publicKey = await KeyManager.importKeyPair(normalizedKey);

        // No mnemonic to store for a raw-key import — clear any stale phrase
        // left from a prior identity so Settings re-reveal reports none.
        try {
          await KeyManager.deleteRecoveryMnemonic();
        } catch (mnemonicError) {
          console.warn('[useIdentity] Failed to clear stale recovery mnemonic after private-key import', mnemonicError);
        }

        setSynced(false);
        await persistIdentitySyncState(false);
        await persistOnboardingComplete(false);
        await persistOnboardingFlow('import');

        if (opts?.skipSync) {
          console.warn('[useIdentity] Offline during private-key import — identity stored locally, server sync deferred');
          return { synced: false };
        }

        try {
          const { registered } = await oxyServices.checkPublicKeyRegistered(publicKey);

          if (!registered) {
            try {
              const { signature, timestamp } = await SignatureService.createRegistrationSignature();
              await oxyServices.register(publicKey, signature, timestamp);
            } catch (registerError: unknown) {
              if (!isAlreadyRegisteredError(registerError)) {
                throw registerError;
              }
            }
          }

          await signIn(publicKey);

          setSynced(true);
          await persistIdentitySyncState(true);
          await KeyManager.migrateToSharedIdentity();

          return { synced: true };
        } catch (syncError) {
          console.error('[useIdentity] Identity imported locally but server sync failed', syncError);
          return { synced: false };
        }
      };

      inFlightImportPrivateKey = run();
      try {
        const result = await inFlightImportPrivateKey;
        queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY });
        return result;
      } catch (error) {
        if (!isIdentityPreflightRefusal(error) && !(error instanceof IdentityPersistError)) {
          handleAuthError(error, {
            defaultMessage: 'Failed to import identity',
            code: REGISTER_ERROR_CODE,
            setAuthError: (msg: string) => useAuthStore.setState({ error: msg }),
            logger: __DEV__ ? console.warn : undefined,
          });
        }
        throw error;
      } finally {
        inFlightImportPrivateKey = null;
      }
    },
    [oxyServices, signIn, setSynced, queryClient],
  );

  // Thin passthroughs. Both now THROW `IdentityUnavailableError` when storage is
  // locked/unreadable (rather than the old `false`/`null`); callers must treat a
  // throw as "cannot determine", never as "no identity". `hasIdentity` still
  // returns `false` for a genuine absence and `getPublicKey` still returns `null`
  // for a genuine absence.
  const hasIdentity = useCallback(() => KeyManager.hasIdentity(), []);
  const getPublicKey = useCallback(() => KeyManager.getPublicKey(), []);

  // Identity integrity check and backup restoration (native only).
  //
  // Runs once on mount. Verifies the stored identity can actually
  // sign + verify; if not, attempts to restore from the local backup
  // copy. We log every branch — silent failures here previously
  // masked real account-loss bugs because there was no breadcrumb in
  // the dev console.
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const checkAndRestoreIdentity = async () => {
      try {
        const hasIdentityValue = await KeyManager.hasIdentity();
        if (hasIdentityValue) {
          const isValid = await KeyManager.verifyIdentityIntegrity();
          if (!isValid) {
            console.error('[useIdentity] Identity integrity check FAILED — attempting backup restore');
            const restored = await KeyManager.restoreIdentityFromBackup();
            if (!restored) {
              console.error('[useIdentity] Backup restore FAILED — identity is unrecoverable from this device');
            } else {
              console.warn('[useIdentity] Identity restored from on-device backup');
            }
          } else {
            // Healthy identity — refresh the backup copy so it tracks the
            // current keys. Important for the case where a user just
            // imported a new identity: without refreshing, the backup is
            // stale (or empty) and the next integrity failure would have
            // nothing to restore.
            const backedUp = await KeyManager.backupIdentity();
            if (!backedUp) {
              console.warn('[useIdentity] Failed to refresh on-device identity backup');
            }
          }
        } else {
          // No identity in primary storage — see if the on-device backup
          // can rescue us (e.g., the user re-installed the app on the
          // same device with the keychain still intact).
          const restored = await KeyManager.restoreIdentityFromBackup();
          if (restored) {
            console.warn('[useIdentity] No primary identity found, restored from on-device backup');
            // Identity presence just flipped false → true. The shared onboarding
            // probe (`useOnboardingStatus`) cached the pre-restore `false` with
            // `staleTime: Infinity`, so invalidate its key to force a re-read of
            // KeyManager — otherwise a just-restored returning user (re-install
            // with the keychain intact) is mis-routed into create-identity.
            queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
          }
        }
      } catch (error) {
        console.error('[useIdentity] checkAndRestoreIdentity threw unexpectedly', error);
      }
    };

    checkAndRestoreIdentity();
  }, [queryClient]);

  // Network reconnect sync logic
  useNetworkReconnect({
    oxyServices,
    isAuthenticated,
    hasIdentity,
    syncIdentity,
    isSyncing: identitySyncState.isSyncing,
  });

  return {
    createIdentity,
    importIdentity,
    importIdentityFromPrivateKey,
    syncIdentity,
    hasIdentity,
    getPublicKey,
    isIdentitySynced,
    identitySyncState,
  };
};
