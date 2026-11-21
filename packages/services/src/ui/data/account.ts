/**
 * The account family's data (`@oxy.so/bloom-data`): the people this SDK reads
 * (all in `User`), the signed-in account's own settings and lists, and every
 * write to them.
 *
 * Sources and actions are module constants. Each takes the API client first
 * (`oxy`), then its arguments; the hooks in `hooks/queries/useAccountQueries.ts`
 * and `hooks/mutations/useAccountMutations.ts` pass `useOxy().oxyServices`.
 * They act on the store in scope, which is the signed-in account's: a switch
 * opens another store, so nothing here is wiped by hand, and an answer that
 * lands for the account that was left goes to its closed store and is dropped.
 *
 * Reads keep the staleness each had as a React Query query (`stale`) and the
 * SDK's shared retry rule (`sdkRead`). Writes are actions: the optimistic change
 * is a layer on the record (on `User` for the person's own fields), so a read
 * landing meanwhile cannot move what the person sees, and a failure drops the
 * layer, which is the rollback.
 */
import { action, currentStore, entity, list, source, withStore } from '@oxy.so/bloom-data';
import {
  authenticatedApiCall,
  logger,
  type AccountInvitation,
  type AccountMember,
  type AccountNode,
  type AccountRole,
  type BlockedUser,
  type ConnectedApp,
  type NotificationPreferences,
  type OxyServices,
  type PrivacySettings,
  type RestrictedUser,
  type UpdateAccountInput,
  type User as OxyUser,
  type UserPreferences,
} from '@oxy.so/core';
import type { UserProfileUpdate } from '@oxy.so/contracts';
import { activeRuntime } from '../runtime/activeRuntime';
import { sdkRead } from './readOptions';
import { normalizeUsername, storeUsers, User } from './user';
import {
  type CacheableUser,
  type CachedUser,
  clearedFieldsFromAccountUpdate,
  clearedFieldsFromProfileUpdate,
  type ClearableUserField,
  normalizeIncoming,
  toCachedUser,
} from './userRecord';

const MINUTE = 60_000;
/** The SDK's read defaults as React Query had them: 5 minutes fresh, 30 kept. */
const PROFILE_READ = { ...sdkRead, stale: 5 * MINUTE, gcTime: 30 * MINUTE } as const;

/** A person as `User` holds it: the id resolved (`fallbackId` when the payload has none), the name structured. */
function userRecord(user: CacheableUser | OxyUser, fallbackId = ''): CachedUser {
  const record = fallbackId
    ? toCachedUser(user as CacheableUser, fallbackId)
    : normalizeIncoming(user as CacheableUser);
  if (!record) throw new Error('The user has no id');
  return record;
}

// ── People ────────────────────────────────────────────────────────────────

/**
 * The signed-in account, read from the bearer (`GET /users/me`), never from a
 * session id in the URL: the request can never target another session than
 * the one the bearer is. Keyed by the account's id, so it reads into that
 * person's one record. Re-read on focus (overriding the SDK's `false`): this is
 * the only read of the owner's own preferences (languages, display currency),
 * so a change made on another device arrives when the app comes back.
 */
export const currentUser = source(User, {
  ...PROFILE_READ,
  stale: MINUTE,
  refetchOnFocus: true,
  key: (_oxy: OxyServices, userId: string) => userId,
  load: async (_request, oxy, userId) => userRecord(await oxy.users.me(), userId),
});

/** A person by id: the identity every card shows (name, avatar, handle). */
export const userById = source(User, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, userId: string) => userId,
  load: async (_request, oxy, userId) => userRecord(await oxy.users.get(userId), userId),
});

/**
 * A person by handle, found through `User`'s `username` index, so one already
 * held from a feed shows at once. That copy is sparse (no `createdAt`, no
 * viewer `relationship`) and this source never read it, so it counts as stale
 * and the full profile is read on mount, whatever the app's defaults.
 */
export const userByUsername = source(User, {
  ...PROFILE_READ,
  index: 'username',
  key: (_oxy: OxyServices, username: string) => normalizeUsername(username) ?? '',
  load: async (_request, oxy, username) =>
    userRecord(await oxy.users.byUsername(normalizeUsername(username) ?? '')),
});

/** The person a session belongs to; the person is held in `User`. */
export interface SessionUserRecord {
  /** The session id. */
  readonly id: string;
  readonly user: CachedUser | null;
}

export const SessionUser = entity<SessionUserRecord>('oxy.session-user', {
  id: (record) => record.id,
  refs: { user: User },
});

/** The person behind one session (`GET /session/user/:id`). */
export const userBySession = source(SessionUser, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, sessionId: string) => sessionId,
  load: async (_request, oxy, sessionId) => ({
    id: sessionId,
    user: userRecord(await oxy.users.bySession(sessionId)),
  }),
});

export const SessionUsers = list('oxy.session-users', { of: SessionUser });

/** The people behind many sessions, in one batch request; the list holds the session ids. */
export const usersBySessions = source(SessionUsers, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, sessionIds: readonly string[]) => sessionIds.join(','),
  load: async (_request, oxy, sessionIds) => {
    const results = await oxy.users.bySessions([...sessionIds]);
    return {
      items: results.map((result) => ({
        id: result.sessionId,
        user: result.user ? userRecord(result.user) : null,
      })),
    };
  },
});

/** A profile screen's person, with their Oxy Trust standing. */
export interface ProfileCardRecord {
  /** The person's id. */
  readonly id: string;
  readonly profile: OxyUser;
  readonly reputationTotal: number | null;
}

export const ProfileCard = entity<ProfileCardRecord>('oxy.profile-card', {
  id: (card) => card.id,
  refs: { profile: User },
});

/**
 * A person and their reputation in one read. Only the person can fail it: the
 * reputation read answers `null` instead, and the signed-in person's own
 * profile (`own`) stands in when theirs cannot be read. Never retried.
 */
export const profileCard = source(ProfileCard, {
  ...PROFILE_READ,
  retry: 0,
  key: (_oxy: OxyServices, userId: string, _own: OxyUser | null) => userId,
  load: async (_request, oxy, userId, own) => {
    const [profile, reputationTotal] = await Promise.all([
      oxy.users.get(userId).catch((error: unknown) => {
        if (own) return own;
        logger.error(
          'Profile loading error',
          error instanceof Error ? error : new Error(String(error)),
          { component: 'ProfileScreen' },
        );
        throw error;
      }),
      (own ? oxy.reputation.balance() : oxy.reputation.balance(userId))
        .then((balance) => (typeof balance.total === 'number' ? balance.total : null))
        .catch(() => null),
    ]);
    if (!profile) throw new Error('Profile data is not available');
    return { id: userId, profile, reputationTotal };
  },
});

// ── The signed-in account's settings and lists ─────────────────────────────

/** A person's privacy settings, by their user id. */
export type PrivacySettingsRecord = PrivacySettings & { readonly id: string };

export const PrivacySettingsOf = entity<PrivacySettingsRecord>('oxy.privacy-settings', {
  id: (record) => record.id,
});

export const privacySettings = source(PrivacySettingsOf, {
  ...sdkRead,
  stale: 2 * MINUTE,
  gcTime: 10 * MINUTE,
  key: (_oxy: OxyServices, _sessionId: string | null, userId: string) => userId,
  load: async (_request, oxy, sessionId, userId) => ({
    ...(await authenticatedApiCall(oxy, sessionId, () => oxy.privacy.settings(userId))),
    id: userId,
  }),
});

/** Who the signed-in account blocked and restricted, by its user id. */
export interface PrivacyListsRecord {
  readonly id: string;
  readonly blocked: readonly BlockedUser[];
  readonly restricted: readonly RestrictedUser[];
}

export const PrivacyLists = entity<PrivacyListsRecord>('oxy.privacy-lists', {
  id: (record) => record.id,
});

export const privacyLists = source(PrivacyLists, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, userId: string) => userId,
  load: async (_request, oxy, userId) => {
    const [blocked, restricted] = await Promise.all([
      oxy.privacy.blocked(),
      oxy.privacy.restricted(),
    ]);
    return { id: userId, blocked, restricted };
  },
});

/** The id a blocked or restricted entry names, embedded or not. */
function listedUserId(target: string | { _id: string }): string {
  return typeof target === 'string' ? target : target._id;
}

/** The third-party applications the account connected (`GET /auth/grants`), as one record. */
export interface ConnectedAppsRecord {
  readonly id: string;
  readonly apps: readonly ConnectedApp[];
}

export const ConnectedApps = entity<ConnectedAppsRecord>('oxy.connected-apps', {
  id: (record) => record.id,
});

/** The one key of the account's connected apps: each account has its own store. */
const CONNECTED_APPS = 'connected-apps';

export const connectedApps = source(ConnectedApps, {
  ...sdkRead,
  // Short: it drives a management screen.
  stale: 30_000,
  gcTime: 5 * MINUTE,
  key: (_oxy: OxyServices, _sessionId: string | null) => CONNECTED_APPS,
  load: async (_request, oxy, sessionId) => ({
    id: CONNECTED_APPS,
    apps: await authenticatedApiCall<ConnectedApp[]>(oxy, sessionId, () =>
      oxy.apps.connected.list(),
    ),
  }),
});

// ── Accounts the person operates (organisations, projects, bots) ───────────

/** An account-graph node; the account's own profile is held in `User`. */
export const AccountNodeOf = entity<AccountNode>('oxy.account-node', {
  id: (node) => node.accountId,
  refs: { account: User },
});

export const accountNode = source(AccountNodeOf, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: (_request, oxy, accountId) => oxy.accounts.get(accountId),
});

/**
 * Reads again what the store holds of an account, its node and its profile,
 * after a write elsewhere changed them (an organization renamed or claimed).
 */
export async function refreshAccount(oxy: OxyServices, accountId: string): Promise<void> {
  await Promise.all([
    AccountNodeOf.has(accountId) ? accountNode.refresh(oxy, accountId) : undefined,
    User.has(accountId) ? userById.refresh(oxy, accountId) : undefined,
  ]);
}

/** An account's members and pending invitations, as one record per account. */
export interface AccountRosterRecord {
  readonly id: string;
  readonly members: readonly AccountMember[];
}

export const AccountRoster = entity<AccountRosterRecord>('oxy.account-roster', {
  id: (record) => record.id,
});

export const accountRoster = source(AccountRoster, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: async (_request, oxy, accountId) => ({
    id: accountId,
    members: await oxy.accounts.members.list(accountId),
  }),
});

export interface AccountInvitationsRecord {
  readonly id: string;
  readonly invitations: readonly AccountInvitation[];
}

export const AccountInvitations = entity<AccountInvitationsRecord>('oxy.account-invitations', {
  id: (record) => record.id,
});

export const accountInvitations = source(AccountInvitations, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, accountId: string) => accountId,
  load: async (_request, oxy, accountId) => ({
    id: accountId,
    invitations: await oxy.accounts.invitations.list(accountId),
  }),
});

export const MemberProfiles = list('oxy.account-member-profiles', { of: User });

/**
 * The profiles of an account's members, written into `User`. `lookupMany`, not
 * `getMany`: a chunk that failed is unknown, not absent, so the read fails and
 * is retried rather than holding "no handle" for the whole stale window.
 */
export const memberProfiles = source(MemberProfiles, {
  ...PROFILE_READ,
  key: (_oxy: OxyServices, userIds: readonly string[]) => userIds.join(','),
  load: async (_request, oxy, userIds) => {
    const lookup = await oxy.users.lookupMany([...userIds]);
    if (lookup.failed.length > 0) throw lookup.error ?? new Error('Member profiles unavailable');
    return { items: lookup.found.map((user) => userRecord(user)) };
  },
});

/**
 * After a membership change: every held roster is read again (an inherited row
 * on a descendant's roster comes from an ancestor's members), and the account's
 * invitations and node.
 */
function refreshMembership(oxy: OxyServices, accountId: string): void {
  for (const id of AccountRoster.ids()) void accountRoster.refresh(oxy, id);
  void accountInvitations.refresh(oxy, accountId);
  void accountNode.refresh(oxy, accountId);
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Makes the request; when it fails, `recover` runs in the store the action acts on
 * (taken before the call: after an await, the store in scope is the active one).
 */
async function orRecover<T>(call: () => Promise<T>, recover: () => void): Promise<T> {
  const store = currentStore();
  try {
    return await call();
  } catch (error) {
    withStore(store, recover);
    throw error;
  }
}

/** The signed-in person's id now: the record an optimistic change to "me" is a layer on. */
function signedInId(): string | undefined {
  return activeRuntime()?.getSnapshot().account?.id;
}

/** Replaces the signed-in profile with `user`, when `user` is the signed-in person. */
function replaceSignedIn(user: OxyUser): void {
  if (signedInId() === user.id) activeRuntime()?.setAccount(user);
}

/**
 * The server's answer to a write of the signed-in person: it replaces the
 * signed-in profile, joins `User` (with the fields the write emptied), and the
 * account is read again, as React Query's invalidation did.
 */
function settleSignedIn(
  oxy: OxyServices,
  user: OxyUser,
  cleared?: readonly ClearableUserField[],
): void {
  replaceSignedIn(user);
  storeUsers(user as CacheableUser, { cleared });
  void currentUser.refresh(oxy, user.id);
}

/** Changes the signed-in person's profile (`PUT /users/me`), shown at once. */
export const updateProfile = action({
  optimistic: (_oxy, _sessionId, updates) => {
    const id = signedInId();
    if (id) User.merge(id, updates as Partial<CachedUser>);
  },
  run: (oxy: OxyServices, sessionId: string | null, updates: UserProfileUpdate) =>
    authenticatedApiCall<OxyUser>(oxy, sessionId, () => oxy.users.updateMe(updates)),
  settle: (user, oxy, _sessionId, updates) =>
    settleSignedIn(oxy, user, clearedFieldsFromProfileUpdate(updates)),
});

/** A picture file the person picked, before it is uploaded. */
export interface AvatarFile {
  uri: string;
  type?: string;
  name?: string;
  size?: number;
}

/** Uploads a new picture and makes it the person's avatar; the local file shows meanwhile. */
export const uploadAvatar = action({
  optimistic: (_oxy, _sessionId, file) => {
    const id = signedInId();
    if (id) User.merge(id, { avatar: file.uri });
  },
  run: (oxy: OxyServices, sessionId: string | null, file: AvatarFile) =>
    authenticatedApiCall<OxyUser>(oxy, sessionId, async () => {
      const uploaded = await oxy.assets.upload(file, { visibility: 'public' });
      const fileId = uploaded?.file?.id;
      if (!fileId || typeof fileId !== 'string') {
        throw new Error('Upload succeeded but response did not contain a file ID');
      }
      return oxy.users.updateMe({ avatar: fileId });
    }),
  settle: (user, oxy) => settleSignedIn(oxy, user),
});

/** Changes the signed-in person's notification preferences (`PUT /users/me`). */
export const updateNotificationPreferences = action({
  optimistic: (_oxy, _sessionId, preferences) => {
    const id = signedInId();
    if (id) User.merge(id, { notificationPreferences: preferences });
  },
  run: (
    oxy: OxyServices,
    sessionId: string | null,
    preferences: Partial<NotificationPreferences>,
  ) =>
    authenticatedApiCall<OxyUser>(oxy, sessionId, () =>
      oxy.users.updateMe({ notificationPreferences: preferences }),
    ),
  settle: (user, oxy) => settleSignedIn(oxy, user),
});

/** Changes the signed-in person's general preferences (language, theme, timezone). */
export const updateUserPreferences = action({
  optimistic: (_oxy, _sessionId, preferences) => {
    const id = signedInId();
    if (id) User.merge(id, { userPreferences: preferences });
  },
  run: (oxy: OxyServices, sessionId: string | null, preferences: Partial<UserPreferences>) =>
    authenticatedApiCall<OxyUser>(oxy, sessionId, () =>
      oxy.users.updateMe({ userPreferences: preferences }),
    ),
  settle: (user, oxy) => settleSignedIn(oxy, user),
});

/**
 * Saves the display currency for the account that chose it. An answer for
 * another account (the bearer moved meanwhile) is refused.
 */
export const saveDisplayCurrency = action({
  run: async (
    oxy: OxyServices,
    sessionId: string,
    userId: string,
    currency: NonNullable<UserPreferences['displayCurrency']>,
  ) => {
    const updated = await authenticatedApiCall(oxy, sessionId, () =>
      oxy.users.updateMe({ userPreferences: { displayCurrency: currency } }),
    );
    if (updated.id !== userId) throw new Error('Account changed. Please try again.');
    return updated;
  },
  settle: (updated, _oxy, _sessionId, userId) => {
    storeUsers(updated as CacheableUser);
    if (updated.id === userId) replaceSignedIn(updated);
  },
});

/**
 * Changes privacy settings through the dedicated endpoint (`PUT /users/me`
 * drops them). Rebuilds the person from `currentUser`, the snapshot taken when
 * the change was made, so a sibling write that settles meanwhile is not
 * overwritten by this one.
 */
export const updateAccountSettings = action({
  optimistic: (_oxy, _sessionId, currentUser, updates) => {
    User.merge(currentUser.id, { privacySettings: updates });
  },
  run: async (
    oxy: OxyServices,
    sessionId: string | null,
    currentUser: OxyUser,
    updates: Partial<PrivacySettings>,
  ) => {
    const privacy = await authenticatedApiCall<PrivacySettings>(oxy, sessionId, () =>
      oxy.privacy.updateSettings(updates, currentUser.id),
    );
    return { ...currentUser, privacySettings: privacy };
  },
  settle: (user, oxy) => {
    User.merge(user.id, { privacySettings: user.privacySettings });
    replaceSignedIn(user);
    void currentUser.refresh(oxy, user.id);
  },
});

/**
 * Changes a person's privacy settings, shown at once on their settings and on
 * their `User` record. Only the fields asked for are written; a failure drops
 * exactly those and reads the settings again, so a concurrent change that
 * settled is reconciled with the server. On success nothing is read again: the
 * merged answer is the truth (a re-read would race it).
 */
export const updatePrivacySettings = action({
  optimistic: (_oxy, _sessionId, userId, settings) => {
    if (!userId) return;
    PrivacySettingsOf.merge(userId, settings);
    User.merge(userId, { privacySettings: settings });
  },
  run: (
    oxy: OxyServices,
    sessionId: string | null,
    userId: string | undefined,
    settings: Partial<PrivacySettings>,
  ) =>
    orRecover(
      () =>
        authenticatedApiCall<PrivacySettings>(oxy, sessionId, () => {
          if (!userId) throw new Error('User ID is required');
          return oxy.privacy.updateSettings(settings, userId);
        }),
      () => {
        if (userId) void privacySettings.refresh(oxy, sessionId, userId);
      },
    ),
  settle: (answer, _oxy, _sessionId, userId) => {
    if (!userId) return;
    // Older API builds answered only the changed field: merge, the server winning where it spoke.
    const incoming = answer ?? {};
    PrivacySettingsOf.merge(userId, incoming);
    User.merge(userId, { privacySettings: incoming });
    const user = User.get(userId);
    if (user) replaceSignedIn(user as OxyUser);
  },
});

/** Revokes a connected application's grant; the list is read again. */
export const revokeConnectedApp = action({
  run: (oxy: OxyServices, sessionId: string | null, applicationId: string) =>
    authenticatedApiCall<void>(oxy, sessionId, () => oxy.apps.connected.revoke(applicationId)),
  settle: (_result, oxy, sessionId) => {
    void connectedApps.refresh(oxy, sessionId);
  },
});

/** Takes a blocked person off the account's list. */
export const unblockUser = action({
  run: (oxy: OxyServices, _ownerId: string, userId: string) => oxy.privacy.unblock(userId),
  settle: (_result, _oxy, ownerId, userId) => {
    PrivacyLists.patch(ownerId, (lists) => ({
      blocked: lists.blocked.filter((entry) => listedUserId(entry.blockedId) !== userId),
    }));
  },
});

/** Takes a restricted person off the account's list. */
export const unrestrictUser = action({
  run: (oxy: OxyServices, _ownerId: string, userId: string) => oxy.privacy.unrestrict(userId),
  settle: (_result, _oxy, ownerId, userId) => {
    PrivacyLists.patch(ownerId, (lists) => ({
      restricted: lists.restricted.filter((entry) => listedUserId(entry.restrictedId) !== userId),
    }));
  },
});

// ── Writes to an account the person operates ───────────────────────────────

/**
 * Changes an account's profile (`PATCH /accounts/:id`). Its person joins `User`
 * with the fields the write emptied, so every surface showing it follows.
 */
export const updateAccount = action({
  run: (oxy: OxyServices, accountId: string, input: UpdateAccountInput) =>
    oxy.accounts.update(accountId, input),
  settle: (node, oxy, accountId, input) => {
    storeUsers(node.account as CacheableUser, { cleared: clearedFieldsFromAccountUpdate(input) });
    AccountNodeOf.put(node);
    void accountNode.refresh(oxy, accountId);
    if (signedInId() === accountId) void currentUser.refresh(oxy, accountId);
  },
});

/** Archives an account, after the caller's own step (`before`), if any. */
export const archiveAccount = action({
  run: async (
    oxy: OxyServices,
    accountId: string,
    before: (() => Promise<void> | void) | undefined,
  ) => {
    await before?.();
    await oxy.accounts.archive(accountId);
  },
  settle: (_result, _oxy, accountId) => {
    AccountNodeOf.remove(accountId);
  },
});

export type AssignableRole = Exclude<AccountRole, 'owner'>;

/** Invites someone to an account by email; the rosters are read again either way. */
export const inviteMember = action({
  run: (oxy: OxyServices, accountId: string, input: { email: string; role: AssignableRole }) =>
    orRecover(
      () => oxy.accounts.invitations.create(accountId, input),
      () => refreshMembership(oxy, accountId),
    ),
  settle: (_invitation, oxy, accountId) => refreshMembership(oxy, accountId),
});

export const updateMemberRole = action({
  run: (oxy: OxyServices, accountId: string, memberId: string, role: AssignableRole) =>
    oxy.accounts.members.update(accountId, memberId, { role }),
  settle: (_member, oxy, accountId) => refreshMembership(oxy, accountId),
});

export const removeMember = action({
  run: (oxy: OxyServices, accountId: string, memberId: string) =>
    oxy.accounts.members.remove(accountId, memberId),
  settle: (_result, oxy, accountId) => refreshMembership(oxy, accountId),
});

export const transferOwnership = action({
  run: (oxy: OxyServices, accountId: string, userId: string) =>
    oxy.accounts.transferOwnership(accountId, { userId }),
  settle: (_result, oxy, accountId) => refreshMembership(oxy, accountId),
});

/** Sends a pending invitation again, or cancels it; the invitations are read again. */
export const changeInvitation = action({
  run: async (
    oxy: OxyServices,
    accountId: string,
    invitationId: string,
    change: 'resend' | 'cancel',
  ) => {
    if (change === 'resend') await oxy.accounts.invitations.resend(accountId, invitationId);
    else await oxy.accounts.invitations.cancel(accountId, invitationId);
  },
  settle: (_result, oxy, accountId) => {
    void accountInvitations.refresh(oxy, accountId);
  },
});
