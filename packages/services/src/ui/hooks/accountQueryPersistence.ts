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
 * - Queries written by another build are dropped on restore; queued (paused)
 *   mutations are kept (`persistedQueryCache.ts`).
 * - On a subject change the account's queries, memory-only ones included, and
 *   its paused mutations are dropped from memory synchronously, before anyone
 *   is woken. The leaving account's latest state is written first, a sign-out
 *   then deletes it, and only then is the next account's blob read.
 * - `isReady()` is false until the signed-in account's blob is restored, and
 *   `RequireOxyAuth` waits on it, so another account's rows never render.
 *
 * Every storage operation runs through one queue, in order, and a restore
 * checks that its account is still the active one in the same tick it hydrates.
 */

import { hashKey, type Mutation, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { StorageInterface } from '../utils/storageHelpers';
import {
  PERSISTED_QUERY_PREFIXES,
  SDK_MEMORY_ONLY_ROOTS,
  hydrateSnapshot,
  rootOf,
  snapshot,
  subscribeSnapshots,
  type PersistFilters,
} from './persistedQueryCache';

/** An app's declaration of which data is private to the signed-in account. */
export interface AccountQueriesConfig {
  /**
   * Query-key roots (`queryKey[0]`) whose data belongs to the signed-in account
   * and survives a restart. `'all'`: every query the app runs, for an app whose
   * every read may depend on who is signed in, so no root can be forgotten.
   *
   * The roots `accounts`, `sessions` and `devices` are reserved for the SDK's
   * device-level data: an app must not use them. `users` and `privacy` are the
   * SDK's too, and with `'all'` they are dropped on a switch like the app's.
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

/** Which queries and mutations an `AccountQueriesConfig` makes the account's. */
export interface AccountQueryOwnership {
  /** Dropped from memory on a subject change. */
  ownsQuery: (query: Query) => boolean;
  /** Written to the account's blob. */
  persistsQuery: (query: Query) => boolean;
  ownsMutation: (mutation: Mutation) => boolean;
}

/** SDK roots that hold device-level data, the same whoever is signed in. */
const DEVICE_ROOTS = new Set(['accounts', 'sessions', 'devices']);

export function accountQueryOwnership(config: AccountQueriesConfig): AccountQueryOwnership {
  const memoryOnly = new Set([...(config.memoryOnlyRoots ?? []), ...SDK_MEMORY_ONLY_ROOTS]);
  const sdkRoots = new Set(PERSISTED_QUERY_PREFIXES);
  const declared = config.roots === 'all' ? null : new Set(config.roots);
  const mutationHashes = new Set((config.mutationKeys ?? []).map((key) => hashKey(key)));

  const ownsQuery = (query: Query): boolean => {
    const root = rootOf(query);
    if (root !== null && memoryOnly.has(root)) return true;
    if (declared === null) return root === null || !DEVICE_ROOTS.has(root);
    return root !== null && declared.has(root);
  };
  return {
    ownsQuery,
    persistsQuery: (query) => {
      if (!ownsQuery(query)) return false;
      const root = rootOf(query);
      if (root === null) return true;
      // The SDK's own roots stay with the SDK persister.
      return !memoryOnly.has(root) && (declared !== null || !sdkRoots.has(root));
    },
    ownsMutation: (mutation) => {
      const key = mutation.options.mutationKey;
      return key !== undefined && mutationHashes.has(hashKey(key));
    },
  };
}

export const ACCOUNT_QUERY_CACHE_KEY = 'oxy_account_queries';
const ACCOUNT_QUERY_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCOUNT_QUERY_PERSIST_THROTTLE_MS = 1_000;

export interface AccountQueryPersistence {
  /** Storage became available (it initializes asynchronously). */
  setStorage(storage: StorageInterface): void;
  /** The signed-in account changed. `null` is a sign-out. Synchronous in-memory reset. */
  activate(accountId: string | null): void;
  /** The owning provider mounted: restore and persist the active account. */
  attach(): void;
  /** The owning provider unmounted: stop touching the client and storage. */
  detach(): void;
  /** True once the active account's cache is restored (always true signed out). */
  isReady(): boolean;
  subscribe(listener: () => void): () => void;
}

function storageKeyFor(accountId: string): string {
  return `${ACCOUNT_QUERY_CACHE_KEY}:${encodeURIComponent(accountId)}`;
}

export function createAccountQueryPersistence(
  queryClient: QueryClient,
  config: AccountQueriesConfig,
): AccountQueryPersistence {
  const { ownsQuery, persistsQuery, ownsMutation } = accountQueryOwnership(config);
  const filters: PersistFilters = {
    shouldDehydrateQuery: (query) => query.state.status === 'success' && persistsQuery(query),
    shouldDehydrateMutation: (mutation) => mutation.state.isPaused && ownsMutation(mutation),
  };
  const listeners = new Set<() => void>();

  let resolveStorage: (storage: StorageInterface) => void = () => undefined;
  const storageReady = new Promise<StorageInterface>((resolve) => {
    resolveStorage = resolve;
  });
  let hasStorage = false;
  // Every read, write and delete runs here, in order, once storage exists.
  let io: Promise<unknown> = storageReady;
  const enqueue = (operation: (storage: StorageInterface) => Promise<unknown> | unknown) => {
    io = io
      .then(() => storageReady)
      .then(operation)
      .catch(() => undefined);
  };

  let attached = false;
  let accountId: string | null = null;
  let restoredFor: string | null = null;
  let generation = 0;
  let writer: ReturnType<typeof subscribeSnapshots> | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const dropScopedData = () => {
    queryClient.removeQueries({ predicate: ownsQuery });
    const mutations = queryClient.getMutationCache();
    for (const mutation of mutations.getAll()) {
      if (ownsMutation(mutation)) mutations.remove(mutation);
    }
  };

  const stopWriting = () => {
    writer?.unsubscribe();
    writer = null;
  };

  const restore = () => {
    const id = accountId;
    if (!attached || id === null) return;
    const current = generation;
    const key = storageKeyFor(id);
    enqueue(async (storage) => {
      const raw = await storage.getItem(key);
      // Same tick as the hydrate: a switch in between cannot be missed.
      if (current !== generation) return;
      if (!hydrateSnapshot(queryClient, raw, ACCOUNT_QUERY_CACHE_MAX_AGE) && raw) {
        await storage.removeItem(key);
        if (current !== generation) return;
      }
      restoredFor = id;
      writer = subscribeSnapshots(queryClient, filters, ACCOUNT_QUERY_PERSIST_THROTTLE_MS, (serialized) => {
        if (current !== generation) return;
        enqueue((target) => target.setItem(key, serialized));
      });
      notify();
    });
  };

  return {
    setStorage(next) {
      if (hasStorage) return;
      hasStorage = true;
      resolveStorage(next);
    },

    activate(next) {
      if (next === accountId) return;
      const previous = accountId;
      // Keep the leaving account's latest state, but only once its own blob was
      // restored: before that, the cache holds none of it to write.
      if (previous !== null && restoredFor === previous) {
        const serialized = snapshot(queryClient, filters);
        const key = storageKeyFor(previous);
        enqueue((storage) => storage.setItem(key, serialized));
      }
      generation += 1;
      stopWriting();
      dropScopedData();
      accountId = next;
      restoredFor = null;
      if (next === null && previous !== null) {
        const key = storageKeyFor(previous);
        enqueue((storage) => storage.removeItem(key));
      }
      notify();
      restore();
    },

    attach() {
      if (attached) return;
      attached = true;
      restore();
    },

    detach() {
      if (!attached) return;
      attached = false;
      writer?.flush();
      generation += 1;
      stopWriting();
      restoredFor = null;
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
  };
}
