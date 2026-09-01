/**
 * Unified Auth Hook
 *
 * Provides a clean, standard interface for authentication across all platforms.
 * This is the recommended way to access auth state in Oxy apps.
 *
 * Usage:
 * ```tsx
 * import { useAuth } from '@oxyhq/services';
 *
 * function MyComponent() {
 *   const { user, isAuthenticated, isLoading, signIn, signOut } = useAuth();
 *
 *   if (isLoading) return <Loading />;
 *   if (!isAuthenticated) return <SignInButton onClick={() => signIn()} />;
 *   return <Welcome user={user} />;
 * }
 * ```
 *
 * Session restore (zero cookies):
 * - Web: this origin's own persisted `{deviceId, deviceSecret}` — a signed-out
 *   origin stays signed out until the user presses "Continue with Oxy". There is
 *   no cross-origin silent SSO: the SDK never navigates the tab on its own.
 * - Native: shared Keychain / app-group identity (Commons)
 * - Realtime sync: Socket.IO `session_state` on `device:<deviceId>` once authenticated
 * - Manual sign-in: signIn() opens the in-app account dialog (web + native)
 */

import { useCallback } from 'react';
import { useOxy } from '../context/OxyContext';
import type { User } from '@oxyhq/core';
import { isWebBrowser } from '../utils/isWebBrowser';

export interface AuthState {
  /** Current authenticated user, null if not authenticated */
  user: User | null;

  /** Whether user is authenticated */
  isAuthenticated: boolean;

  /** Whether auth state is being determined (initial load) */
  isLoading: boolean;

  /** Whether the auth token is ready for API calls */
  isReady: boolean;

  /** Whether the current OxyServices instance currently holds an access token */
  hasAccessToken: boolean;

  /**
   * True only when auth cold-boot is resolved, the user is authenticated, and a
   * bearer token is available for private backend requests.
   */
  canUsePrivateApi: boolean;

  /**
   * True while the SDK is still resolving auth or an authenticated session is
   * waiting for its bearer token. Use this to hold private API screens in a
   * loading state instead of firing unauthenticated requests.
   */
  isPrivateApiPending: boolean;

  /**
   * Whether the initial auth determination has concluded.
   *
   * `false` from mount until the first cold-boot session restore finishes;
   * while `false`, `isAuthenticated: false` is UNDETERMINED (not a definitive
   * "logged out"). Flips to `true` once — when a session is committed or none
   * is found — and never reverts. Defer the first auth-dependent fetch until
   * this is `true` so a cold-boot reload with an existing session does not load
   * anonymous data.
   */
  isAuthResolved: boolean;

  /** Current error message, if any */
  error: string | null;
}

export interface AuthActions {
  /**
   * Sign in
   * - Web + native: opens the in-app Oxy account dialog (`openAccountDialog('signin')`).
   *   Never navigates to auth.oxy.so — that origin is third-party OAuth only.
   *
   * @param publicKey - Native: identity public key. Ignored on web.
   */
  signIn: (publicKey?: string) => Promise<User>;

  /**
   * Sign out current session
   */
  signOut: () => Promise<void>;

  /**
   * Sign out all sessions across all devices
   */
  signOutAll: () => Promise<void>;

  /**
   * Refresh auth state (re-check session validity)
   */
  refresh: () => Promise<void>;
}

export interface UseAuthReturn extends AuthState, AuthActions {
  /** Access to full OxyServices instance for advanced usage */
  oxyServices: ReturnType<typeof useOxy>['oxyServices'];
  /** Switch the device session to another account on this device */
  switchToAccount: ReturnType<typeof useOxy>['switchToAccount'];
  /** Open a bottom sheet screen (e.g. 'ManageAccount', 'FileManagement') */
  showBottomSheet: ReturnType<typeof useOxy>['showBottomSheet'];
  /** Open the avatar picker bottom sheet */
  openAvatarPicker: ReturnType<typeof useOxy>['openAvatarPicker'];
}

/**
 * Unified auth hook for all Oxy apps
 *
 * Features:
 * - Zero config: Just wrap with OxyProvider and use
 * - Cross-platform: Same API on native and web
 * - Auto session restore: device-first cold boot (`deviceId` + `deviceSecret` mint);
 *   never auto-redirects to the IdP
 * - Type-safe: Full TypeScript support
 */
export function useAuth(): UseAuthReturn {
  const {
    user,
    isAuthenticated,
    isLoading,
    isTokenReady,
    hasAccessToken,
    canUsePrivateApi,
    isPrivateApiPending,
    isAuthResolved,
    error,
    signIn: oxySignIn,
    logout,
    logoutAll,
    refreshSessions,
    oxyServices,
    switchToAccount,
    hasIdentity,
    getPublicKey,
    showBottomSheet,
    openAvatarPicker,
    openAccountDialog,
  } = useOxy();

  const signIn = useCallback(async (publicKey?: string): Promise<User> => {
    // Native: sign in directly with the cryptographic identity when a public key
    // is provided, or an existing keychain identity is found.
    if (publicKey) {
      return oxySignIn(publicKey);
    }
    if (!isWebBrowser()) {
      const hasExisting = await hasIdentity();
      if (hasExisting) {
        const existingKey = await getPublicKey();
        if (existingKey) {
          return oxySignIn(existingKey);
        }
      }
    }

    // Web, or native without a keychain identity: open the unified account dialog
    // on its sign-in view (device flow / QR / password hand-off). There is NO
    // automatic navigation to a login page — the device-first cold boot already
    // restored a session if one existed. The caller reacts to `isAuthenticated`,
    // so this promise intentionally never resolves.
    openAccountDialog('signin');
    return new Promise<User>(() => undefined);
  }, [oxySignIn, hasIdentity, getPublicKey, openAccountDialog]);

  const signOut = useCallback(async (): Promise<void> => {
    await logout();
  }, [logout]);

  const signOutAll = useCallback(async (): Promise<void> => {
    await logoutAll();
  }, [logoutAll]);

  const refresh = useCallback(async (): Promise<void> => {
    await refreshSessions();
  }, [refreshSessions]);

  return {
    // State
    user,
    isAuthenticated,
    isLoading: isLoading || !isAuthResolved,
    isReady: isTokenReady,
    hasAccessToken,
    canUsePrivateApi,
    isPrivateApiPending,
    isAuthResolved,
    error,

    // Actions
    signIn,
    signOut,
    signOutAll,
    refresh,

    // Advanced
    oxyServices,
    switchToAccount,
    showBottomSheet,
    openAvatarPicker,
  };
}
