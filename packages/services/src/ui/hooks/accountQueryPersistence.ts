/**
 * Offline persistence for an app's PRIVATE, per-account queries.
 *
 * The SDK's own persister (`attachQueryPersistence`) keeps account-agnostic
 * data. An app's mail, library or drafts belong to one account, and every app
 * that wanted them to survive a restart had to scope a persister to the session
 * itself. The SDK owns the session, so it owns this too:
 *
 * - Storage is keyed by the account (`oxy_account_queries:<accountId>`), so a
 *   restore can only ever hydrate the account that is signed in.
 * - The buster is the build (`getOxyBuildId`), so no cache written by an older
 *   bundle, in an older shape, is ever served.
 * - On a subject change the declared roots, memory-only ones included, and the
 *   account's paused mutations are dropped
 *   from memory synchronously, before anyone is woken, and the new account's
 *   blob is restored. `isReady()` is false until that restore settles, and
 *   `RequireOxyAuth` waits on it, so another account's rows never render.
 * - On sign-out the signed-out account's blob is deleted.
 */

import { hashKey, type Mutation, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { StorageInterface } from '../utils/storageHelpers';
import { getOxyBuildId } from '../utils/buildId';
import { PERSISTED_QUERY_PREFIXES } from './queryClient';
import { ASSET_DOWNLOAD_URLS_QUERY_KEY } from './useResolvedFileUrls';

/** An app's declaration of which data is private to the signed-in account. */
export interface AccountQueriesConfig {
  /**
   * Query-key roots (`queryKey[0]`) whose data belongs to the signed-in account
   * and survives a restart. `'all'`: every query the app runs, except the SDK's
   * own account-agnostic ones, for an app whose every read may depend on who
   * is signed in. Nothing can then be forgotten.
   */
  roots: readonly string[] | 'all';
  /**
   * Roots that belong to the account too, but must not be written to disk
   * (signed URLs, AI output, search results): dropped on a switch, never persisted.
   */
  memoryOnlyRoots?: readonly string[];
  /**
   * Mutation keys whose PAUSED (offline) instances replay after a restart for
   * the same account. Register their `mutationFn` with `setMutationDefaults`.
   */
  mutationKeys?: readonly QueryKey[];
}

export const ACCOUNT_QUERY_CACHE_KEY = 'oxy_account_queries';
const ACCOUNT_QUERY_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCOUNT_QUERY_PERSIST_THROTTLE_MS = 1_000;

export interface AccountQueryPersistence {
  /** Storage became available (it initializes asynchronously). */
  setStorage(storage: StorageInterface): void;
  /** The signed-in account changed. `null` is a sign-out. Synchronous in-memory reset. */
  activate(accountId: string | null): void;
  /** True once the active account's cache is restored (always true signed out). */
  isReady(): boolean;
  subscribe(listener: () => void): () => void;
  /** Whether a mutation is account-scoped (so the SDK's own persister skips it). */
  ownsMutation(mutation: Mutation): boolean;
  dispose(): void;
}

function storageKeyFor(accountId: string): string {
  return `${ACCOUNT_QUERY_CACHE_KEY}:${encodeURIComponent(accountId)}`;
}

export function createAccountQueryPersistence(
  queryClient: QueryClient,
  config: AccountQueriesConfig,
): AccountQueryPersistence {
  // Signed media URLs expire and must never be written to disk, whatever the app declares.
  const memoryOnlyRoots = new Set<string>([...(config.memoryOnlyRoots ?? []), ASSET_DOWNLOAD_URLS_QUERY_KEY]);
  const sdkRoots = new Set(PERSISTED_QUERY_PREFIXES);
  const declaredRoots = config.roots === 'all' ? null : new Set(config.roots);
  const mutationHashes = new Set((config.mutationKeys ?? []).map((key) => hashKey(key)));
  const listeners = new Set<() => void>();

  let storage: StorageInterface | null = null;
  let accountId: string | null = null;
  let restoredFor: string | null = null;
  let generation = 0;
  let unsubscribePersist: (() => void) | null = null;
  // The in-flight restore. A new account waits for it, so a late restore can
  // never hydrate the previous account's rows after the switch.
  let restoring: Promise<void> = Promise.resolve();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const rootOf = (query: Query): string | null => {
    const head = query.queryKey[0];
    return typeof head === 'string' ? head : null;
  };
  const ownsQuery = (query: Query): boolean => {
    const root = rootOf(query);
    if (root !== null && memoryOnlyRoots.has(root)) return true;
    // The SDK's own account-agnostic prefixes are the SDK persister's.
    if (declaredRoots === null) return root === null || !sdkRoots.has(root);
    return root !== null && declaredRoots.has(root);
  };
  const persistsQuery = (query: Query): boolean => {
    const root = rootOf(query);
    return ownsQuery(query) && (root === null || !memoryOnlyRoots.has(root));
  };

  const ownsMutation = (mutation: Mutation): boolean => {
    const key = mutation.options.mutationKey;
    return key !== undefined && mutationHashes.has(hashKey(key));
  };

  const dropScopedData = () => {
    queryClient.removeQueries({ predicate: ownsQuery });
    const mutations = queryClient.getMutationCache();
    for (const mutation of mutations.getAll()) {
      if (ownsMutation(mutation)) mutations.remove(mutation);
    }
  };

  const persisterFor = (id: string, target: StorageInterface) =>
    createAsyncStoragePersister({
      storage: {
        getItem: (key) => target.getItem(key),
        setItem: (key, value) => target.setItem(key, value),
        removeItem: (key) => target.removeItem(key),
      },
      key: storageKeyFor(id),
      throttleTime: ACCOUNT_QUERY_PERSIST_THROTTLE_MS,
    });

  const start = () => {
    const id = accountId;
    const target = storage;
    if (!id || !target || unsubscribePersist) return;
    const current = generation;
    const [unsubscribe, restored] = persistQueryClient({
      queryClient,
      persister: persisterFor(id, target),
      maxAge: ACCOUNT_QUERY_CACHE_MAX_AGE,
      buster: getOxyBuildId(),
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => query.state.status === 'success' && persistsQuery(query),
        shouldDehydrateMutation: (mutation) => mutation.state.isPaused && ownsMutation(mutation),
      },
    });
    unsubscribePersist = unsubscribe;
    restoring = restored.catch(() => undefined).then(() => {
      if (current !== generation) return;
      restoredFor = id;
      notify();
    });
  };

  const stop = () => {
    unsubscribePersist?.();
    unsubscribePersist = null;
  };

  return {
    setStorage(next) {
      if (storage) return;
      storage = next;
      const current = generation;
      void restoring.then(() => {
        if (current === generation) start();
      });
    },

    activate(next) {
      if (next === accountId) return;
      const previous = accountId;
      generation += 1;
      const current = generation;
      stop();
      dropScopedData();
      accountId = next;
      restoredFor = null;
      notify();

      if (next === null && previous !== null && storage) {
        void persisterFor(previous, storage).removeClient();
      }

      void restoring.then(() => {
        if (current !== generation) return;
        // A restore that was already in flight may have hydrated the previous
        // account's rows; drop them again before this account's restore.
        dropScopedData();
        start();
      });
    },

    isReady() {
      return accountId === null || restoredFor === accountId;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ownsMutation,

    dispose() {
      generation += 1;
      stop();
      listeners.clear();
    },
  };
}
