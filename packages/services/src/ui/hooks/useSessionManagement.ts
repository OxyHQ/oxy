import { useCallback, useMemo, useRef } from 'react';
import { isDev, type ApiError, type User } from '@oxyhq/core';
import type { ClientSession } from '@oxyhq/core';
import { fetchSessionsWithFallback } from '../utils/sessionHelpers';
import { getStorageKeys, type StorageInterface } from '../utils/storageHelpers';
import { handleAuthError, isInvalidSessionError } from '../utils/errorHandlers';
import type { OxyServices } from '@oxyhq/core';
import type { QueryClient } from '@tanstack/react-query';
import { clearQueryCache } from './queryClient';
import { isWebBrowser } from '../utils/isWebBrowser';
import { resetSessionScopedStores } from '../stores/resetSessionScopedStores';
import type { OxyRuntime } from '../runtime';

export interface UseSessionManagementOptions {
  oxyServices: OxyServices;
  /** The one owner of `sessions` / `activeSessionId` / the signed-in account. */
  runtime: OxyRuntime;
  storage: StorageInterface | null;
  storageKeyPrefix?: string;
  onAuthStateChange?: (user: User | null) => void;
  onError?: (error: ApiError) => void;
  setAuthError?: (message: string | null) => void;
  logger?: (message: string, error?: unknown) => void;
  queryClient?: QueryClient | null;
}

export interface UseSessionManagementResult {
  /** Persist the projected session-id list. Handed to the runtime as its projection sink. */
  saveSessionIds: (sessionIds: string[]) => void;
  saveActiveSessionId: (sessionId: string) => Promise<void>;
  /**
   * The legacy `validateSession`-keyed switch. Reachable from exactly ONE
   * caller: `performSignIn`'s same-user duplicate-session dedup. The switch a
   * consumer sees on the context is the `SessionClient` one in `OxyContext`.
   */
  switchSession: (sessionId: string) => Promise<User>;
  /** Tear down the local session: runtime projection, caches, storage, tokens. */
  clearSessionState: () => Promise<void>;
  storageKeys: ReturnType<typeof getStorageKeys>;
}

const DEFAULT_SAVE_ERROR_MESSAGE = 'Failed to save session data';
const CLEAR_STORAGE_ERROR = 'Failed to clear storage';

/**
 * Session persistence and the one legacy switch left, over the runtime.
 *
 * This hook used to hold its OWN `sessions` / `activeSessionId` React state
 * plus six refs mirroring them so its callbacks could avoid widening their
 * dependency arrays. That made it a second owner of facts `SessionClient`
 * already had, reconciled only by whichever `useEffect` ran last. Both are gone:
 * the runtime owns them, this hook writes through it, and the refs mirrored
 * nothing once there was nothing local to mirror.
 *
 * `refreshSessions`, `trackRemovedSession` and `isRefreshInFlight` are deleted
 * outright — every one of them was dropped unread at the single call site.
 */
export const useSessionManagement = ({
  oxyServices,
  runtime,
  storage,
  storageKeyPrefix,
  onAuthStateChange,
  onError,
  setAuthError,
  logger,
  queryClient,
}: UseSessionManagementOptions): UseSessionManagementResult => {
  const storageKeys = useMemo(() => getStorageKeys(storageKeyPrefix), [storageKeyPrefix]);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const saveSessionIds = useCallback(
    (sessionIds: string[]): void => {
      if (!storage) return;
      const uniqueIds = Array.from(new Set(sessionIds));
      storage.setItem(storageKeys.sessionIds, JSON.stringify(uniqueIds)).catch((error: unknown) => {
        if (logger) {
          logger(DEFAULT_SAVE_ERROR_MESSAGE, error);
        } else if (isDev()) {
          console.warn('Failed to save session IDs:', error);
        }
      });
    },
    [logger, storage, storageKeys.sessionIds],
  );

  const saveActiveSessionId = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!storage) return;
      try {
        await storage.setItem(storageKeys.activeSessionId, sessionId);
      } catch (error) {
        handleAuthError(error, {
          defaultMessage: DEFAULT_SAVE_ERROR_MESSAGE,
          code: 'SESSION_PERSISTENCE_ERROR',
          onError,
          setAuthError,
          logger,
        });
      }
    },
    [logger, onError, setAuthError, storage, storageKeys.activeSessionId],
  );

  const clearSessionStorage = useCallback(async (): Promise<void> => {
    if (!storage) return;
    try {
      await storage.removeItem(storageKeys.activeSessionId);
      await storage.removeItem(storageKeys.sessionIds);
    } catch (error) {
      handleAuthError(error, {
        defaultMessage: CLEAR_STORAGE_ERROR,
        code: 'STORAGE_ERROR',
        onError,
        setAuthError,
        logger,
      });
    }
  }, [logger, onError, setAuthError, storage, storageKeys.activeSessionId, storageKeys.sessionIds]);

  const clearSessionState = useCallback(async (): Promise<void> => {
    runtimeRef.current.clearSession();
    resetSessionScopedStores();

    // Clear the access token on the client instance. Without this the token
    // store retained the stale bearer until the next 401, leaving the instance
    // "logged in" at the HTTP layer and — via the provider's token mirror —
    // leaking that stale token onto the shared `oxyClient` singleton after
    // sign-out. Clearing here fires `onTokensChanged(null)`, propagating the
    // logged-out state everywhere.
    oxyServices.clearTokens();

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

    await clearSessionStorage();
    onAuthStateChange?.(null);
  }, [clearSessionStorage, onAuthStateChange, oxyServices, queryClient, storage, logger]);

  const switchSession = useCallback(
    async (sessionId: string): Promise<User> => {
      try {
        // On web the bearer must already be in memory (planted by
        // `claimSessionByToken`, a cold-boot restore step, or a prior
        // `SessionClient` sync) before validating — there is no client-side
        // refresh-cookie slot to fall back on. The native path arrives here only
        // after a bearer has been planted too.
        if (isWebBrowser() && !oxyServices.getAccessToken()) {
          throw new Error('Session is invalid or expired');
        }

        const validation = await oxyServices.validateSession(sessionId, { useHeaderValidation: true });
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
        await saveActiveSessionId(sessionId);
        onAuthStateChange?.(user);

        try {
          const deviceSessions = await fetchSessionsWithFallback(oxyServices, sessionId, {
            fallbackUserId: user.id,
            logger,
          });
          activeRuntime.mergeSessions(deviceSessions, { merge: true });
        } catch (error) {
          if (isDev()) {
            console.warn('Failed to synchronize sessions after switch:', error);
          }
        }

        return user;
      } catch (error) {
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
    [logger, onAuthStateChange, onError, oxyServices, saveActiveSessionId, setAuthError],
  );

  return {
    saveSessionIds,
    saveActiveSessionId,
    switchSession,
    clearSessionState,
    storageKeys,
  };
};
