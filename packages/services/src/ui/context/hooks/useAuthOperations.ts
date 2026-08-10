import { useCallback } from 'react';
import type { ApiError, AuthStateStore, IdentityBinding, SessionClient, User } from '@oxyhq/core';
import type { AuthState } from '../../stores/authStore';
import type { ClientSession, SessionLoginResponse } from '@oxyhq/core';
import { DeviceManager } from '@oxyhq/core';
import { fetchSessionsWithFallback } from '../../utils/sessionHelpers';
import { handleAuthError, isInvalidSessionError } from '../../utils/errorHandlers';
import type { StorageInterface } from '../../utils/storageHelpers';
import type { OxyServices } from '@oxyhq/core';
import { SignatureService } from '@oxyhq/core';

export interface UseAuthOperationsOptions {
  oxyServices: OxyServices;
  storage: StorageInterface | null;
  /**
   * The device-first persisted auth-state store. On EXPLICIT full sign-out the
   * session blob is cleared (`store.clear()`) so a reload's cold boot finds no
   * device credential to restore; on sign-in the returned zero-cookie device
   * credential (`deviceId` + `deviceSecret`) is persisted so the next boot
   * warm-restores without a redirect.
   */
  store: AuthStateStore;
  activeSessionId: string | null;
  setActiveSessionId: (sessionId: string | null) => void;
  updateSessions: (sessions: ClientSession[], options?: { merge?: boolean }) => void;
  saveActiveSessionId: (sessionId: string) => Promise<void>;
  clearSessionState: () => Promise<void>;
  /** Used only by `performSignIn`'s same-user duplicate-session dedup (legacy session-validate path; unrelated to the SessionClient device-account set). */
  switchSession: (sessionId: string) => Promise<User>;
  /**
   * The Fase 3-A/3-B `SessionClient` (server-authoritative device account
   * set). `logout` routes revocation through `sessionClient.signOut(...)`;
   * `logoutAll` first uses the user-wide endpoint, then removes the accounts
   * from this device through the client.
   */
  sessionClient: SessionClient;
  /** Reprojects `sessionClient.getState()` onto sessions/activeSessionId/user (Task 1's callback). Awaited after a partial `signOut` so the exposed state reflects the server truth before the call resolves. */
  syncFromClient: () => Promise<void>;
  onAuthStateChange?: (user: User | null) => void;
  onError?: (error: ApiError) => void;
  loginSuccess: (user: User) => void;
  loginFailure: (message: string) => void;
  logoutStore: () => void;
  setAuthState: (state: Partial<AuthState>) => void;
  logger?: (message: string, error?: unknown) => void;
  /**
   * Identity-bound session (`sessionMode: 'identity'`). When set, a successful
   * key sign-in writes the durable `{publicKey, accountId}` pin so pinned
   * re-mints and projections bind immediately instead of waiting for a second
   * `establishIdentitySession` round-trip.
   */
  identityBinding?: IdentityBinding;
  /** Refreshes the provider's memoised pinned account id after the pin lands. */
  refreshPinnedAccountId?: () => Promise<string | null>;
}

export interface UseAuthOperationsResult {
  /** Sign in with existing public key */
  signIn: (publicKey: string, deviceName?: string) => Promise<User>;
  /** Logout from current session */
  logout: (targetSessionId?: string) => Promise<void>;
  /** Logout from all sessions */
  logoutAll: () => Promise<void>;
}

const LOGIN_ERROR_CODE = 'LOGIN_ERROR';
const LOGOUT_ERROR_CODE = 'LOGOUT_ERROR';
const LOGOUT_ALL_ERROR_CODE = 'LOGOUT_ALL_ERROR';

/**
 * Clear the persisted device credential on an explicit full sign-out.
 * Best-effort and non-blocking: sign-out must never fail because a storage
 * write threw. Exported so `OxyContext`'s zero-account branch (a REMOTE full
 * sign-out pushed over the socket) runs the EXACT same cleanup as the local
 * `logout` / `logoutAll` paths — a remote sign-out is indistinguishable from a
 * local one to the next cold boot.
 */
export function clearPersistedAuthSafe(
  store: AuthStateStore,
  logger?: (message: string, error?: unknown) => void,
): void {
  store.clear().catch((clearError) => {
    logger?.('Failed to clear persisted auth state on sign-out', clearError);
  });
}

/**
 * Authentication operations using public key cryptography.
 * Accepts public key as parameter - identity management is handled by the app layer.
 */
export const useAuthOperations = ({
  oxyServices,
  store,
  activeSessionId,
  setActiveSessionId,
  updateSessions,
  saveActiveSessionId,
  clearSessionState,
  switchSession,
  sessionClient,
  syncFromClient,
  onAuthStateChange,
  onError,
  loginSuccess,
  loginFailure,
  logoutStore,
  setAuthState,
  logger,
  identityBinding,
  refreshPinnedAccountId,
}: UseAuthOperationsOptions): UseAuthOperationsResult => {
  /**
   * Internal function to perform challenge-response sign in.
   */
  const performSignIn = useCallback(
    async (publicKey: string): Promise<User> => {
      const deviceFingerprintObj = DeviceManager.getDeviceFingerprint();
      const deviceFingerprint = JSON.stringify(deviceFingerprintObj);
      const deviceInfo = await DeviceManager.getDeviceInfo();
      const deviceName = deviceInfo.deviceName || DeviceManager.getDefaultDeviceName();

      const challengeResponse = await oxyServices.requestChallenge(publicKey);
      const challenge = challengeResponse.challenge;

      // Note: Biometric authentication check should be handled by the app layer
      // (e.g., accounts app) before calling signIn. The biometric preference is stored
      // in local storage as 'oxy_biometric_enabled' and can be checked there.

      // Sign the challenge
      const { challenge: signature, timestamp } = await SignatureService.signChallenge(challenge);

      let fullUser: User;
      let sessionResponse: SessionLoginResponse;

      // `verifyChallenge` plants the first access token internally, mirroring
      // `claimSessionByToken`, so the client is authenticated as soon as this
      // resolves.
      sessionResponse = await oxyServices.verifyChallenge(
        publicKey,
        challenge,
        signature,
        timestamp,
        deviceName,
        deviceFingerprint,
      );

      // Persist the durable device credential so a reload warm-restores this
      // session without a redirect. `verifyChallenge` plants the access token
      // internally; when the response also carries the zero-cookie device
      // credential (`deviceId` + `deviceSecret`), persist the durable blob so the
      // next cold boot re-mints an access token from it. Best-effort — a failed
      // persist never fails the sign-in.
      const deviceSecret = sessionResponse.deviceSecret;
      if (sessionResponse.deviceId && deviceSecret) {
        try {
          await store.save({
            sessionId: sessionResponse.sessionId,
            userId: sessionResponse.user.id,
            deviceId: sessionResponse.deviceId,
            deviceSecret,
            ...(sessionResponse.accessToken ? { accessToken: sessionResponse.accessToken } : {}),
            ...(sessionResponse.expiresAt ? { expiresAt: sessionResponse.expiresAt } : {}),
          });
        } catch (persistError) {
          logger?.('Failed to persist auth state after sign-in', persistError);
        }
      }

      if (identityBinding) {
        try {
          await identityBinding.pinStore.save({
            publicKey: publicKey.toLowerCase(),
            accountId: sessionResponse.user.id,
          });
          await refreshPinnedAccountId?.();
        } catch (pinError) {
          logger?.('Failed to persist identity pin after sign-in', pinError);
        }
      }

      // Register this recovered account+session into the server-authoritative
      // device-session set AND make it active: `registerAndActivate()` adds via
      // `POST /session/device/add` (identity derived from the bearer
      // `verifyChallenge` already planted) then switches to it, and
      // `syncFromClient()` reprojects the resulting server state onto the
      // exposed sessions/activeSessionId/user. Best-effort: a failure here must
      // NEVER fail the sign-in itself — cold boot re-registers this account into
      // the device set on the next load regardless.
      try {
        await sessionClient.registerAndActivate(sessionResponse.user.id);
        await syncFromClient();
      } catch (registrationError) {
        logger?.('Failed to register sign-in into device session set', registrationError);
      }

      // Hydrate the full user from the bearer (`GET /users/me`) — `verifyChallenge`
      // has already planted the access token for this session, so the bearer IS
      // the session identity. Avoids a second, session-id-keyed source of truth
      // (`GET /session/user/:sessionId`) that can disagree with the bearer.
      fullUser = await oxyServices.getCurrentUser();

      // Fetch device sessions
      let allDeviceSessions: ClientSession[] = [];
      try {
        allDeviceSessions = await fetchSessionsWithFallback(oxyServices, sessionResponse.sessionId, {
          fallbackDeviceId: sessionResponse.deviceId,
          fallbackUserId: fullUser.id,
          logger,
        });
      } catch (error) {
        if (__DEV__ && logger) {
          logger('Failed to fetch device sessions after login', error);
        }
      }

      // Check for existing session for same user and switch to it to avoid duplicates
      const existingSession = allDeviceSessions.find(
        (session) =>
          session.userId?.toString() === fullUser.id?.toString() &&
          session.sessionId !== sessionResponse.sessionId,
      );

      if (existingSession) {
        // Switch to existing session instead of creating duplicate
        try {
          await oxyServices.logoutSession(sessionResponse.sessionId, sessionResponse.sessionId);
        } catch (logoutError) {
          // Non-critical - continue to switch session even if logout fails
          if (__DEV__ && logger) {
            logger('Failed to logout duplicate session, continuing with switch', logoutError);
          }
        }
        await switchSession(existingSession.sessionId);
        updateSessions(
          allDeviceSessions.filter((session) => session.sessionId !== sessionResponse.sessionId),
          { merge: false },
        );
        onAuthStateChange?.(fullUser);
        return fullUser;
      }

      setActiveSessionId(sessionResponse.sessionId);
      await saveActiveSessionId(sessionResponse.sessionId);
      updateSessions(allDeviceSessions, { merge: true });

      loginSuccess(fullUser);
      onAuthStateChange?.(fullUser);

      return fullUser;
    },
    [
      logger,
      loginSuccess,
      onAuthStateChange,
      oxyServices,
      saveActiveSessionId,
      sessionClient,
      setActiveSessionId,
      store,
      switchSession,
      syncFromClient,
      updateSessions,
      identityBinding,
      refreshPinnedAccountId,
    ],
  );

  /**
   * Sign in with existing public key
   */
  const signIn = useCallback(
    async (publicKey: string, deviceName?: string): Promise<User> => {
      setAuthState({ isLoading: true, error: null });

      try {
        return await performSignIn(publicKey);
      } catch (error) {
        const message = handleAuthError(error, {
          defaultMessage: 'Sign in failed',
          code: LOGIN_ERROR_CODE,
          onError,
          setAuthError: (msg: string) => setAuthState({ error: msg }),
          logger,
        });
        loginFailure(message);
        throw error;
      } finally {
        setAuthState({ isLoading: false });
      }
    },
    [setAuthState, performSignIn, loginFailure, onError, logger],
  );

  /**
   * Logout from session
   */
  const logout = useCallback(
    async (targetSessionId?: string): Promise<void> => {
      if (!activeSessionId) return;

      try {
        const sessionToLogout = targetSessionId || activeSessionId;

        // Resolve the device account backing this session from the
        // server-authoritative `SessionClient` state — SERVER revocation now
        // goes through `sessionClient.signOut(...)` instead of the
        // bearer/cookie logout endpoints.
        const targetAccountId = sessionClient
          .getState()
          ?.accounts.find((account) => account.sessionId === sessionToLogout)?.accountId;
        if (!targetAccountId) {
          throw new Error(`No device account found for session "${sessionToLogout}"`);
        }

        await sessionClient.signOut({ accountId: targetAccountId });

        // The server has already decided what (if anything) remains active on
        // this device; reproject that truth onto the exposed sessions /
        // activeSessionId / user before deciding whether additional LOCAL
        // teardown is needed.
        const remainingAccounts = sessionClient.getState()?.accounts ?? [];
        await syncFromClient();

        if (sessionToLogout === activeSessionId && remainingAccounts.length === 0) {
          // Genuine FULL sign-out (no sessions remain): clear the persisted
          // device credential so a reload's cold boot finds nothing to restore,
          // then tear down local state.
          clearPersistedAuthSafe(store, logger);
          await clearSessionState();
        }
      } catch (error) {
        const isInvalid = isInvalidSessionError(error);

        if (isInvalid && targetSessionId === activeSessionId) {
          // The active session is invalid → full sign-out; clear persisted state.
          clearPersistedAuthSafe(store, logger);
          await clearSessionState();
          return;
        }

        handleAuthError(error, {
          defaultMessage: 'Logout failed',
          code: LOGOUT_ERROR_CODE,
          onError,
          setAuthError: (msg: string) => setAuthState({ error: msg }),
          logger,
          status: isInvalid ? 401 : undefined,
        });
      }
    },
    [
      activeSessionId,
      clearSessionState,
      store,
      logger,
      onError,
      sessionClient,
      setAuthState,
      syncFromClient,
    ],
  );

  /**
   * Logout from all sessions
   */
  const logoutAll = useCallback(async (): Promise<void> => {
    if (!activeSessionId) {
      const error = new Error('No active session found');
      setAuthState({ error: error.message });
      onError?.({ message: error.message, code: LOGOUT_ALL_ERROR_CODE, status: 404 });
      throw error;
    }

    try {
      // Revoke the active account's sessions on every device before removing
      // this device's complete account set. The device-scoped sign-out alone
      // cannot satisfy signOutAll's public all-device revocation contract.
      await oxyServices.logoutAllSessions(activeSessionId);
      await sessionClient.signOut({ all: true });
      // logoutAll is ALWAYS a full sign-out: clear the persisted device
      // credential so the next cold boot finds no session to restore, then tear
      // down local state.
      clearPersistedAuthSafe(store, logger);
      await clearSessionState();
    } catch (error) {
      handleAuthError(error, {
        defaultMessage: 'Logout all failed',
        code: LOGOUT_ALL_ERROR_CODE,
        onError,
        setAuthError: (msg: string) => setAuthState({ error: msg }),
        logger,
      });
      throw error instanceof Error ? error : new Error('Logout all failed');
    }
  }, [activeSessionId, clearSessionState, store, logger, onError, oxyServices, sessionClient, setAuthState]);

  return {
    signIn,
    logout,
    logoutAll,
  };
};
