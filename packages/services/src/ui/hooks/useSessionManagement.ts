import { useCallback, useRef } from 'react';
import { isDev, type ApiError, type User } from '@oxy.so/core';
import type { ClientSession } from '@oxy.so/core';
import { fetchSessionsWithFallback } from '../utils/sessionHelpers';
import type { StorageInterface } from '../utils/storageHelpers';
import { handleAuthError, isInvalidSessionError } from '../utils/errorHandlers';
import type { OxyServices } from '@oxy.so/core';
import { isSessionChangedError } from '../utils/sessionChangedError';
import { clearQueryCache } from './queryClient';
import { isWebBrowser } from '../utils/isWebBrowser';
import type { OxyRuntime } from '../runtime';

export interface UseSessionManagementOptions {
  oxyServices: OxyServices;
  /** The one owner of `sessions` / `activeSessionId` / the signed-in account. */
  runtime: OxyRuntime;
  storage: StorageInterface | null;
  /** Unused: nothing here is stored under a key any more. */
  storageKeyPrefix?: string;
  onAuthStateChange?: (user: User | null) => void;
  onError?: (error: ApiError) => void;
  setAuthError?: (message: string | null) => void;
  logger?: (message: string, error?: unknown) => void;
  /** The provider's query cache, emptied when the local session is torn down. */
  queryClient?: { clear(): void } | null;
}

export interface UseSessionManagementResult {
  /**
   * The runtime's session-id projection sink. It stores nothing: the ids it
   * wrote (`<prefix>_session_ids`) had no reader, and the device storage
   * deletes the old values. `OxyContext` still wires it.
   */
  saveSessionIds: (sessionIds: string[]) => void;
  /**
   * Stores nothing, for the same reason (`<prefix>_active_session_id` had no
   * reader). `useAuthOperations` still calls it.
   */
  saveActiveSessionId: (sessionId: string) => Promise<void>;
  /**
   * The legacy `validateSession`-keyed switch. Reachable from exactly ONE
   * caller: `performSignIn`'s same-user duplicate-session dedup. The switch a
   * consumer sees on the context is the `SessionClient` one in `OxyContext`.
   */
  switchSession: (sessionId: string) => Promise<User>;
  /** Tear down the local session: runtime projection, caches, tokens. */
  clearSessionState: () => Promise<void>;
}

const saveSessionIds = (_sessionIds: string[]): void => undefined;
const saveActiveSessionId = async (_sessionId: string): Promise<void> => undefined;

/**
 * Session teardown and the one legacy switch left, over the runtime.
 *
 * This hook used to hold its OWN `sessions` / `activeSessionId` React state
 * plus six refs mirroring them so its callbacks could avoid widening their
 * dependency arrays. That made it a second owner of facts `SessionClient`
 * already had, reconciled only by whichever `useEffect` ran last. Both are gone:
 * the runtime owns them, this hook writes through it, and the refs mirrored
 * nothing once there was nothing local to mirror.
 *
 * `refreshSessions`, `trackRemovedSession` and `isRefreshInFlight` are deleted
 * outright — every one of them was dropped unread at the single call site. The
 * session ids and the active session id it stored are gone too: nothing read
 * them.
 */
export const useSessionManagement = ({
  oxyServices,
  runtime,
  storage,
  onAuthStateChange,
  onError,
  setAuthError,
  logger,
  queryClient,
}: UseSessionManagementOptions): UseSessionManagementResult => {
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const clearSessionState = useCallback(async (): Promise<void> => {
    runtimeRef.current.clearSession();

    // Clear the access token on the client instance. Without this the token
    // store retained the stale bearer until the next 401, leaving the instance
    // "logged in" at the HTTP layer and — via the provider's token mirror —
    // leaking that stale token onto the shared `oxyClient` singleton after
    // sign-out. Clearing here fires `onTokensChanged(null)`, propagating the
    // logged-out state everywhere.
    oxyServices.session.clear();

    if (queryClient) {
      queryClient.clear();
    }

    if (storage) {
      try {
        await clearQueryCache(storage);
      } catch (error) {
        if (logger) {
          logger('Failed to clear persisted query cache', error);
        }
      }
    }

    onAuthStateChange?.(null);
  }, [onAuthStateChange, oxyServices, queryClient, storage, logger]);

  const switchSession = useCallback(
    async (sessionId: string): Promise<User> => {
      try {
        // On web the bearer must already be in memory (planted by
        // `claimSessionByToken`, a cold-boot restore step, or a prior
        // `SessionClient` sync) before validating — there is no client-side
        // refresh-cookie slot to fall back on. The native path arrives here only
        // after a bearer has been planted too.
        if (isWebBrowser() && !oxyServices.session.accessToken) {
          throw new Error('Session is invalid or expired');
        }

        const validation = await oxyServices.session.validate(sessionId, {
          useHeaderValidation: true,
        });
        if (!validation?.valid) {
          throw new Error('Session is invalid or expired');
        }
        if (!validation.user) {
          throw new Error('User data not available from session validation');
        }

        const user = validation.user as User;
        const activeRuntime = runtimeRef.current;
        activeRuntime.batch(() => {
          activeRuntime.setTokenReady(true);
          activeRuntime.setActiveSessionId(sessionId);
          activeRuntime.setAccount(user);
        });
        onAuthStateChange?.(user);

        try {
          const deviceSessions = await fetchSessionsWithFallback(oxyServices, sessionId, {
            fallbackUserId: user.id,
            logger,
          });
          activeRuntime.mergeSessions(deviceSessions, { merge: true });
        } catch (error) {
          if (isSessionChangedError(error)) throw error;
          if (isDev()) {
            console.warn('Failed to synchronize sessions after switch:', error);
          }
        }

        return user;
      } catch (error) {
        if (isSessionChangedError(error)) throw error;
        const invalidSession = isInvalidSessionError(error);

        if (invalidSession) {
          // Server authority (`SessionClient` bootstrap/sync) reconciles which
          // account is actually active — just drop the invalid session from the
          // local view rather than guessing at a replacement.
          const remaining: ClientSession[] = runtimeRef.current
            .getSnapshot()
            .sessions.filter((session) => session.sessionId !== sessionId);
          runtimeRef.current.mergeSessions(remaining, { merge: false });
        }

        handleAuthError(error, {
          defaultMessage: 'Failed to switch session',
          code: invalidSession ? 'INVALID_SESSION' : 'SESSION_SWITCH_ERROR',
          onError,
          setAuthError,
          logger,
        });
        throw error instanceof Error ? error : new Error('Failed to switch session');
      }
    },
    [logger, onAuthStateChange, onError, oxyServices, setAuthError],
  );

  return {
    saveSessionIds,
    saveActiveSessionId,
    switchSession,
    clearSessionState,
  };
};
