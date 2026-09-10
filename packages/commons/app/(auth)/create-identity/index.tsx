import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { IdentityAlreadyExistsError, IdentityUnavailableError } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useOnboardingStatus } from '@/hooks/useOnboardingStatus';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { CreatingStep } from '@/components/auth/CreatingStep';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import { CREATING_PROGRESS_INTERVAL_MS, CREATING_FINAL_DELAY_MS } from '@/constants/auth';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';
import { useIdentity } from '@/hooks/useIdentity';
import { useTranslation } from '@/lib/i18n';

/**
 * Create Identity - Creating Screen (Index)
 *
 * Shows progress while generating identity, then routes to the recovery
 * phrase reveal screen (when a fresh identity was just generated) or
 * directly to the username step (when resuming an in-progress flow with
 * an existing identity).
 *
 * The recovery phrase is stashed in `useAuthFlowContext().recoveryPhraseRef`
 * for the next screen to read. It is never persisted to storage.
 */
export default function CreateIdentityScreen() {
  const router = useRouter();
  const colors = useColors();
  const { isAuthenticated, oxyServices } = useOxy();
  const { createIdentity, syncIdentity } = useIdentity();
  const { status, hasIdentity } = useOnboardingStatus();
  const { setAuthError, recoveryPhraseRef } = useAuthFlowContext();
  const { t } = useTranslation();

  const backgroundColor = colors.background;
  const textColor = colors.text;

  const [creatingProgress, setCreatingProgress] = useState(0);
  const creatingProgressRef = useRef<NodeJS.Timeout | null>(null);
  const finalDelayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  // Guards against the effect re-firing — without it, React strict-mode's
  // intentional double-invocation in development would call createIdentity
  // twice. The module-level lock in useIdentity also protects us, but a
  // local guard here keeps the UI consistent (no double-progress bar).
  const hasStartedCreateRef = useRef(false);
  // Guards against issuing the resume-redirect twice within the same mount.
  // The status-change effect can re-run for unrelated dependency changes
  // (router/setAuthError references), and we only want exactly one
  // `replace('/username')` per resume. Note: this does NOT survive remounts;
  // protection against a remount-induced bounce relies on the SDK-side
  // cache invalidation in `updateProfile` keeping `hasUsername` stable.
  const hasNavigatedResumeRef = useRef(false);
  // A hard create failure (e.g. key generation/persistence failed) used to set
  // an auth error that nothing rendered, leaving the user stuck on the endless
  // "Setting up your account…" screen. Track it locally so `CreatingStep` can
  // show the reason + a Retry (issue #605).
  const [createError, setCreateError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const handleRetry = useCallback(() => {
    setCreateError(null);
    hasStartedCreateRef.current = false;
    hasNavigatedResumeRef.current = false;
    setCreatingProgress(0);
    setRetryNonce((n) => n + 1);
  }, []);

  // Cleanup function for all timers
  const cleanupTimers = useCallback(() => {
    if (creatingProgressRef.current) {
      clearInterval(creatingProgressRef.current);
      creatingProgressRef.current = null;
    }
    if (finalDelayTimeoutRef.current) {
      clearTimeout(finalDelayTimeoutRef.current);
      finalDelayTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanupTimers();
    };
  }, [cleanupTimers]);

  useEffect(() => {
    // Wait for status to be determined
    if (status === 'checking') return;

    // A lost or unreadable identity must NEVER run the create flow — route to
    // the recovery ladder / retry surface instead. (Reachable via a race where
    // the cached verdict was `none` but a direct read later found a prior
    // identity, or storage locked mid-flow.)
    if (status === 'recovery') {
      router.replace('/(auth)/recover-identity');
      return;
    }
    if (status === 'unavailable') {
      router.replace('/(auth)');
      return;
    }

    // If identity already exists (e.g., user resumed after closing the
    // app mid-onboarding), sync and route to username. We DO NOT route
    // through the recovery-phrase acknowledgement screen because we no longer
    // have the mnemonic in memory here. The phrase was persisted best-effort at
    // creation, so the user can re-reveal it from Settings → Recovery phrase.
    //
    // hasStartedCreateRef guard: an IN-SESSION create flips status to
    // 'in_progress' the moment the identity query is invalidated, while the
    // create success path is still in its final delay. Without the guard this
    // resume redirect wins that race and sends the user to /username,
    // silently skipping the mandatory recovery-phrase acknowledgement.
    if (status === 'in_progress' && hasIdentity && !hasStartedCreateRef.current) {
      if (hasNavigatedResumeRef.current) return;
      hasNavigatedResumeRef.current = true;

      const checkAndNavigate = async () => {
        const offline = await checkIfOffline();
        if (!isMountedRef.current) return;

        const hasSession = () => Boolean(oxyServices?.getAccessToken());
        let sessionReady = isAuthenticated || hasSession();

        if (!sessionReady && !offline && syncIdentity) {
          try {
            await syncIdentity();
            sessionReady = hasSession();
          } catch (syncErr: unknown) {
            const errorMessage = extractAuthErrorMessage(syncErr);
            setAuthError(errorMessage);
            setCreateError(errorMessage);
            hasNavigatedResumeRef.current = false;
            return;
          }
        }

        // Online resume without a session: username would call authenticated APIs.
        if (!sessionReady && !offline) {
          const syncErrorMessage = t('auth.errors.identityExistsSyncFailed');
          setAuthError(syncErrorMessage);
          setCreateError(syncErrorMessage);
          hasNavigatedResumeRef.current = false;
          return;
        }

        if (!isMountedRef.current) return;
        router.replace('/(auth)/create-identity/username');
      };
      checkAndNavigate();
      return;
    }

    // No identity — create one. The module-level lock in useIdentity
    // serializes concurrent calls, but we still guard locally to avoid
    // double-rendering the progress animation.
    if (status === 'none' && !hasStartedCreateRef.current) {
      hasStartedCreateRef.current = true;
      const create = async () => {
        try {
          // Start progress animation
          setCreatingProgress(0);
          let progressStep = 0;

          const progressInterval = setInterval(() => {
            if (!isMountedRef.current) {
              clearInterval(progressInterval);
              return;
            }
            progressStep++;
            if (progressStep <= 2) {
              setCreatingProgress(progressStep);
            } else {
              clearInterval(progressInterval);
            }
          }, CREATING_PROGRESS_INTERVAL_MS);

          creatingProgressRef.current = progressInterval as unknown as NodeJS.Timeout;

          // Detect connectivity up front so createIdentity can skip the ~19s
          // DNS-timeout on the register/signIn round-trip when offline (the
          // identity is still created locally; sync is deferred). `checkIfOffline`
          // is already imported here safely — do NOT move this probe into
          // `useIdentity`: it loads early in the provider tree and importing
          // `networkUtils` there triggers a circular import that crashes
          // OxyProvider at boot (see issue #605).
          const offline = await checkIfOffline();
          const result = await createIdentity({ skipSync: offline });

          cleanupTimers();

          // Stash the phrase in memory only — the next screen will read it
          // from this ref and clear it after acknowledgement.
          recoveryPhraseRef.current = result.recoveryPhrase;

          // Online but server sync failed: do not advance to recovery phrase —
          // username would call authenticated APIs with no session.
          if (!offline && !result.synced) {
            if (!isMountedRef.current) return;
            const syncErrorMessage = t('auth.errors.identityCreatedSyncFailed');
            setAuthError(syncErrorMessage);
            setCreateError(syncErrorMessage);
            hasStartedCreateRef.current = false;
            setCreatingProgress(0);
            return;
          }

          await new Promise(resolve => setTimeout(resolve, CREATING_FINAL_DELAY_MS));

          if (!isMountedRef.current) return;

          setCreatingProgress(0);
          // CRITICAL: route to the recovery phrase screen BEFORE username.
          // If we skip this and the user later loses the device, their
          // account is unrecoverable.
          router.replace('/(auth)/create-identity/recovery-phrase');
        } catch (err: unknown) {
          cleanupTimers();
          hasStartedCreateRef.current = false;

          if (!isMountedRef.current) return;

          // IdentityAlreadyExistsError is the expected outcome when a
          // user lands here with a half-completed onboarding (identity
          // exists but no username yet). Convert it into "resume" UX
          // instead of treating it as a hard error.
          // A marker-backed refusal means an identity IS (or may be) present but
          // its keys aren't usable → route to the recovery ladder, never surface
          // "creation failed". A storage-unavailable refusal → the retry surface
          // on the (auth) index (a locked keychain is not a blank device).
          if (err instanceof IdentityMayExistError) {
            router.replace('/(auth)/recover-identity');
            return;
          }
          if (err instanceof IdentityUnavailableError) {
            router.replace('/(auth)');
            return;
          }

          if (err instanceof IdentityAlreadyExistsError) {
            const offline = await checkIfOffline();
            if (!isMountedRef.current) return;

            const hasSession = () => Boolean(oxyServices?.getAccessToken());
            let sessionReady = isAuthenticated || hasSession();

            if (!sessionReady && !offline && syncIdentity) {
              try {
                await syncIdentity();
                sessionReady = hasSession();
              } catch (syncErr: unknown) {
                const syncErrorMessage = extractAuthErrorMessage(syncErr);
                setAuthError(syncErrorMessage);
                setCreateError(syncErrorMessage);
                return;
              }
            }

            if (!sessionReady && !offline) {
              const syncErrorMessage = t('auth.errors.identityExistsSyncFailed');
              setAuthError(syncErrorMessage);
              setCreateError(syncErrorMessage);
              return;
            }

            router.replace('/(auth)/create-identity/username');
            return;
          }

          // Any other failure: log it and surface to the user. The
          // identity may or may not exist locally; the `useEffect` integrity
          // check in `useIdentity` will catch it on the next mount.
          console.error('[CreateIdentityScreen] createIdentity failed', err);
          const errorMessage = extractAuthErrorMessage(err);
          setAuthError(errorMessage);
          setCreatingProgress(0);
          // Surface the failure in the UI (with a Retry) instead of leaving the
          // user on an endless loading screen.
          setCreateError(errorMessage);
        }
      };
      create();
    }

    return cleanupTimers;
  }, [
    status,
    hasIdentity,
    createIdentity,
    syncIdentity,
    isAuthenticated,
    oxyServices,
    router,
    setAuthError,
    cleanupTimers,
    recoveryPhraseRef,
    retryNonce,
    t,
  ]);

  // Render a neutral backdrop (not the "generating keys" copy) while the status
  // is still resolving OR while the effect above is redirecting a
  // recovery/unavailable state off this screen — the create flow must never
  // appear for a lost or unreadable identity.
  if (status === 'checking' || status === 'recovery' || status === 'unavailable') {
    return <View style={{ flex: 1, backgroundColor }} />;
  }

  // Resume path (identity already exists) is a SYNC, not key generation —
  // show the accurate copy so we never claim to be "generating" existing keys.
  const isResuming = hasIdentity && status === 'in_progress';

  return (
    <CreatingStep
      progress={creatingProgress}
      isSyncing={isResuming}
      backgroundColor={backgroundColor}
      textColor={textColor}
      error={createError}
      onRetry={handleRetry}
    />
  );
}

