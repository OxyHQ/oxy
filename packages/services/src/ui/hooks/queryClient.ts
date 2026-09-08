/**
 * Offline-first QueryClient with cross-restart persistence.
 *
 * Wires together:
 * - TanStack Query with `networkMode: 'offlineFirst'` for queries and mutations
 *   so cached data is served immediately and mutations are queued (paused) while
 *   the browser/device reports offline.
 * - `persistQueryClient(...)` from `@tanstack/react-query-persist-client` so that
 *   query results AND paused mutations survive a cold restart (kill-and-relaunch).
 * - `onlineManager` resume hook so paused mutations replay the moment the
 *   network is reported back, even if the host app swapped in a custom
 *   onlineManager implementation.
 *
 * Storage layer:
 * - React Native -> AsyncStorage via `createAsyncStoragePersister`.
 * - Web -> localStorage via `createSyncStoragePersister` (wrapped in the
 *   async persister API for a single call site).
 * - Both adapters are content-shape compatible with our `StorageInterface`.
 *
 * Whitelist policy:
 * - Persist every account/user/session/privacy query and every queued mutation.
 * - DO NOT persist large list queries (e.g. activity feeds) — they go stale
 *   fast and would balloon storage. Add new keys to `PERSISTED_QUERY_PREFIXES`
 *   when introducing reads that should survive restart.
 */

import { QueryClient, onlineManager, type Query, type Mutation } from '@tanstack/react-query';
import {
  persistQueryClient,
  type PersistedClient,
} from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { isDev } from '@oxyhq/core';
import type { StorageInterface } from '../utils/storageHelpers';

const QUERY_CACHE_KEY = 'oxy_query_cache_v3';
const QUERY_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const QUERY_PERSIST_THROTTLE_MS = 1_000;
const MAX_QUERY_RETRIES = 2;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { status?: unknown; response?: { status?: unknown } }).status
    ?? (error as { response?: { status?: unknown } }).response?.status;
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
 * Query-key prefixes that should survive cold restart. Anything not listed
 * is dropped during dehydration so the persisted blob stays small.
 *
 * Mutations are persisted independently (always) so the offline write queue
 * works regardless of the read whitelist.
 */
const PERSISTED_QUERY_PREFIXES: ReadonlyArray<string> = [
  'accounts',
  'users',
  'sessions',
  'devices',
  'privacy',
];

/**
 * Adapt our `StorageInterface` (which always returns `null` for missing keys)
 * to TanStack's `AsyncStorage` shape. The two are structurally identical
 * apart from naming; this also gives us a single place to add error
 * suppression if a host platform's storage throws.
 */
function adaptStorage(storage: StorageInterface): {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
} {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/**
 * Decide whether a given query should be written to persistent storage.
 *
 * Two gates:
 * 1. The query must be in our prefix whitelist.
 * 2. The query must have completed successfully at least once — there's no
 *    point persisting a `pending`/`error` state, and persisting `error` would
 *    leak failure objects across restarts.
 */
function shouldDehydrateQuery(query: Query): boolean {
  if (query.state.status !== 'success') {
    return false;
  }
  const head = query.queryKey[0];
  if (typeof head !== 'string') {
    return false;
  }
  return PERSISTED_QUERY_PREFIXES.includes(head);
}

/**
 * Persist every mutation regardless of status — paused mutations are
 * exactly the ones that must survive restart to replay when online.
 */
function shouldDehydrateMutation(_mutation: Mutation): boolean {
  return true;
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
 * Wire `persistQueryClient` to the supplied storage adapter.
 *
 * Returns once the in-flight restore promise is available so callers can
 * `await result.restored` before rendering UI that depends on cached data.
 *
 * Safe to no-op if `storage` is null/undefined (e.g. server-side render
 * with no host storage).
 */
export const attachQueryPersistence = (
  queryClient: QueryClient,
  storage: StorageInterface | null | undefined,
): AttachPersistenceResult => {
  if (!storage) {
    return {
      restored: Promise.resolve(),
      unsubscribe: () => {},
    };
  }

  const persister = createAsyncStoragePersister({
    storage: adaptStorage(storage),
    key: QUERY_CACHE_KEY,
    throttleTime: QUERY_PERSIST_THROTTLE_MS,
  });

  const [unsubscribe, restored] = persistQueryClient({
    queryClient,
    persister,
    maxAge: QUERY_CACHE_MAX_AGE,
    dehydrateOptions: {
      shouldDehydrateQuery,
      shouldDehydrateMutation,
    },
  });

  restored.catch((error) => {
    if (isDev()) {
      console.warn('[QueryClient] Failed to restore persisted cache', error);
    }
  });

  return { unsubscribe, restored };
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
