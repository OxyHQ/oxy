import { useEffect } from 'react';
import {
  type ListView,
  type RecordView,
  skip,
  useActionStatus,
  useEntity,
  useList,
  useRecord,
} from '@oxy.so/bloom-data';
import type { User } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAuthStore } from '../../stores/authStore';
import {
  type ConnectedAppsRecord,
  connectedApps,
  currentUser,
  type PrivacySettingsRecord,
  privacySettings,
  type SessionUserRecord,
  userById,
  userBySession,
  userByUsername,
  usersBySessions,
} from '../../data/account';
import { User as UserEntity } from '../../data/user';

/**
 * The account family's reads. Each is a `@oxy.so/bloom-data` source
 * (`data/account.ts`) observed for its arguments, or skipped while they are not
 * known (React Query's `enabled: false`). Every person they read is held once in
 * `User`, so a write anywhere reaches every view of that person.
 */

/** A read of one person: the record (a read-only view of `User`) and its state. */
export type UserView = RecordView<User>;

/** A person read as the `User` record holds it: the shape every Oxy user has, possibly sparse. */
function asUserView(view: RecordView<unknown>): UserView {
  return view as UserView;
}

/**
 * The person behind a session (`GET /session/user/:id`). `value` is the session's
 * record; its `user` is the person.
 */
export const useUserProfile = (
  sessionId: string | null,
  options?: { enabled?: boolean },
): RecordView<SessionUserRecord> => {
  const { oxyServices } = useOxy();
  return useRecord(
    userBySession,
    ...(options?.enabled !== false && sessionId ? ([oxyServices, sessionId] as const) : [skip]),
  );
};

/**
 * The people behind many sessions, in one batch request. `ids` are the session
 * ids; each is a `SessionUser` record whose `user` is the person.
 */
export const useUsersBySessions = (
  sessionIds: string[],
  options?: { enabled?: boolean },
): ListView<unknown> => {
  const { oxyServices } = useOxy();
  return useList(
    usersBySessions,
    ...(options?.enabled !== false && sessionIds.length > 0
      ? ([oxyServices, sessionIds] as const)
      : [skip]),
  );
};

/**
 * The signed-in account, read from the bearer (`GET /users/me`), never from a
 * session id in the URL: during a switch the URL's session and the bearer could
 * disagree, and the read 404'd.
 *
 * Until it is read, `value` is the signed-in profile the session already holds
 * (what React Query's `initialData` gave).
 *
 * The record is mirrored into the session's signed-in profile (`useOxy().user`),
 * so fields only this read carries (`createdAt`, `updatedAt`, preferences)
 * reach every consumer, with two guards:
 * - not while an action is in flight: its optimistic layer is showing, and the
 *   action writes the final profile itself when it settles;
 * - not when the profile held has a strictly newer `updatedAt`: a late read
 *   racing a completed write.
 */
export const useCurrentUser = (options?: { enabled?: boolean }): UserView => {
  const { oxyServices, activeSessionId, isAuthenticated, user } = useOxy();
  const userId =
    options?.enabled !== false && isAuthenticated && activeSessionId && user?.id
      ? user.id
      : undefined;
  const view = asUserView(
    useRecord(currentUser, ...(userId ? ([oxyServices, userId] as const) : [skip])),
  );
  const record = useEntity(UserEntity, view.status === 'success' ? userId : undefined, plain);
  const { pending, paused } = useActionStatus();
  const writing = pending + paused > 0;

  useEffect(() => {
    if (!record || writing) return;
    // Missing or unreadable `updatedAt` on either side falls through to the
    // mirror: the in-flight guard above is the primary defence.
    const incoming = parseUpdatedAt(record.updatedAt);
    const held = parseUpdatedAt(useAuthStore.getState().user?.updatedAt);
    if (incoming !== null && held !== null && incoming < held) return;
    useAuthStore.getState().setUser(record as User);
  }, [record, writing]);

  const seed = isAuthenticated && user ? user : undefined;
  return view.value === undefined && seed ? { ...view, value: seed } : view;
};

/** The record as a plain object, for the mirror (a read-only view must not leave the hook). */
function plain<T>(record: T): T {
  return record;
}

/**
 * Best-effort parser for the `updatedAt` representations the API returns (ISO
 * string, epoch number, Date). `null` when it is not a finite timestamp.
 */
function parseUpdatedAt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * A person by id: the card-identity workhorse (name, avatar, handle), meant for
 * lists of many. Each account has its own store, so the viewer-relative
 * `relationship` on the record is always the signed-in viewer's.
 */
export const useUserById = (userId: string | null, options?: { enabled?: boolean }): UserView => {
  const { oxyServices } = useOxy();
  return asUserView(
    useRecord(
      userById,
      ...(options?.enabled !== false && userId ? ([oxyServices, userId] as const) : [skip]),
    ),
  );
};

/**
 * A person by handle, for a single profile view. A copy already held (a feed
 * author) shows at once; the full profile, with the viewer `relationship` and
 * `createdAt`, is read on mount unless this read is under 5 minutes old.
 */
export const useUserByUsername = (
  username: string | null,
  options?: { enabled?: boolean },
): UserView => {
  const { oxyServices } = useOxy();
  return asUserView(
    useRecord(
      userByUsername,
      ...(options?.enabled !== false && username ? ([oxyServices, username] as const) : [skip]),
    ),
  );
};

/**
 * The third-party OAuth applications the account connected through consent
 * (`GET /auth/grants`), for the "Connected apps" screen. `value.apps` lists them.
 */
export const useConnectedApps = (options?: {
  enabled?: boolean;
}): RecordView<ConnectedAppsRecord> => {
  const { oxyServices, activeSessionId, isAuthenticated } = useOxy();
  return useRecord(
    connectedApps,
    ...(options?.enabled !== false && isAuthenticated
      ? ([oxyServices, activeSessionId] as const)
      : [skip]),
  );
};

/**
 * A person's privacy settings; without an id, the ACTIVE account's (the account
 * switched into), matching the privacy settings screen.
 */
export const usePrivacySettings = (
  userId?: string,
  options?: { enabled?: boolean },
): RecordView<PrivacySettingsRecord> => {
  const { oxyServices, activeSessionId, user } = useOxy();
  const targetUserId = userId || user?.id;
  return useRecord(
    privacySettings,
    ...(options?.enabled !== false && targetUserId
      ? ([oxyServices, activeSessionId, targetUserId] as const)
      : [skip]),
  );
};
