/**
 * The storage format and restore rules shared by the SDK's two query caches:
 * the account-agnostic one (`attachQueryPersistence`) and the per-account one
 * (`createAccountQueryPersistence`).
 *
 * A blob is `{ buster, timestamp, clientState }`, TanStack's persisted-client
 * shape. Restoring it treats its two halves differently:
 *
 * - Queries are served before any refetch, so a query written by another
 *   build, in whatever shape that build used, is dropped (`getOxyBuildId`).
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

export interface PersistFilters {
  shouldDehydrateQuery: (query: Query) => boolean;
  shouldDehydrateMutation: (mutation: Mutation) => boolean;
}

interface PersistedBlob {
  buster: string;
  timestamp: number;
  clientState: DehydratedState;
}

export function rootOf(query: Query): string | null {
  const head = query.queryKey[0];
  return typeof head === 'string' ? head : null;
}

/** Serialize what the filters select, stamped with this build. */
export function snapshot(queryClient: QueryClient, filters: PersistFilters): string {
  const blob: PersistedBlob = {
    buster: getOxyBuildId(),
    timestamp: Date.now(),
    clientState: dehydrate(queryClient, filters),
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
  const sameBuild = blob.buster === getOxyBuildId();
  hydrate(queryClient, {
    queries: sameBuild ? blob.clientState.queries : [],
    mutations: blob.clientState.mutations ?? [],
  });
  return true;
}

/**
 * Write the filtered cache on every change, at most once per `throttleMs`.
 * `write` receives the serialized snapshot; `flush()` writes now.
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
  const offQueries = queryClient.getQueryCache().subscribe(schedule);
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
