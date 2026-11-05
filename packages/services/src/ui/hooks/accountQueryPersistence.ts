/**
 * Offline persistence for an app's PRIVATE, per-account queries.
 *
 * The SDK's own persister (`attachQueryPersistence`) keeps account-agnostic
 * data. An app's mail, library or drafts belong to one account, and every app
 * that wanted them to survive a restart had to scope a persister to the session
 * itself. The SDK owns the session, so it owns this too, for every root an app
 * declares (`accountQueries`) and for any single query marked
 * `meta: { persist: 'account' }`, with no declaration at all:
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
 *   `RequireOxyAuth` waits on it, so another account's rows never render. A
 *   cold boot that paints a cached session waits on it too (`whenReady()`), so
 *   the first paint already has the account's rows.
 *
 * Every storage operation runs through one queue, in order, and a restore
 * checks that its account is still the active one in the same tick it hydrates.
 */

import {
  hashKey,
  type Mutation,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
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

/**
 * The `meta` that makes one query the signed-in account's and keeps it across
 * restarts, exactly like a query under a declared root: for the few reads that
 * shape a returning user's first paint (the tabs, the theme), not for lists.
 *
 * `useQuery({ queryKey, queryFn, meta: { persist: 'account' } })`
 */
export interface AccountQueryMeta {
  persist: 'account';
}

type QueryIdentity = { queryKey: QueryKey; meta?: Query['meta'] };

function isAccountQuery(query: Pick<QueryIdentity, 'meta'>): boolean {
  return (query.meta as Partial<AccountQueryMeta> | undefined)?.persist === 'account';
}

/** An app's declaration of which data is private to the signed-in account. */
export interface AccountQueriesConfig {
  /**
   * Query-key roots (`queryKey[0]`) whose data belongs to the signed-in account
   * and survives a restart. `'all'`: every query the app runs, for an app whose
   * every read may depend on who is signed in, so no root can be forgotten.
   * Every root's queries are written on every change to any of them: for one
   * or two queries under a busy root, mark those instead (`AccountQueryMeta`).
   *
   * The roots `accounts`, `sessions` and `devices` are reserved for the SDK's
   * device-level data: an app must not use them. `users` and `privacy` are the
   * SDK's too, and with `'all'` they are dropped on a switch like the app's.
   */
  roots: readonly string[] | 'all';
  /**
   * Roots that belong to the account too, but must not be written to disk
   * (signed URLs, AI output, search results): dropped on a switch, never persisted.
   * `'all'` keeps every account-owned query in memory only, including marked
   * queries unless `persistMarkedQueries` is enabled. Device-level SDK roots
   * remain excluded unless an individual query declares account persistence.
   */
  memoryOnlyRoots?: readonly string[] | 'all';
  /**
   * When `memoryOnlyRoots` is `'all'`, persist queries explicitly marked with
   * `meta.persist = 'account'`. SDK memory-only roots remain excluded.
   * Defaults to false.
   */
  persistMarkedQueries?: boolean;
  /**
   * Mutation keys whose PAUSED (offline) instances replay after a restart for
   * the same account. Register their `mutationFn` with `setMutationDefaults`.
   */
  mutationKeys?: readonly QueryKey[];
  /**
   * Exact mutation keys whose records belong to the account but must remain
   * in memory. They are dropped on account transitions and excluded from both
   * caches. If also listed in `mutationKeys`, memory-only takes precedence.
   * A previously persisted queue for a newly memory-only key is not restored;
   * a later snapshot can overwrite it. This does not cancel requests or
   * callbacks, or immediately erase old blobs.
   */
  memoryOnlyMutationKeys?: readonly QueryKey[];
  /**
   * Remove unregistered mutation records as well on every account transition.
   * Only registered paused mutations are saved and restored; unregistered
   * mutations are excluded from the shared persisted cache too. Removing a record
   * does not cancel an in-flight request or its callbacks; apps must scope
   * their mutation effects to the account that started them.
   * Defaults to false.
   */
  clearUnregisteredMutations?: boolean;
}

/** Which queries and mutations an `AccountQueriesConfig` makes the account's. */
export interface AccountQueryOwnership {
  /** Dropped from memory on a subject change. */
  ownsQuery: (query: QueryIdentity) => boolean;
  /** Written to the account's blob. */
  persistsQuery: (query: QueryIdentity) => boolean;
  ownsMutation: (mutation: Mutation) => boolean;
  /** Whether a stored mutation key is owned by the account. */
  ownsMutationKey: (key: QueryKey | undefined) => boolean;
  /** Eligible for the account's persisted paused mutations. */
  persistsMutation: (mutation: Mutation) => boolean;
  /** Whether a stored mutation key belongs to this account's offline queue. */
  persistsMutationKey: (key: QueryKey | undefined) => boolean;
}

/** SDK roots that hold device-level data, the same whoever is signed in. */
const DEVICE_ROOTS = new Set(['accounts', 'sessions', 'devices']);

/** No declared roots: only the queries marked `AccountQueryMeta` are the account's. */
const NO_ROOTS: AccountQueriesConfig = { roots: [] };

export function accountQueryOwnership(
  config: AccountQueriesConfig = NO_ROOTS,
): AccountQueryOwnership {
  const memoryOnlyAll = config.memoryOnlyRoots === 'all';
  const memoryOnly = new Set([
    ...(memoryOnlyAll ? [] : (config.memoryOnlyRoots ?? [])),
    ...SDK_MEMORY_ONLY_ROOTS,
  ]);
  const sdkRoots = new Set(PERSISTED_QUERY_PREFIXES);
  const declared = config.roots === 'all' ? null : new Set(config.roots);
  const memoryMutationHashes = new Set(
    (config.memoryOnlyMutationKeys ?? []).map((key) => hashKey(key)),
  );
  const mutationHashes = new Set((config.mutationKeys ?? []).map((key) => hashKey(key)));
  const isMemoryOnlyMutationKey = (key: QueryKey | undefined): boolean =>
    key !== undefined && memoryMutationHashes.has(hashKey(key));
  const persistsMutationKey = (key: QueryKey | undefined): boolean =>
    key !== undefined && !isMemoryOnlyMutationKey(key) && mutationHashes.has(hashKey(key));
  const ownsMutationKey = (key: QueryKey | undefined): boolean =>
    isMemoryOnlyMutationKey(key) || persistsMutationKey(key);
  const isRegisteredMutation = (mutation: Mutation): boolean =>
    persistsMutationKey(mutation.options.mutationKey);

  const ownsQuery = (query: QueryIdentity): boolean => {
    if (isAccountQuery(query)) return true;
    const root = rootOf(query);
    if (memoryOnlyAll && (root === null || !DEVICE_ROOTS.has(root))) return true;
    if (root !== null && memoryOnly.has(root)) return true;
    if (declared === null) return root === null || !DEVICE_ROOTS.has(root);
    return root !== null && declared.has(root);
  };
  return {
    ownsQuery,
    persistsQuery: (query) => {
      if (!ownsQuery(query)) return false;
      const root = rootOf(query);
      if (memoryOnlyAll) {
        return (
          config.persistMarkedQueries === true &&
          isAccountQuery(query) &&
          (root === null || !memoryOnly.has(root))
        );
      }
      if (root === null) return true;
      // The SDK's own roots stay with the SDK persister.
      return (
        !memoryOnly.has(root) && (isAccountQuery(query) || declared !== null || !sdkRoots.has(root))
      );
    },
    ownsMutation: (mutation) =>
      config.clearUnregisteredMutations === true || ownsMutationKey(mutation.options.mutationKey),
    ownsMutationKey,
    persistsMutation: isRegisteredMutation,
    persistsMutationKey,
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
  /** Resolves once `isReady()`, or once the account it waited for is left. */
  whenReady(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function storageKeyFor(accountId: string): string {
  return `${ACCOUNT_QUERY_CACHE_KEY}:${encodeURIComponent(accountId)}`;
}

export function createAccountQueryPersistence(
  queryClient: QueryClient,
  config?: AccountQueriesConfig,
): AccountQueryPersistence {
  const { ownsQuery, persistsQuery, ownsMutation, persistsMutation, persistsMutationKey } =
    accountQueryOwnership(config);
  const filters: PersistFilters = {
    persistsQuery,
    shouldDehydrateMutation: (mutation) => mutation.state.isPaused && persistsMutation(mutation),
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
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const isReady = () => accountId === null || restoredFor === accountId;

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
      // An unreadable blob restores nothing; it must not leave the account unready.
      const raw = await storage.getItem(key).catch(() => null);
      // Same tick as the hydrate: a switch in between cannot be missed.
      if (current !== generation) return;
      if (
        !hydrateSnapshot(queryClient, raw, ACCOUNT_QUERY_CACHE_MAX_AGE, {
          shouldRestoreQuery: persistsQuery,
          shouldRestoreMutation: (mutation) => persistsMutationKey(mutation.mutationKey),
        }) &&
        raw
      ) {
        await storage.removeItem(key).catch(() => undefined);
        if (current !== generation) return;
      }
      restoredFor = id;
      writer = subscribeSnapshots(
        queryClient,
        filters,
        ACCOUNT_QUERY_PERSIST_THROTTLE_MS,
        (serialized) => {
          if (current !== generation) return;
          enqueue((target) => target.setItem(key, serialized));
        },
      );
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

    isReady,

    whenReady() {
      const waitingFor = generation;
      const settled = () => isReady() || generation !== waitingFor;
      if (settled()) return Promise.resolve();
      return new Promise((resolve) => {
        const off = subscribe(() => {
          if (!settled()) return;
          off();
          resolve();
        });
      });
    },

    subscribe,
  };
}
