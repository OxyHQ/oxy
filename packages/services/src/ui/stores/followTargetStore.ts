/**
 * The follow-graph store — the client's single cache authority for #809.
 *
 * The SDK caches none of these reads on purpose (a status cached across a write
 * is the "follow reverts after navigating away and back" bug), which makes this
 * store the one place a status lives between a write and the next read. If a
 * second cache appears above it, the two will disagree the moment one is
 * invalidated and the other is not.
 *
 * ## Keyed by target id, not by user id
 *
 * The legacy `followStore` is keyed by user id because the only followable
 * thing was a user. Here a key is a target of any kind — a topic, a store, an
 * artist, a channel — so nothing in this file may assume what it is looking at.
 * That is the property that lets an application the SDK has never heard of use
 * it without a release.
 *
 * ## Why the status is stored whole
 *
 * Not a boolean. `globalState`, `applicationMode` and `effectiveState` are
 * three separate answers, and a UI that keeps only the last one cannot explain
 * why a follow the user can see in their list does nothing in this app.
 */

import { create } from 'zustand';
import type { FollowApplicationMode, FollowRecord, FollowStatus } from '@oxyhq/contracts';

/** The status of one target, or `undefined` when it has never been read. */
type StatusMap = Record<string, FollowStatus | undefined>;

interface FollowTargetState {
  statuses: StatusMap;
  /** In-flight writes, per target. Reads do not set this — only mutations do. */
  pending: Record<string, boolean>;
  errors: Record<string, string | undefined>;

  setStatus: (targetId: string, status: FollowStatus) => void;
  /**
   * Seed many statuses at once — from a follow list, a feed payload, anything
   * that already knows. Saves one request per rendered row, which is the
   * difference between a list that paints and a list that flickers.
   */
  seed: (entries: Record<string, FollowStatus>) => void;
  setPending: (targetId: string, pending: boolean) => void;
  setError: (targetId: string, error: string | undefined) => void;
  /** Drop everything. Called on identity change — see the note below. */
  reset: () => void;
}

/**
 * The state one target is in before the server has been asked. Distinct from
 * "not following": a button that renders a follow action while the answer is
 * unknown invites a follow the user did not intend, so callers check
 * `isUnknown` rather than reading this as an answer.
 */
export const UNKNOWN_FOLLOW_STATUS: FollowStatus = {
  globalState: 'none',
  applicationMode: 'inherit',
  effectiveState: 'not_following',
};

export const useFollowTargetStore = create<FollowTargetState>((set) => ({
  statuses: {},
  pending: {},
  errors: {},

  setStatus: (targetId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [targetId]: status } })),

  seed: (entries) => set((s) => ({ statuses: { ...s.statuses, ...entries } })),

  setPending: (targetId, pending) =>
    set((s) => ({ pending: { ...s.pending, [targetId]: pending } })),

  setError: (targetId, error) => set((s) => ({ errors: { ...s.errors, [targetId]: error } })),

  // Every entry here is scoped to whoever was signed in when it was read. On an
  // account switch the whole map is wrong, not stale — the next user's follows
  // are a different set entirely, and showing one user their previous
  // account's follow state is a privacy failure rather than a rendering one.
  reset: () => set({ statuses: {}, pending: {}, errors: {} }),
}));

/**
 * Whether the user follows this at all, anywhere.
 *
 * Deliberately NOT `effectiveState !== 'not_following'`: a follow switched off
 * in this application reports `not_following` — correctly, since the question
 * that field answers is "does this act here" — and a button that read it as
 * "not followed" would offer to follow something already followed.
 */
export function isFollowedGlobally(status: FollowStatus): boolean {
  return status.globalState === 'active' || status.globalState === 'requested';
}

/**
 * Whether a cached status is safe to act on without a round trip.
 *
 * List payloads often carry `globalState` without `relationshipId`. Treating
 * that as authoritative would leave disable/unfollow as no-ops forever.
 */
export function isCompleteFollowStatus(status: FollowStatus): boolean {
  if (isFollowedGlobally(status)) return Boolean(status.relationshipId);
  return true;
}

/** Convert one list row into the status shape the follow-target store expects. */
export function followRecordToStatus(record: FollowRecord): FollowStatus {
  return {
    relationshipId: record.relationshipId,
    globalState: record.globalState,
    applicationMode: record.applicationMode,
    effectiveState: record.effectiveState,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
}

/**
 * Bulk-convert a follow list page into a status map keyed by target id — the
 * input shape for `useFollowTargetStore.getState().seed(...)`.
 */
export function followRecordsToStatusMap(records: FollowRecord[]): Record<string, FollowStatus> {
  const entries: Record<string, FollowStatus> = {};
  for (const record of records) {
    entries[record.target.id] = followRecordToStatus(record);
  }
  return entries;
}

/**
 * Apply a mode change to a cached status without a round trip.
 *
 * Exported because the optimistic path and the settled path must agree on what
 * `effectiveState` becomes; deriving it in two places is how they drift. Mirrors
 * the server's own derivation, which is the authority.
 */
export function withApplicationMode(
  status: FollowStatus,
  mode: FollowApplicationMode
): FollowStatus {
  return {
    ...status,
    applicationMode: mode,
    effectiveState:
      mode === 'disabled'
        ? 'not_following'
        : status.globalState === 'active'
          ? 'following'
          : status.globalState === 'requested'
            ? 'requested'
            : 'not_following',
  };
}
