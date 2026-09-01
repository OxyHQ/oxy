import { useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import type { OxyServices, User } from '@oxyhq/core';
import { KeyManager, logger } from '@oxyhq/core';
import { useAuthStore, useUpdateProfile } from '@oxyhq/services';
import { requestNotificationPermission } from '@oxyhq/services/notifications';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { isNetworkOrTimeoutError, extractAuthErrorMessage, handleAuthError } from '@/utils/auth/errorUtils';
import { registerVaultPushToken } from '@/lib/notifications/push-registration';
import { STORE_UPDATE_DELAY_MS } from '@/constants/auth';
import { useTranslation } from '@/lib/i18n';

/**
 * Check if running in Expo Go
 * 
 * Push notifications are not available in Expo Go (SDK 53+),
 * so we skip notification permission requests in this environment
 */
const isExpoGo = (): boolean => {
  try {
    return Constants.executionEnvironment === 'storeClient';
  } catch {
    return false;
  }
};

interface UseAuthHandlersOptions {
  /** The session sign-in function from `useOxy()`. */
  signIn: (publicKey: string, deviceName?: string) => Promise<User>;
  oxyServices: OxyServices | null;
  usernameRef: React.MutableRefObject<string>;
  setAuthError: (error: string | null) => void;
  setSigningIn: (signingIn: boolean) => void;
  isAuthenticated: boolean;
}

/**
 * Hook for shared authentication handlers (sign in, notifications)
 * 
 * Provides reusable handlers for sign-in and notification permission requests
 * that are shared between create-identity and import-identity flows
 * 
 * @param options - Configuration options
 * @returns Handlers and state for authentication flow
 */
export function useAuthHandlers({
  signIn,
  oxyServices,
  usernameRef,
  setAuthError,
  setSigningIn,
  isAuthenticated,
}: UseAuthHandlersOptions) {
  const router = useRouter();
  const { t } = useTranslation();
  const updateProfile = useUpdateProfile();
  const [isRequestingNotifications, setIsRequestingNotifications] = useState(false);
  
  // Constants for retry logic
  const SIGN_IN_RETRY_DELAY_MS = 500;
  const MAX_SIGN_IN_RETRIES = 1;
  const AUTH_STATE_CHECK_INTERVAL_MS = 100;
  const MAX_AUTH_STATE_WAIT_MS = 3000;

  /**
   * Wait for authentication state to be confirmed
   * 
   * Polls the auth store to ensure isAuthenticated is true before proceeding
   * This ensures the auth state is fully propagated before navigation
   * 
   * Note: Always polls the store directly to get the latest state, even if
   * the prop suggests authentication status
   */
  const waitForAuthState = useCallback(async (): Promise<boolean> => {
    // Check initial state from store
    const initialAuthState = useAuthStore.getState();
    if (initialAuthState.isAuthenticated) {
      return true;
    }

    // Poll auth store for authentication state
    const startTime = Date.now();
    return new Promise<boolean>((resolve) => {
      const checkAuth = () => {
        const authState = useAuthStore.getState();
        if (authState.isAuthenticated) {
          resolve(true);
          return;
        }

        // Timeout after max wait time
        if (Date.now() - startTime >= MAX_AUTH_STATE_WAIT_MS) {
          // Even if timeout, resolve true to allow navigation
          // Offline sign-in might not immediately update isAuthenticated
          // but sign-in was successful, so we proceed
          resolve(true);
          return;
        }

        // Check again after interval
        setTimeout(checkAuth, AUTH_STATE_CHECK_INTERVAL_MS);
      };

      checkAuth();
    });
  }, []);

  /**
   * Handle sign-in with retry logic and username update
   * 
   * Signs in the user with retry logic for network errors:
   * - Retries once if network error occurs
   * - Updates profile with username if online
   * - Waits for auth state to be confirmed before navigation
   * 
   * Updates the auth store and navigates to home screen on success
   */
  const completeSignIn = useCallback(async (options?: { navigateOnSuccess?: boolean }): Promise<boolean> => {
    setSigningIn(true);
    setAuthError(null);

    let lastError: unknown = null;
    let signInSuccess = false;

    // The session sign-in requires the device's public key as the identity
    // credential; resolve it from the local KeyManager before authenticating.
    // `getPublicKey()` now THROWS `IdentityUnavailableError` when storage is
    // locked/unreadable (as opposed to returning `null` for a genuine absence) —
    // catch it so a momentarily-locked keystore surfaces a retriable error
    // rather than the misleading "No identity found on this device".
    let publicKey: string | null;
    try {
      publicKey = await KeyManager.getPublicKey();
    } catch (error: unknown) {
      setAuthError(extractAuthErrorMessage(error, t('auth.errors.couldNotReadIdentity')));
      setSigningIn(false);
      return false;
    }
    if (!publicKey) {
      setAuthError(t('auth.errors.noIdentityFound'));
      setSigningIn(false);
      return false;
    }

    // Retry logic for sign-in
    for (let attempt = 0; attempt <= MAX_SIGN_IN_RETRIES; attempt++) {
      try {
        await signIn(publicKey);
        signInSuccess = true;
        break;
      } catch (err: unknown) {
        lastError = err;
        const isNetworkError = isNetworkOrTimeoutError(err);

        // If network error and we have retries left, wait and retry
        if (isNetworkError && attempt < MAX_SIGN_IN_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, SIGN_IN_RETRY_DELAY_MS));
          continue;
        }

        // If not a network error or no retries left, throw
        if (!isNetworkError) {
          throw err;
        }
      }
    }

    // If connecting the identity failed after retries, show error
    if (!signInSuccess) {
      setAuthError(extractAuthErrorMessage(lastError, "Couldn't connect your identity. Please try again."));
      setSigningIn(false);
      return false;
    }

    // Wait for auth state to be confirmed
    await waitForAuthState();

    // Now that we're authenticated, update profile with username if online
    const usernameToSave = usernameRef.current;
    if (usernameToSave && oxyServices) {
      try {
        const offline = await checkIfOffline();
        if (!offline) {
          await updateProfile.mutateAsync({ username: usernameToSave });
        }
      } catch (err: unknown) {
        // Log but don't block - username can be set later
        if (!isNetworkOrTimeoutError(err)) {
          handleAuthError(err, 'updateProfile');
        }
      }
    }

    // Small delay to ensure auth state is fully propagated
    await new Promise(resolve => setTimeout(resolve, STORE_UPDATE_DELAY_MS));

    // Clear all auth flow state BEFORE navigation to prevent overlay/opacity issues
    setAuthError(null);
    setSigningIn(false);
    
    // Use requestAnimationFrame to ensure state updates are applied before navigation
    await new Promise(resolve => requestAnimationFrame(resolve));

    if (options?.navigateOnSuccess !== false) {
      // Navigate to the post-auth tab shell - use push as per Expo Router standard
      router.push('/(tabs)/(id)');
    }

    return true;
  }, [router, signIn, oxyServices, usernameRef, setAuthError, setSigningIn, waitForAuthState, updateProfile, t]);

  const handleSignIn = useCallback(async () => {
    await completeSignIn({ navigateOnSuccess: true });
  }, [completeSignIn]);

  /**
   * Handle the notification permission request and complete onboarding.
   * The user is authenticated by this point (we sign in first if not).
   *
   * This is the ONE place Commons prompts for notifications, and it is also
   * where a fresh grant is turned into a real push registration: without a
   * registered Expo push token the platform cannot wake this vault, so
   * "Continue with Oxy" on a desktop would have no way to reach the phone
   * (issue #691, Phase 4). The root-level `usePushRegistration` re-checks on
   * every later cold boot — it never prompts, so the user is never asked twice.
   */
  const handleRequestNotifications = useCallback(async () => {
    if (!isAuthenticated) {
      const signedIn = await completeSignIn({ navigateOnSuccess: false });
      if (!signedIn || !useAuthStore.getState().isAuthenticated) {
        return;
      }
    }

    // Push notifications don't exist in Expo Go (SDK 53+) — skip straight to
    // the vault rather than prompting for a permission that buys nothing.
    if (isExpoGo()) {
      router.push('/(tabs)/(id)');
      return;
    }

    setIsRequestingNotifications(true);
    setAuthError(null);
    try {
      // The SDK adapter shows the system dialog AT MOST once per installation:
      // an already-granted permission resolves true without a second dialog,
      // and a denial the OS will no longer let us re-ask about (`canAskAgain:
      // false`) resolves false without issuing a request the OS would ignore.
      // Either way a resumed onboarding never re-prompts.
      const granted = await requestNotificationPermission();
      if (granted && oxyServices) {
        // Fire-and-forget: a failed registration costs the user the push
        // convenience, never their onboarding. The QR handoff still works.
        void registerVaultPushToken(oxyServices, {
          name: t('signInApproval.channel.name'),
          description: t('signInApproval.channel.description'),
        }).catch((error: unknown) => {
          logger.warn(
            '[commons] onboarding push token registration failed',
            { component: 'useAuthHandlers' },
            error,
          );
        });
      }
    } finally {
      setIsRequestingNotifications(false);
    }

    router.push('/(tabs)/(id)');
  }, [isAuthenticated, router, setAuthError, completeSignIn, oxyServices]);

  return {
    handleSignIn,
    handleRequestNotifications,
    isRequestingNotifications,
  };
}

