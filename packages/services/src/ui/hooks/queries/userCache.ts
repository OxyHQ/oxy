/**
 * Canonical user-cache UPSERT for the Oxy React Query cache, and the funnel
 * into the `User` entity of `@oxy.so/bloom-data`.
 *
 * Many places across an app write a user object, each carrying a DIFFERENT
 * (often sparse) slice of it. One upsert MERGES (`data/userRecord.ts` holds
 * the rules) under both keys the SDK's user hooks read from:
 *   - by-id:       `queryKeys.users.detail(id)`             (read by `useUserById`)
 *   - by-username: `queryKeys.users.byUsername(username, viewerId)` (viewer-scoped;
 *                  read by `useUserByUsername`, carries the viewer `relationship`)
 * and into `User`, the one copy every app entity refers to (`refs: { user: User }`).
 *
 * No existing entry: the incoming object is seeded STALE (`updatedAt: 0`) so the
 * hook refetches the full authoritative profile. Existing entry: merged, its
 * freshness untouched. A deliberate clear is declared with `{ cleared: [...] }`.
 */

import type { QueryClient } from '@tanstack/react-query';
import { storeUsers } from '../../data/user';
import {
  type CacheableUser,
  type CachedUser,
  type ClearableUserField,
  mergeUsers,
  normalizeIncoming,
  toCachedUser,
  type UpsertCachedUserOptions,
} from '../../data/userRecord';
import { useAuthStore } from '../../stores/authStore';
import { queryKeys } from './queryKeys';

export {
  CLEARABLE_USER_FIELDS,
  clearedFieldsFromAccountUpdate,
  clearedFieldsFromProfileUpdate,
} from '../../data/userRecord';
export type {
  CacheableUser,
  ClearableUserField,
  UpsertCachedUserOptions,
} from '../../data/userRecord';

/** Merge-upsert a normalized user into one cache key (see module docs for semantics). */
function upsertOneKey(
  queryClient: QueryClient,
  key: readonly unknown[],
  incoming: CachedUser,
  options: {
    includeRelationship: boolean;
    cleared?: readonly ClearableUserField[];
  },
): void {
  const mergeOpts = {
    includeRelationship: options.includeRelationship,
    cleared: options.cleared,
  };
  const existing = queryClient.getQueryData<CacheableUser>(key);
  if (existing === undefined) {
    // Cold slot: seed the full incoming object, STALE, so react-query refetches
    // the full authoritative profile (relationship, counts, createdAt, …).
    const seeded = mergeUsers({ id: incoming.id }, incoming, mergeOpts);
    queryClient.setQueryData<CachedUser>(key, seeded, { updatedAt: 0 });
    return;
  }
  // Existing entry: merge and leave its freshness lifecycle untouched. The
  // existing entry is keyed by `incoming.id`, so use it as the fallback id.
  const merged = mergeUsers(toCachedUser(existing, incoming.id), incoming, mergeOpts);
  const dataUpdatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
  queryClient.setQueryData<CachedUser>(key, merged, {
    updatedAt: dataUpdatedAt,
  });
}

/**
 * Resolve the active viewer id. The by-username cache key is viewer-scoped; the
 * seed must land on the exact key `useUserByUsername` reads. When a caller does
 * not pass `viewerId`, read it from the auth store — the same store behind the
 * hook's `useOxy().user?.id`, so seed and read stay in lockstep. An explicit
 * empty string is honoured (anonymous scope).
 */
function resolveViewerId(viewerId?: string): string {
  return viewerId ?? useAuthStore.getState().user?.id ?? '';
}

/**
 * Merge-upsert a (possibly partial) user into the SDK's user query cache under
 * both the by-id key and, when a username is present, the viewer-scoped
 * by-username key.
 *
 * @param queryClient The app's React Query client.
 * @param user        A `User`-shaped object (may be sparse).
 * @param viewerId    The active viewer id for the by-username key. Defaults to
 *                    the current auth-store user id.
 * @param options     `cleared` names the fields the write deliberately emptied
 *                    — the ONLY way "remove my picture" can propagate, since a
 *                    cleared field and an uncarried one are byte-identical on
 *                    the wire (see the module docs).
 */
export function upsertCachedUser(
  queryClient: QueryClient,
  user: CacheableUser,
  viewerId?: string,
  options?: UpsertCachedUserOptions,
): void {
  storeUsers(user, options);
  upsertQueryCache(queryClient, user, resolveViewerId(viewerId), options?.cleared);
}

/**
 * Batch merge-upsert many users at once (for a feed / list / search response).
 * Resolves the viewer id once and upserts each user cumulatively — a user that
 * appears twice merges both slices into the single cache entry.
 *
 * Takes NO `cleared`, deliberately: a batch is a multi-user projection, so it is
 * exactly the sparse source the anti-degradation guard exists for, and one
 * declaration could not be true of every user in the array anyway.
 */
export function upsertCachedUsers(
  queryClient: QueryClient,
  users: readonly CacheableUser[] | null | undefined,
  viewerId?: string,
): void {
  if (!Array.isArray(users) || users.length === 0) return;
  storeUsers(users);
  const resolvedViewerId = resolveViewerId(viewerId);
  for (const user of users) {
    if (user) upsertQueryCache(queryClient, user, resolvedViewerId);
  }
}

/** The React Query half of an upsert: the by-id key, and the by-username key when there is a username. */
function upsertQueryCache(
  queryClient: QueryClient,
  user: CacheableUser,
  viewerId: string,
  cleared?: readonly ClearableUserField[],
): void {
  const incoming = normalizeIncoming(user);
  if (!incoming) return;

  // By-id identity entry (read by `useUserById`). Not viewer-scoped — never store
  // the viewer-relative `relationship` here or one viewer's follow state leaks
  // into every other viewer's by-id cache entry.
  upsertOneKey(queryClient, queryKeys.users.detail(incoming.id), incoming, {
    includeRelationship: false,
    cleared,
  });

  const username = incoming.username;
  if (typeof username === 'string' && username.trim() !== '') {
    // By-username entry (read by `useUserByUsername`). Viewer-scoped because the
    // authenticated single-profile fetch embeds the viewer `relationship`. Build
    // the key through the SAME helper the hook uses so username normalization
    // (`trim().toLowerCase()`) matches byte-for-byte.
    const key = queryKeys.users.byUsername(username, viewerId);
    upsertOneKey(queryClient, key, incoming, {
      includeRelationship: true,
      cleared,
    });
  }
}
