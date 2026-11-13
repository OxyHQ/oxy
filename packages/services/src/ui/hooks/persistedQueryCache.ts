/**
 * The storage format and restore rules shared by the SDK's two query caches:
 * the account-agnostic one (`attachQueryPersistence`) and the per-account one
 * (`createAccountQueryPersistence`).
 *
 * A blob is `{ buster, timestamp, clientState }`, TanStack's persisted-client
 * shape. Restoring it treats its two halves differently:
 *
 * - Queries are served before any refetch, so a query written under another
 *   buster, in whatever shape it had then, is dropped. The buster is the build
 *   (`getOxyBuildId`) unless the app declares the version of the data it
 *   persists (`AccountQueriesConfig.dataVersion`, see `persistedBuster`).
 * - Paused mutations are the user's queued actions (a star, a send made
 *   offline). A deploy must not lose them, so they are restored whatever build
 *   wrote them; the current build's `setMutationDefaults` replays them.
 */

import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type Mutation,
  type Query,
  type QueryClient,
} from '@tanstack/react-query';
import { getOxyBuildId } from '../utils/buildId';
import { SERVICES_PERSISTED_DATA_VERSION } from '../utils/persistedDataVersion';

/** The SDK's own account-agnostic query roots, persisted by `attachQueryPersistence`. */
export const PERSISTED_QUERY_PREFIXES: ReadonlyArray<string> = [
  'accounts',
  'users',
  'sessions',
  'devices',
  'privacy',
];

/**
 * SDK queries whose data (or key) carries a signed, expiring URL. Never
 * written to disk: a restored one would serve an expired URL.
 */
export const SDK_MEMORY_ONLY_ROOTS: ReadonlyArray<string> = [
  'assetDownloadUrls',
  'avatarCropSource',
  'avatarCropMeasure',
  'justifiedPhotoDimensions',
];

/**
 * A cap on what one root writes to disk: its `maxQueries` most recently updated queries, each
 * passed through `trim` (for example, a conversation's last messages). Queries past the cap that
 * no screen is watching leave memory too, so the root stays bounded in both.
 */
export interface PersistedRootBound {
  maxQueries: number;
  /** Shrink one query's data before it is written. Must return data of the same shape. */
  trim?: (data: unknown) => unknown;
  /**
   * Give a restored query's data its type back before anything reads it: the blob is JSON, so a
   * `Date` comes back as a string. Runs once per query, on restore.
   */
  revive?: (data: unknown) => unknown;
}

export interface PersistFilters {
  /** The queries this cache keeps, whatever their state; only successful ones are written. */
  persistsQuery: (query: Query) => boolean;
  shouldDehydrateMutation: (mutation: Mutation) => boolean;
  /** What a blob is stamped with, and must match to be restored. Defaults to the build. */
  buster?: string;
  /** Per-root caps, by `queryKey[0]`. */
  bounds?: ReadonlyMap<string, PersistedRootBound>;
}

/**
 * The stamp a persisted blob must carry to be restored.
 *
 * Without a declared version it is the build: every deploy starts from the network, which is
 * safe for an app that never says when its persisted data changes shape. With one, a blob
 * survives deploys and is dropped only when that version, or this SDK's own (it owns the shape
 * of the shared roots and of how blobs are written), changes.
 */
export function persistedBuster(dataVersion?: string): string {
  return dataVersion ? `data:${SERVICES_PERSISTED_DATA_VERSION}:${dataVersion}` : getOxyBuildId();
}

/** Within each bounded root, its queries ordered newest first by when their data arrived. */
function rankedByRoot<T extends { queryKey: readonly unknown[]; updatedAt: number }>(
  items: readonly T[],
  bounds: ReadonlyMap<string, PersistedRootBound>,
): Map<string, T[]> {
  const byRoot = new Map<string, T[]>();
  for (const item of items) {
    const root = typeof item.queryKey[0] === 'string' ? item.queryKey[0] : null;
    if (root === null || !bounds.has(root)) continue;
    const list = byRoot.get(root) ?? [];
    list.push(item);
    byRoot.set(root, list);
  }
  for (const list of byRoot.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return byRoot;
}

/** Apply `bounds` to a dehydrated state: drop past the cap, trim what stays. */
function boundState(
  state: DehydratedState,
  bounds: ReadonlyMap<string, PersistedRootBound> | undefined,
): DehydratedState {
  if (!bounds || bounds.size === 0) return state;
  const ranked = rankedByRoot(
    state.queries.map((query) => ({ ...query, updatedAt: query.state.dataUpdatedAt })),
    bounds,
  );
  const kept = new Set<string>();
  for (const [root, list] of ranked) {
    for (const query of list.slice(0, bounds.get(root)!.maxQueries)) kept.add(query.queryHash);
  }
  return {
    ...state,
    queries: state.queries.flatMap((query) => {
      const root = typeof query.queryKey[0] === 'string' ? query.queryKey[0] : null;
      const bound = root === null ? undefined : bounds.get(root);
      if (!bound) return [query];
      if (!kept.has(query.queryHash)) return [];
      return [
        bound.trim
          ? { ...query, state: { ...query.state, data: bound.trim(query.state.data) } }
          : query,
      ];
    }),
  };
}

function reviveQuery(
  query: DehydratedState['queries'][number],
  bounds: ReadonlyMap<string, PersistedRootBound> | undefined,
): DehydratedState['queries'][number] {
  const root = typeof query.queryKey[0] === 'string' ? query.queryKey[0] : null;
  const revive = root === null ? undefined : bounds?.get(root)?.revive;
  if (!revive || query.state.data === undefined) return query;
  return { ...query, state: { ...query.state, data: revive(query.state.data) } };
}

/** Remove, from memory, a bounded root's queries past its cap that nothing is watching. */
export function evictBeyondBounds(
  queryClient: QueryClient,
  bounds: ReadonlyMap<string, PersistedRootBound> | undefined,
): void {
  if (!bounds || bounds.size === 0) return;
  const ranked = rankedByRoot(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ query, queryKey: query.queryKey, updatedAt: query.state.dataUpdatedAt })),
    bounds,
  );
  for (const [root, list] of ranked) {
    for (const { query } of list.slice(bounds.get(root)!.maxQueries)) {
      if (query.getObserversCount() === 0) queryClient.getQueryCache().remove(query);
    }
  }
}

interface PersistedBlob {
  buster: string;
  timestamp: number;
  clientState: DehydratedState;
}

/**
 * Keep a persisted root's queries in memory for as long as they live on disk.
 *
 * A snapshot is written from memory, so a query the client garbage-collects is gone from the next
 * snapshot too. With the default `gcTime` (30 minutes) under a cache kept for days, "persisted"
 * meant "seen in the last half hour": a skill, a thread or a list not on screen for that long
 * dropped out of memory and of storage, and the next visit waited on the network behind a
 * skeleton. `gcTime: Infinity` (TanStack's advice for a persisted cache, and no timer: a gcTime
 * over 2^31 ms would overflow one) keeps them until the cache's own rules remove them: expiry on
 * restore, an account switch, sign-out. Set before restoring, so hydrated queries get it too.
 */
export function keepPersistedRootsInMemory(
  queryClient: QueryClient,
  roots: ReadonlyArray<string>,
): void {
  for (const root of roots) queryClient.setQueryDefaults([root], { gcTime: Infinity });
}

export function rootOf(query: Pick<Query, 'queryKey'>): string | null {
  const head = query.queryKey[0];
  return typeof head === 'string' ? head : null;
}

/** Serialize what the filters select, within their bounds, stamped with their buster. */
export function snapshot(queryClient: QueryClient, filters: PersistFilters): string {
  const blob: PersistedBlob = {
    buster: filters.buster ?? getOxyBuildId(),
    timestamp: Date.now(),
    clientState: boundState(
      dehydrate(queryClient, {
        shouldDehydrateQuery: (query) =>
          query.state.status === 'success' && filters.persistsQuery(query),
        shouldDehydrateMutation: filters.shouldDehydrateMutation,
      }),
      filters.bounds,
    ),
  };
  return JSON.stringify(blob);
}

/**
 * Hydrate a stored blob into the client, synchronously, so a caller can check
 * it is still wanted immediately before. Returns false when there was nothing
 * usable (absent, unreadable or expired), in which case the caller removes it.
 */
export function hydrateSnapshot(
  queryClient: QueryClient,
  raw: string | null,
  maxAge: number,
  options?: {
    /** The stamp the blob must carry for its queries to be restored. Defaults to the build. */
    buster?: string;
    /** Per-root `revive`, applied to each restored query of that root. */
    bounds?: ReadonlyMap<string, PersistedRootBound>;
    shouldRestoreQuery?: (query: DehydratedState['queries'][number]) => boolean;
    shouldRestoreMutation?: (mutation: DehydratedState['mutations'][number]) => boolean;
    restoreMutations?: boolean;
  },
): boolean {
  if (!raw) return false;
  let blob: PersistedBlob;
  try {
    blob = JSON.parse(raw) as PersistedBlob;
  } catch {
    return false;
  }
  if (
    !blob?.clientState ||
    typeof blob.timestamp !== 'number' ||
    Date.now() - blob.timestamp > maxAge
  ) {
    return false;
  }
  const sameBuild = blob.buster === (options?.buster ?? getOxyBuildId());
  hydrate(queryClient, {
    queries: sameBuild
      ? (blob.clientState.queries ?? [])
          .filter((query) => options?.shouldRestoreQuery?.(query) ?? true)
          .map((query) => reviveQuery(query, options?.bounds))
      : [],
    mutations:
      options?.restoreMutations === false
        ? []
        : (blob.clientState.mutations ?? []).filter(
            (mutation) => options?.shouldRestoreMutation?.(mutation) ?? true,
          ),
  });
  return true;
}

/**
 * Write the filtered cache whenever one of its queries or any mutation changes,
 * at most once per `throttleMs`. Activity in queries it does not keep (feeds,
 * search) never serializes it. `write` receives the snapshot; `flush()` writes now.
 */
export function subscribeSnapshots(
  queryClient: QueryClient,
  filters: PersistFilters,
  throttleMs: number,
  write: (serialized: string) => void,
): { flush: () => void; unsubscribe: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    write(snapshot(queryClient, filters));
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, throttleMs);
  };
  const offQueries = queryClient.getQueryCache().subscribe((event) => {
    if (filters.persistsQuery(event.query)) schedule();
  });
  const offMutations = queryClient.getMutationCache().subscribe(schedule);
  return {
    flush,
    unsubscribe: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      offQueries();
      offMutations();
    },
  };
}
