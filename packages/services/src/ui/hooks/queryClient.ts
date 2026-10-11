/**
 * Offline-first QueryClient with cross-restart persistence.
 *
 * Wires together:
 * - TanStack Query with `networkMode: 'offlineFirst'` for queries and mutations
 *   so cached data is served immediately and mutations are queued (paused) while
 *   the browser/device reports offline.
 * - `attachQueryPersistence(...)` so that query results AND paused mutations
 *   survive a cold restart (kill-and-relaunch); see `persistedQueryCache.ts`.
 * - `onlineManager` resume hook so paused mutations replay the moment the
 *   network is reported back, even if the host app swapped in a custom
 *   onlineManager implementation.
 *
 * Storage layer: the platform `StorageInterface` (AsyncStorage on native,
 * localStorage on web).
 *
 * Whitelist policy:
 * - Persist every account/user/session/privacy query and every queued mutation.
 * - DO NOT persist large list queries (e.g. activity feeds) — they go stale
 *   fast and would balloon storage. Add new keys to `PERSISTED_QUERY_PREFIXES`
 *   (`persistedQueryCache.ts`) when introducing reads that should survive restart.
 */

import { QueryClient, onlineManager, type Mutation, type Query } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { isDev } from '@oxy.so/core';
import type { StorageInterface } from '../utils/storageHelpers';
import { accountQueryOwnership, type AccountQueriesConfig } from './accountQueryPersistence';
import {
  PERSISTED_QUERY_PREFIXES,
  hydrateSnapshot,
  subscribeSnapshots,
} from './persistedQueryCache';

const QUERY_CACHE_KEY = 'oxy_query_cache_v3';
const QUERY_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const QUERY_PERSIST_THROTTLE_MS = 1_000;
const MAX_QUERY_RETRIES = 2;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value =
    (error as { status?: unknown; response?: { status?: unknown } }).status ??
    (error as { response?: { status?: unknown } }).response?.status;
  return typeof value === 'number' ? value : null;
}

/** Retry only failures that another attempt can plausibly change. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  const status = statusOf(error);
  if (status === null) return true; // transport error without an HTTP response
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Whether a query belongs in the account-agnostic cache: successful (a
 * `pending`/`error` state is not worth keeping, and an error would leak
 * failure objects across restarts) and under one of the SDK's own prefixes.
 */
function isSharedQuery(query: Query): boolean {
  if (query.state.status !== 'success') {
    return false;
  }
  const head = query.queryKey[0];
  return typeof head === 'string' && PERSISTED_QUERY_PREFIXES.includes(head);
}

/**
 * Create a QueryClient with offline-first defaults.
 *
 * Mutations marked with `networkMode: 'offlineFirst'` are queued by TanStack
 * Query when offline (status "paused") and resumed automatically when
 * `onlineManager` transitions back to online. Network monitoring wiring lives
 * in `OxyProvider.tsx`.
 *
 * Persistence is attached separately via `attachQueryPersistence(...)`.
 * Splitting the steps lets test/SSR callers create a stateless client.
 */
export const createQueryClient = (): QueryClient => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Data is fresh for 5 minutes
        staleTime: 5 * 60 * 1000,
        // Keep unused data in cache for 30 minutes
        gcTime: 30 * 60 * 1000,
        retry: shouldRetryQuery,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        // Refetch on reconnect so stale data is refreshed once online again.
        refetchOnReconnect: true,
        // Don't refetch on window focus (better for mobile)
        refetchOnWindowFocus: false,
        // Offline-first: serve cached data immediately, refetch in background.
        networkMode: 'offlineFirst',
      },
      mutations: {
        // A generic mutation has no proof of idempotency. Individual mutation
        // definitions may opt into retry only when they carry such a proof.
        retry: false,
        // Offline-first: pause and queue mutations when offline.
        networkMode: 'offlineFirst',
      },
    },
  });

  // Defensive: explicitly resume paused mutations whenever the network
  // transitions back to online. TanStack Query does this internally too,
  // but wiring it here keeps the behaviour robust if a custom onlineManager
  // implementation is swapped in by the host app.
  const unsubscribe = onlineManager.subscribe((isOnline) => {
    if (isOnline) {
      void client.getMutationCache().resumePausedMutations();
    }
  });

  Object.defineProperty(client, '__oxyOnlineUnsubscribe', {
    value: unsubscribe,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return client;
};

export interface AttachPersistenceResult {
  /** Promise that resolves once the persisted cache has been restored. */
  restored: Promise<void>;
  /** Detach the persistence subscription (tests + teardown). */
  unsubscribe: () => void;
}

/**
 * Restore, then keep writing, the account-agnostic cache.
 *
 * Queries written by another build are dropped; queued mutations are kept
 * (`persistedQueryCache.ts`). Whatever the app declared account-scoped
 * (`accountQueries`) is left to `createAccountQueryPersistence`, even under
 * one of the SDK's prefixes, so private rows never land in the shared blob and
 * a paused mutation cannot replay twice or under another account.
 *
 * Safe to no-op if `storage` is null/undefined (e.g. server-side render
 * with no host storage).
 */
export const attachQueryPersistence = (
  queryClient: QueryClient,
  storage: StorageInterface | null | undefined,
  accountQueries?: AccountQueriesConfig,
): AttachPersistenceResult => {
  if (!storage) {
    return {
      restored: Promise.resolve(),
      unsubscribe: () => {},
    };
  }

  const account = accountQueries ? accountQueryOwnership(accountQueries) : null;
  const filters = {
    shouldDehydrateQuery: (query: Query) =>
      isSharedQuery(query) && !(account?.ownsQuery(query) ?? false),
    // Every other mutation, whatever its status: paused ones are exactly the
    // ones that must survive a restart to replay when online.
    shouldDehydrateMutation: (mutation: Mutation) => !(account?.ownsMutation(mutation) ?? false),
  };

  let stopped = false;
  let writer: ReturnType<typeof subscribeSnapshots> | null = null;
  const restored = (async () => {
    const raw = await storage.getItem(QUERY_CACHE_KEY);
    if (stopped) return;
    if (!hydrateSnapshot(queryClient, raw, QUERY_CACHE_MAX_AGE) && raw) {
      await storage.removeItem(QUERY_CACHE_KEY);
    }
  })()
    .catch((error) => {
      if (isDev()) {
        console.warn('[QueryClient] Failed to restore persisted cache', error);
      }
    })
    .then(() => {
      if (stopped) return;
      writer = subscribeSnapshots(queryClient, filters, QUERY_PERSIST_THROTTLE_MS, (serialized) => {
        void Promise.resolve(storage.setItem(QUERY_CACHE_KEY, serialized)).catch(() => undefined);
      });
    });

  return {
    restored,
    unsubscribe: () => {
      stopped = true;
      writer?.unsubscribe();
    },
  };
};

/**
 * Remove the persisted query+mutation cache (used on full sign-out / data reset).
 * Safe to call even if persistence was never attached.
 */
export const clearQueryCache = async (storage: StorageInterface): Promise<void> => {
  try {
    await storage.removeItem(QUERY_CACHE_KEY);
  } catch (error) {
    if (isDev()) {
      console.warn('[QueryClient] Failed to clear persisted query cache', error);
    }
  }
};

/**
 * Re-export the persisted client shape so callers can type custom persisters.
 */
export type { PersistedClient };
