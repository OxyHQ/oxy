/**
 * User Service
 *
 * Business logic layer for user-related operations.
 * Separates route handlers from business logic for better testability and maintainability.
 *
 * ## What the Postgres port changed
 *
 * - **`users.following[]` / `followers[]` and `_count` are GONE.** `user_follows`
 *   is the single authority and every total is a `count(*)` over it. The wire
 *   still carries `_count: { followers, following }`; it is now a MEASUREMENT,
 *   so it cannot drift from the edges the way a denormalized counter did — and
 *   follow/unfollow no longer has counter maintenance to get wrong.
 * - **`followType` is gone from every filter.** `Follow` was polymorphic in name
 *   only; see `db/schema/userFollows.ts` for the evidence that no non-`user`
 *   edge was ever written.
 * - **`Types.ObjectId.isValid` guards are gone.** They existed to stop a
 *   Mongoose `CastError`; a `text` id simply matches no rows, so a malformed id
 *   takes the identical "no such user" path it always produced.
 */

import { and, eq, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type Database } from '../config/postgres';
import { blocks } from '../db/schema/blocks';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { restrictions } from '../db/schema/restrictions';
import { userAncestors } from '../db/schema/userAncestors';
import { userFollows } from '../db/schema/userFollows';
import { userLinkMetadata } from '../db/schema/userLinkMetadata';
import { USER_LOCATION_TYPES, userLocations } from '../db/schema/userLocations';
import { ACCOUNT_KINDS, ACCOUNT_STATUSES, USER_TYPES, users } from '../db/schema/users';
import { userVerifiedDomains } from '../db/schema/userVerifiedDomains';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import securityActivityService from './securityActivityService';
import { sanitizeProfileUpdate } from '../utils/sanitize';
import {
  normalizeLinks,
  normalizeLinksMetadata,
  normalizeLocations,
  normalizeProfileName,
} from '../utils/profileTextNormalization';
import { normalizeUsername } from '../utils/username';
import { BadRequestError } from '../utils/error';
import { Request } from 'express';
import {
  PaginatedResponse,
  PublicUserProfile,
  ProfileUpdateInput,
  UserStatistics,
  FollowActionResult,
  ViewerGraph,
  FollowGraphParams,
  FollowGraphSort,
  DEFAULT_FOLLOW_GRAPH_SORT,
} from '../types/user.types';
import {
  publicUserColumns,
  publicUserFollowCounts,
  toPublicUserView,
  type LinkMetadataDto,
  type PublicUserRow,
  type PublicUserView,
} from '../utils/publicUserProjection';
import { assertColorNotReserved, normalizeUserColor } from '../utils/profileColor';
import { userIdentityFields, deriveIsFederated, toThemePreference } from '../utils/userTransform';
import { DISPLAY_NAME_INVALID_MESSAGE, isValidDisplayName, normalizeLocale } from '@oxyhq/core';
import { buildUserDid } from './did.service';
import {
  isAccountKind,
  isValidUsername,
  USERNAME_INVALID_MESSAGE,
  type UserRelationship,
} from '@oxyhq/contracts';
import type { NameParts } from '../utils/displayName';

// Constants
import { PAGINATION } from '../utils/constants';
import {
  MAX_FOLLOWING_FOR_MUTUALS,
  MAX_MUTUAL_IDS,
  MAX_FOLLOWS_OF_FOLLOWS_IDS,
  MAX_FOF_FIRST_HOP,
  MAX_FOLLOWING_IDS,
  MAX_BLOCKED_IDS,
} from '../utils/recommendationWeights';
import graphCache from '../utils/graphCache';
import blockCache, { restrictCache } from '../utils/blockCache';
import { discoverableUserPredicate } from '../utils/profileQuery';

/**
 * A profile as its OWNER sees it — the public view plus the fields
 * `formatUserResponse` emits only under `includePrivateFields`.
 */
export interface SelfUserView extends PublicUserView {
  phone?: string;
  address?: string;
  birthday?: string;
  themePreference?: { mode: 'light' | 'dark' | 'system'; colorPreset: string };
}

/**
 * The minimal surface {@link UserService.formatUserResponse} reads.
 *
 * Every property is `unknown` so ANY caller shape is structurally assignable
 * with no cast — the same technique `UserIdentitySource` already uses in
 * `utils/userTransform.ts`, and the reason this serializer needs no knowledge of
 * which query produced its input. The producers in this package are
 * {@link PublicUserView} and {@link SelfUserView}.
 */
export interface UserResponseSource {
  _id?: unknown;
  /** Present on objects whose identifier was already folded into `id`. */
  id?: unknown;
  username?: unknown;
  name?: unknown;
  avatar?: unknown;
  publicKey?: unknown;
  verified?: unknown;
  bio?: unknown;
  description?: unknown;
  color?: unknown;
  links?: unknown;
  linksMetadata?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  phone?: unknown;
  address?: unknown;
  birthday?: unknown;
  themePreference?: unknown;
  type?: unknown;
  /** Account-graph classification (`personal` / `organization` / `channel` …). */
  kind?: unknown;
  federation?: unknown;
  privacySettings?: unknown;

  // ---- flat Drizzle columns, accepted for the SAME reason `userIdentityFields`
  // accepts `nameFirst`/`nameLast` (`utils/userTransform.ts`): this function
  // takes a structurally-permissive input, so a caller that hands it a raw
  // `users` row does not fail tsc — it would silently emit no `federation` and
  // an unconditional `fediverseSharing: true`. Both are wire contract. Accepting
  // both shapes in the one serializer beats each ported batch reassembling the
  // object and drifting.
  nameFirst?: unknown;
  nameLast?: unknown;
  nameDisplay?: unknown;
  federationActorUri?: unknown;
  federationDomain?: unknown;
  privacyFediverseSharing?: unknown;
  themePreferenceMode?: unknown;
  themePreferenceColorPreset?: unknown;
}

/**
 * `ORDER BY` for a follow-graph page.
 *
 * The edge id is a REQUIRED tiebreak, not decoration: `created_at` alone is not
 * unique (two follows landing in the same instant tie), and an unstable sort
 * under `OFFSET`/`LIMIT` lets a tied row appear on two consecutive pages while
 * another is skipped entirely. `user_follows.id` is unique, so the composite key
 * is a STRICT TOTAL ORDER and paging is deterministic. It is mirrored with the
 * primary key so `oldest` is the exact reverse of `recent`.
 */
const FOLLOW_GRAPH_ORDER: Record<FollowGraphSort, SQL[]> = {
  recent: [sql`${userFollows.createdAt} desc`, sql`${userFollows.id} desc`],
  oldest: [sql`${userFollows.createdAt} asc`, sql`${userFollows.id} asc`],
};

/** Which side of a follow edge names the counterparty being listed. */
type FollowUserEdgeField = 'followerId' | 'followedId';

/**
 * Paginate follow edges whose counterparty user is not archived or in the
 * punitive `restricted` reputation tier. Counts and pages on visible users
 * only so `total` / `hasMore` stay accurate after tombstoned/restricted
 * accounts are filtered out of discovery lists.
 *
 * Mongo needed a `$lookup` + `$unwind` + a second `$match` for the eligibility
 * half; here it is an ordinary inner join, and the SORT still precedes
 * OFFSET/LIMIT so it orders the full match set rather than the page.
 */
async function paginateActiveFollowUserIds(
  db: Database,
  edgePredicate: SQL,
  userIdField: FollowUserEdgeField,
  limit: number,
  offset: number,
  sort: FollowGraphSort = DEFAULT_FOLLOW_GRAPH_SORT,
): Promise<{ userIds: string[]; total: number }> {
  const counterparty = userFollows[userIdField];
  const where = and(edgePredicate, discoverableUserPredicate());

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(userFollows)
    .innerJoin(users, eq(users.id, counterparty))
    .where(where);

  const total = countRow?.total ?? 0;
  if (total === 0) {
    return { userIds: [], total: 0 };
  }

  const pageRows = await db
    .select({ userId: counterparty })
    .from(userFollows)
    .innerJoin(users, eq(users.id, counterparty))
    .where(where)
    .orderBy(...FOLLOW_GRAPH_ORDER[sort])
    .offset(offset)
    .limit(limit);

  return { total, userIds: pageRows.map((row) => row.userId) };
}

/** Drop archived/restricted ids while preserving the caller's ordering. */
async function filterDiscoverableUserIds(db: Database, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), discoverableUserPredicate()));

  const eligible = new Set(rows.map((row) => row.id));
  return userIds.filter((id) => eligible.has(id));
}

/** Load a page of public rows and return them in the id order supplied. */
async function loadPublicUsersInOrder(
  db: Database,
  orderedIds: string[]
): Promise<PublicUserView[]> {
  if (orderedIds.length === 0) return [];

  const rows = await db
    .select(publicUserColumns)
    .from(users)
    .where(inArray(users.id, orderedIds));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: PublicUserView[] = [];
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (row) ordered.push(toPublicUserView(row));
  }
  return ordered;
}

/**
 * Per-target outcome of a bulk follow operation.
 * - `success: true, alreadyFollowing: false`  → newly followed
 * - `success: true, alreadyFollowing: true`   → already followed (no-op / raced)
 * - `success: false, alreadyFollowing: false` → non-existent user, or self
 */
export interface BulkFollowEntry {
  userId: string;
  success: boolean;
  alreadyFollowing: boolean;
}

/**
 * Result contract for `bulkFollow`. `followedCount` counts ONLY follows that
 * were newly created by this call (excludes already-following and raced
 * duplicate inserts).
 */
export interface BulkFollowResult {
  results: BulkFollowEntry[];
  followedCount: number;
}

/**
 * Per-target outcome of a bulk unfollow operation.
 * - `success: true, wasFollowing: true`   → was followed and has been removed
 * - `success: true, wasFollowing: false`  → valid id that wasn't followed
 *   (desired end state already holds — not following)
 * - `success: false, wasFollowing: false` → the caller's own id
 */
export interface BulkUnfollowEntry {
  userId: string;
  success: boolean;
  wasFollowing: boolean;
}

/**
 * Result contract for `bulkUnfollow`. `unfollowedCount` counts ONLY follows that
 * were actually removed by this call.
 */
export interface BulkUnfollowResult {
  results: BulkUnfollowEntry[];
  unfollowedCount: number;
}

/** Follower/following totals for the two sides of a follow edge. */
export interface FollowCounts {
  followers: number;
  following: number;
}

/**
 * Result of the `followUser` primitive. `created` is `true` only when THIS call
 * inserted the edge; a repeated call on an already-existing edge is an
 * idempotent no-op that reports `created: false`.
 */
export interface FollowUserResult {
  created: boolean;
  counts: FollowCounts;
}

/**
 * Result of the `unfollowUser` primitive. `removed` is `true` only when THIS
 * call deleted the edge; unfollowing an edge that does not exist is an
 * idempotent no-op that reports `removed: false`.
 */
export interface UnfollowUserResult {
  removed: boolean;
  counts: FollowCounts;
}

/**
 * Normalize a profile `color` value with the SAME canonicalization the write
 * below applies. `normalizeUserColor` is shared with the account graph, which
 * writes this column too, so the two paths cannot canonicalize differently and
 * disagree about what the reserved-color gate is looking at. Non-string values
 * are passed through untouched for the caller's own handling.
 */
function normalizeProfileColor(value: unknown): unknown {
  return typeof value === 'string' ? normalizeUserColor(value) : value;
}

/**
 * Canonicalize ONE profile-update field into exactly the form that will be
 * persisted. Every field whose value carries human- or third-party-authored text
 * is normalized here, at the single write chokepoint, so no caller can store a
 * value that a client would then render with `white-space: pre-wrap` intact.
 *
 * `bio` / `description` / `address` and the other free-text fields are already
 * normalized upstream by `sanitizeProfileUpdate` (which delegates to the
 * canonical multiline normalizer); the fields listed here are the ones it
 * deliberately skips because they are structured, not plain strings.
 *
 * Fields with no text of their own (avatar id, birthday, preference objects,
 * …) pass through untouched.
 */
function normalizeProfileField(key: string, value: unknown): unknown {
  switch (key) {
    case 'color':
      return normalizeProfileColor(value);
    case 'name':
      return normalizeProfileName(value);
    case 'username':
      return typeof value === 'string' ? normalizeUsername(value) : value;
    case 'linksMetadata':
      return normalizeLinksMetadata(value);
    case 'locations':
      return normalizeLocations(value);
    case 'links':
      return normalizeLinks(value);
    default:
      return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `federation` subdocument rebuilt from a FLAT `users` row, or `undefined`
 * when the row carries no federation data — which is what a local account's
 * absent Mongo subdocument meant, and what `formatUserResponse` tests for.
 */
function flatFederation(
  source: { federationActorUri?: unknown; federationDomain?: unknown }
): { actorUri?: string; domain?: string } | undefined {
  const actorUri = stringOrUndefined(source.federationActorUri);
  const domain = stringOrUndefined(source.federationDomain);
  return actorUri || domain ? { actorUri, domain } : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `Mongoose` stored an absent optional string as `''` on several of these
 * columns; the schema stores NULL. Both mean "not set", and a write of either
 * must land as NULL so the two states cannot coexist.
 */
function blankToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value;
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Every column of `users` a self-view reads — the public set plus the four
 * owner-only fields. `phone` is named EXPLICITLY: it is a protected column
 * (`db/schema/protectedColumns.ts`), so naming it is how a caller opts in, and
 * that opt-in is greppable exactly because there is no helper for it.
 */
const selfUserColumns = {
  ...publicUserColumns,
  phone: users.phone,
  address: users.address,
  birthday: users.birthday,
  themePreferenceMode: users.themePreferenceMode,
  themePreferenceColorPreset: users.themePreferenceColorPreset,
} as const;

type SelfUserRow = PublicUserRow & {
  phone: string | null;
  address: string | null;
  birthday: string | null;
  themePreferenceMode: 'light' | 'dark' | 'system' | null;
  themePreferenceColorPreset: string | null;
};

/**
 * Flat self row → the owner-facing view.
 *
 * The theme preference is emitted only when BOTH halves are present, which the
 * `users_theme_preference_check` constraint already makes the only
 * representable state — the check here is what keeps the DTO honest for rows
 * the backfill mapped from a partial Mongo subdocument.
 */
function toSelfUserView(row: SelfUserRow): SelfUserView {
  const view: SelfUserView = {
    ...toPublicUserView(row),
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    birthday: row.birthday ?? undefined,
  };
  if (row.themePreferenceMode !== null && row.themePreferenceColorPreset !== null) {
    view.themePreference = {
      mode: row.themePreferenceMode,
      colorPreset: row.themePreferenceColorPreset,
    };
  }
  return view;
}

/**
 * The privacy settings, wire key → column.
 *
 * Mongo held these as ONE nested `privacySettings` subdocument, so a read was a
 * projection and a write was a set of dot-paths. They are 22 flat `boolean`
 * columns here (`db/schema/users.ts` explains why a 1:1 child table would have
 * bought a join on every profile read for nothing), which makes this map the
 * single place the wire's nesting is unwound — read and write both go through
 * it, so a key can never be readable and unwritable, or vice versa.
 */
const PRIVACY_SETTING_COLUMNS = {
  isPrivateAccount: users.privacyIsPrivateAccount,
  hideOnlineStatus: users.privacyHideOnlineStatus,
  hideLastSeen: users.privacyHideLastSeen,
  profileVisibility: users.privacyProfileVisibility,
  loginAlerts: users.privacyLoginAlerts,
  blockScreenshots: users.privacyBlockScreenshots,
  login: users.privacyLogin,
  biometricLogin: users.privacyBiometricLogin,
  showActivity: users.privacyShowActivity,
  allowTagging: users.privacyAllowTagging,
  allowMentions: users.privacyAllowMentions,
  hideReadReceipts: users.privacyHideReadReceipts,
  allowDirectMessages: users.privacyAllowDirectMessages,
  dataSharing: users.privacyDataSharing,
  locationSharing: users.privacyLocationSharing,
  analyticsSharing: users.privacyAnalyticsSharing,
  sensitiveContent: users.privacySensitiveContent,
  autoFilter: users.privacyAutoFilter,
  muteKeywords: users.privacyMuteKeywords,
  discoverableByEmail: users.privacyDiscoverableByEmail,
  discoverableByPhone: users.privacyDiscoverableByPhone,
  fediverseSharing: users.privacyFediverseSharing,
} as const;

/** A privacy toggle's wire name. */
export type PrivacySettingKey = keyof typeof PRIVACY_SETTING_COLUMNS;

/** The full privacy-settings object, exactly as the two endpoints return it. */
export type PrivacySettingsResponse = Record<PrivacySettingKey, boolean>;

/** The TS property name of the `users` column each toggle is stored in. */
const PRIVACY_SETTING_PROPERTIES: Record<PrivacySettingKey, string> = {
  isPrivateAccount: 'privacyIsPrivateAccount',
  hideOnlineStatus: 'privacyHideOnlineStatus',
  hideLastSeen: 'privacyHideLastSeen',
  profileVisibility: 'privacyProfileVisibility',
  loginAlerts: 'privacyLoginAlerts',
  blockScreenshots: 'privacyBlockScreenshots',
  login: 'privacyLogin',
  biometricLogin: 'privacyBiometricLogin',
  showActivity: 'privacyShowActivity',
  allowTagging: 'privacyAllowTagging',
  allowMentions: 'privacyAllowMentions',
  hideReadReceipts: 'privacyHideReadReceipts',
  allowDirectMessages: 'privacyAllowDirectMessages',
  dataSharing: 'privacyDataSharing',
  locationSharing: 'privacyLocationSharing',
  analyticsSharing: 'privacyAnalyticsSharing',
  sensitiveContent: 'privacySensitiveContent',
  autoFilter: 'privacyAutoFilter',
  muteKeywords: 'privacyMuteKeywords',
  discoverableByEmail: 'privacyDiscoverableByEmail',
  discoverableByPhone: 'privacyDiscoverableByPhone',
  fediverseSharing: 'privacyFediverseSharing',
};

/**
 * The whole account, nested exactly as the Mongo document was.
 *
 * Two endpoints return the raw document rather than a DTO — `GET /users/me/data`
 * (the account-data download) and `PUT /users/resolve` (the federation upsert) —
 * and both are consumed by code that reads the document's OWN key names. The
 * schema is flat (`name_first`, `federation_domain`, `privacy_*`, …) and the
 * embedded arrays are child tables, so this is where both are put back.
 *
 * `_id` is present ALONGSIDE `id`, which is the documented contract
 * (`@oxyhq/contracts` `resolveUserId` = `user.id ?? user._id`): these responses
 * never went through the model's `toJSON`, so they carried both. `id` reproduces
 * the model's `id` virtual (`publicKey ?? _id`) and `did` its `did` virtual.
 */
export interface AccountDocument {
  /**
   * The ACCOUNT ID (`users.id`) — unconditionally, on this document and on
   * `req.user`. Distinct from {@link AccountDocument.id} below, which is the
   * model's old `id` virtual and is the PUBLIC KEY whenever the account has
   * one. `middleware/auth.ts` documents why the authenticated call sites read
   * this one.
   */
  _id: string;
  /** The old `id` virtual: `publicKey ?? _id`. NOT reliably the account id. */
  id: string;
  did: string;

  /**
   * The fields below are the ones the REQUEST PATH reads off `req.user`, and
   * they are declared rather than left to the index signature for a specific
   * reason: `middleware/auth.ts` used to attach this value through an
   * `as IUser & Document` cast, so `tsc` checked none of these reads. Removing
   * the cast without declaring them would have turned each into an `unknown`
   * error at the call site; declaring them is what makes the reads CHECKED
   * instead — the values were always these types, only the type was missing.
   *
   * Everything else stays behind the index signature: this document carries the
   * whole account, and enumerating all of it here would be a second copy of the
   * schema that drifts.
   */
  username?: string;
  email?: string;
  publicKey?: string;
  avatar?: string;
  name: { first?: string; last?: string; displayName?: string };
  kind: (typeof ACCOUNT_KINDS)[number];
  type: (typeof USER_TYPES)[number];
  accountStatus: (typeof ACCOUNT_STATUSES)[number];
  isStaff: boolean;
  verified: boolean;
  federation: { actorUri?: string; domain?: string };
  privacySettings: PrivacySettingsResponse;
  createdAt: Date;
  updatedAt: Date;

  [key: string]: unknown;
}

/**
 * Every `users` column a self-document read may carry — the whole table minus
 * the protected set (`db/schema/protectedColumns.ts`), which is precisely what
 * Mongoose's `select: false` withheld from these two reads.
 */
const accountDocumentColumns = publicColumns(users, PROTECTED_COLUMNS_BY_TABLE);

export class UserService {
  /**
   * The account's full privacy settings, or null when no such account exists.
   *
   * Every key is always present: the columns are `NOT NULL` with defaults, so
   * the "field absent on an old document" state Mongo could produce no longer
   * exists.
   */
  async readPrivacySettings(userId: string): Promise<PrivacySettingsResponse | null> {
    const [row] = await getDb()
      .select(PRIVACY_SETTING_COLUMNS)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Merge a PARTIAL privacy-settings patch and return the whole updated object.
   *
   * Only the keys the caller supplied are written — the same semantics Mongo's
   * dot-path `$set` had, and the reason it could not be a whole-subdocument
   * replace: that would wipe every toggle the client did not send.
   *
   * @returns The updated settings, or null when no such account exists.
   */
  async updatePrivacySettings(
    userId: string,
    settings: Partial<PrivacySettingsResponse>
  ): Promise<PrivacySettingsResponse | null> {
    const columnUpdates: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== 'boolean') continue;
      const property = PRIVACY_SETTING_PROPERTIES[key as PrivacySettingKey];
      if (property) columnUpdates[property] = value;
    }

    if (Object.keys(columnUpdates).length > 0) {
      const [updated] = await getDb()
        .update(users)
        .set(columnUpdates)
        .where(eq(users.id, userId))
        .returning(PRIVACY_SETTING_COLUMNS);
      if (!updated) return null;
      // Bust the in-memory user cache so the next `getUserBySession` serves the
      // fresh settings instead of the stale snapshot. Without this the client
      // refetch on mutation success silently reverts the toggle.
      userCache.invalidate(userId);
      return updated;
    }

    return this.readPrivacySettings(userId);
  }

  /**
   * The whole account as a document — see {@link AccountDocument}.
   *
   * Five queries because five tables hold what Mongo held in one document; they
   * run in parallel and this is a single-account read, so the fan-out is
   * constant, not per-row.
   */
  async readAccountDocument(userId: string): Promise<AccountDocument | null> {
    const db = getDb();

    const [rows, ancestorRows, locationRows, linkRows, domainRows] = await Promise.all([
      db.select(accountDocumentColumns).from(users).where(eq(users.id, userId)).limit(1),
      db
        .select({ ancestorId: userAncestors.ancestorId })
        .from(userAncestors)
        .where(eq(userAncestors.userId, userId))
        .orderBy(userAncestors.depth),
      db
        .select()
        .from(userLocations)
        .where(eq(userLocations.userId, userId))
        .orderBy(userLocations.createdAt),
      db
        .select()
        .from(userLinkMetadata)
        .where(eq(userLinkMetadata.userId, userId))
        .orderBy(userLinkMetadata.position),
      db
        .select({
          domain: userVerifiedDomains.domain,
          verifiedAt: userVerifiedDomains.verifiedAt,
          method: userVerifiedDomains.method,
        })
        .from(userVerifiedDomains)
        .where(eq(userVerifiedDomains.userId, userId)),
    ]);

    const row = rows[0];
    if (!row) return null;

    return {
      _id: row.id,
      // The model's `id` virtual: the public key when the account has one,
      // otherwise the account id.
      id: row.publicKey ?? row.id,
      did: buildUserDid(row.id),
      username: row.username ?? undefined,
      email: row.email ?? undefined,
      publicKey: row.publicKey ?? undefined,
      name: {
        first: row.nameFirst ?? undefined,
        last: row.nameLast ?? undefined,
        displayName: row.nameDisplay ?? undefined,
      },
      kind: row.kind,
      // Ordered, primary first — never reordered on the way out.
      accountCategories: row.accountCategories,
      parentAccountId: row.parentAccountId ?? undefined,
      rootAccountId: row.rootAccountId ?? undefined,
      ancestors: ancestorRows.map((ancestor) => ancestor.ancestorId),
      accountStatus: row.accountStatus,
      type: row.type,
      federation: flatFederation(row) ?? {},
      automation: row.automationOwnerId ? { ownerId: row.automationOwnerId } : {},
      verified: row.verified,
      reputationRankWeight: row.reputationRankWeight,
      reputationTier: row.reputationTier,
      isStaff: row.isStaff,
      isSeedVerifier: row.isSeedVerifier,
      isSensitive: row.isSensitive,
      languages: row.languages,
      avatar: row.avatar ?? undefined,
      color: row.color,
      bio: row.bio ?? undefined,
      description: row.description ?? undefined,
      address: row.address ?? undefined,
      birthday: row.birthday ?? undefined,
      links: row.links ?? undefined,
      linksMetadata: linkRows.map((link) => ({
        url: link.url,
        title: link.title,
        description: link.description,
        image: link.image ?? undefined,
      })),
      locations: locationRows.map((location) => ({
        id: location.locationKey,
        name: location.name,
        label: location.label ?? undefined,
        type: location.type,
        address: {
          street: location.street ?? undefined,
          streetNumber: location.streetNumber ?? undefined,
          streetDetails: location.streetDetails ?? undefined,
          postalCode: location.postalCode ?? undefined,
          city: location.city ?? undefined,
          state: location.state ?? undefined,
          country: location.country ?? undefined,
          formattedAddress: location.formattedAddress ?? undefined,
        },
        coordinates:
          location.latitude !== null && location.longitude !== null
            ? { lat: location.latitude, lon: location.longitude }
            : undefined,
        metadata: {
          placeId: location.placeId ?? undefined,
          osmId: location.osmId ?? undefined,
          osmType: location.osmType ?? undefined,
          countryCode: location.countryCode ?? undefined,
          timezone: location.timezone ?? undefined,
        },
        createdAt: location.createdAt,
        updatedAt: location.updatedAt,
      })),
      verifiedDomains: domainRows,
      accountExpiresAfterInactivityDays: row.accountExpiresAfterInactivityDays ?? undefined,
      privacySettings: {
        isPrivateAccount: row.privacyIsPrivateAccount,
        hideOnlineStatus: row.privacyHideOnlineStatus,
        hideLastSeen: row.privacyHideLastSeen,
        profileVisibility: row.privacyProfileVisibility,
        loginAlerts: row.privacyLoginAlerts,
        blockScreenshots: row.privacyBlockScreenshots,
        login: row.privacyLogin,
        biometricLogin: row.privacyBiometricLogin,
        showActivity: row.privacyShowActivity,
        allowTagging: row.privacyAllowTagging,
        allowMentions: row.privacyAllowMentions,
        hideReadReceipts: row.privacyHideReadReceipts,
        allowDirectMessages: row.privacyAllowDirectMessages,
        dataSharing: row.privacyDataSharing,
        locationSharing: row.privacyLocationSharing,
        analyticsSharing: row.privacyAnalyticsSharing,
        sensitiveContent: row.privacySensitiveContent,
        autoFilter: row.privacyAutoFilter,
        muteKeywords: row.privacyMuteKeywords,
        discoverableByEmail: row.privacyDiscoverableByEmail,
        discoverableByPhone: row.privacyDiscoverableByPhone,
        fediverseSharing: row.privacyFediverseSharing,
      },
      autoReply: {
        enabled: row.autoReplyEnabled,
        subject: row.autoReplySubject ?? undefined,
        body: row.autoReplyBody ?? undefined,
        startDate: row.autoReplyStartDate ?? undefined,
        endDate: row.autoReplyEndDate ?? undefined,
      },
      notificationPreferences: {
        pushEnabled: row.notificationPushEnabled,
        emailDigest: row.notificationEmailDigest,
        securityAlerts: row.notificationSecurityAlerts,
        marketingEmails: row.notificationMarketingEmails,
      },
      userPreferences: {
        language: row.preferenceLanguage ?? undefined,
        theme: row.preferenceTheme,
        reduceMotion: row.preferenceReduceMotion,
        timezone: row.preferenceTimezone ?? undefined,
      },
      themePreference:
        row.themePreferenceMode !== null && row.themePreferenceColorPreset !== null
          ? { mode: row.themePreferenceMode, colorPreset: row.themePreferenceColorPreset }
          : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Load a single account by id, as its owner sees it.
   */
  async getUserById(userId: string): Promise<SelfUserView | null> {
    const [row] = await getDb()
      .select(selfUserColumns)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? toSelfUserView(row) : null;
  }

  /**
   * Load a single public profile row by id — inclusion-only projection.
   */
  async getPublicUserById(userId: string): Promise<PublicUserView | null> {
    const [row] = await getDb()
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? toPublicUserView(row) : null;
  }

  /**
   * Get current authenticated user.
   *
   * Identical to {@link getUserById}; kept as its own name because the two
   * callers mean different things by it and the endpoint contracts differ.
   */
  async getCurrentUser(userId: string): Promise<SelfUserView | null> {
    return this.getUserById(userId);
  }

  /**
   * Update user profile.
   *
   * Filters the input to an allowlist, validates each field at the boundary
   * (display name, color/premium gate, account locales, expiry), then writes the
   * account row and its two child collections in ONE transaction — a profile
   * edit that touched `links` and `locations` must not be able to half-apply.
   */
  async updateUserProfile(
    userId: string,
    updates: ProfileUpdateInput,
    req?: Request
  ): Promise<SelfUserView> {
    const db = getDb();

    // Allowed fields for updates
    const allowedFields = [
      'name',
      'email',
      'username',
      'avatar',
      'color',
      'bio',
      'description',
      'phone',
      'address',
      'birthday',
      'links',
      'linksMetadata',
      'locations',
      'languages',
      'accountExpiresAfterInactivityDays',
      'notificationPreferences',
      'userPreferences',
      'themePreference',
    ] as const;

    // Reject invalid native display names (letters/spaces/apostrophe/separators).
    // Federated writes strip silently via cleanDisplayName; native edits get a
    // 400 so the user corrects the name at the source. Runs BEFORE sanitization
    // so the validation sees the user's raw input.
    if (updates.name && typeof updates.name === 'object') {
      for (const part of ['first', 'last', 'displayName'] as const) {
        const value = updates.name[part];
        if (typeof value === 'string' && !isValidDisplayName(value)) {
          throw new BadRequestError(DISPLAY_NAME_INVALID_MESSAGE);
        }
      }
    }

    // Sanitize text fields to prevent XSS
    const sanitizedUpdates = sanitizeProfileUpdate(updates as Record<string, unknown>) as ProfileUpdateInput;

    // Filter and validate updates
    const filteredUpdates: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(sanitizedUpdates)) {
      if (!(allowedFields as readonly string[]).includes(key)) continue;

      if (key === 'avatar') {
        if (typeof value === 'string') {
          filteredUpdates.avatar = value;
        }
        continue;
      }

      // Canonicalize the value into EXACTLY the form that will be persisted,
      // before it is validated or compared — see `normalizeProfileField`.
      const normalizedValue = normalizeProfileField(key, value);

      // Reserved colors are checked against the SAME normalized value the write
      // below persists (trim + lowercase), so ' oxy '/'OXY' cannot slip past the
      // gate. The rule itself lives in `utils/profileColor` because the account
      // graph writes this column too — see its header.
      if (key === 'color' && typeof normalizedValue === 'string') {
        await assertColorNotReserved(normalizedValue, { accountId: userId, username: null });
      }

      // Account locales — the ONLY language field (no singular `language`). Each
      // entry must resolve to a supported BCP-47 locale; we persist the CANONICAL
      // `language-REGION` form (`normalizeLocale`) with order preserved and
      // duplicates dropped, and reject anything unsupported at the boundary with a
      // structured 400.
      if (key === 'languages') {
        if (!Array.isArray(value)) {
          throw new BadRequestError('languages must be an array of locale codes', {
            field: 'languages',
          });
        }
        const normalizedLocales: string[] = [];
        for (const entry of value) {
          const canonical = typeof entry === 'string' ? normalizeLocale(entry) : undefined;
          if (!canonical) {
            throw new BadRequestError('Unsupported locale', {
              field: 'languages',
              value: entry,
            });
          }
          if (!normalizedLocales.includes(canonical)) {
            normalizedLocales.push(canonical);
          }
        }
        filteredUpdates.languages = normalizedLocales;
        continue;
      }

      // Portable theme preference — validate the shape at the boundary and
      // persist EXACTLY `{ mode, colorPreset }` (trimmed preset), rejecting an
      // unknown mode or an empty preset with a structured 400.
      if (key === 'themePreference') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new BadRequestError('themePreference must be an object', {
            field: 'themePreference',
          });
        }
        const { mode, colorPreset } = value as Record<string, unknown>;
        if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
          throw new BadRequestError('themePreference.mode must be one of: light, dark, system', {
            field: 'themePreference',
          });
        }
        if (typeof colorPreset !== 'string' || colorPreset.trim().length === 0) {
          throw new BadRequestError('themePreference.colorPreset must be a non-empty string', {
            field: 'themePreference',
          });
        }
        filteredUpdates.themePreference = { mode, colorPreset: colorPreset.trim() };
        continue;
      }

      // Validate accountExpiresAfterInactivityDays
      if (key === 'accountExpiresAfterInactivityDays') {
        if (value !== null && value !== undefined) {
          const validValues = [30, 90, 180, 365];
          if (!validValues.includes(value as number)) {
            throw new Error('accountExpiresAfterInactivityDays must be 30, 90, 180, 365, or null');
          }
        }
      }

      // Assign other fields
      filteredUpdates[key] = normalizedValue;
    }

    const existing = await this.getUserById(userId);
    if (!existing) {
      throw new Error('User not found');
    }

    // A username is a routing key (`/@alice`, `acct:alice@…`), not prose: it must
    // satisfy the ONE policy every write path enforces, which in particular
    // admits no whitespace at all. Only an actual CHANGE is validated: clients
    // that PUT the whole profile back echo the stored username, and a value that
    // predates this policy must not make an unrelated bio edit fail. That
    // asymmetry is the write-not-read rule in miniature, and it is deliberate.
    const nextUsername = filteredUpdates.username;
    if (
      typeof nextUsername === 'string' &&
      nextUsername !== existing.username &&
      !isValidUsername(nextUsername)
    ) {
      throw new BadRequestError(USERNAME_INVALID_MESSAGE, { field: 'username' });
    }

    // Validate uniqueness constraints
    await this.validateUniqueFields(userId, filteredUpdates);

    // Track email change for security logging
    const nextEmail = stringOrUndefined(filteredUpdates.email);
    const [existingEmailRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const oldEmail = existingEmailRow?.email ?? undefined;
    const emailChanged = !!nextEmail && nextEmail !== oldEmail;

    const columnUpdates = buildUserColumnUpdates(filteredUpdates);
    const locations = Array.isArray(filteredUpdates.locations)
      ? filteredUpdates.locations
      : undefined;
    const linksMetadata = Array.isArray(filteredUpdates.linksMetadata)
      ? filteredUpdates.linksMetadata
      : undefined;

    // One transaction: the account row and its two child collections either all
    // move or none do. Mongo could only offer this through a replica-set
    // transaction the deployment might not support, so the code carried a
    // session-less fallback; there is no such fallback here.
    await db.transaction(async (tx) => {
      if (Object.keys(columnUpdates).length > 0) {
        await tx.update(users).set(columnUpdates).where(eq(users.id, userId));
      }

      if (locations) {
        await tx.delete(userLocations).where(eq(userLocations.userId, userId));
        const rows = locations
          .map((entry, index) => toLocationRow(userId, entry, index))
          .filter((row): row is NonNullable<typeof row> => row !== null);
        if (rows.length > 0) {
          await tx.insert(userLocations).values(rows);
        }
      }

      if (linksMetadata) {
        await tx.delete(userLinkMetadata).where(eq(userLinkMetadata.userId, userId));
        const rows = linksMetadata
          .map((entry, index) => toLinkMetadataRow(userId, entry, index))
          .filter((row): row is NonNullable<typeof row> => row !== null);
        if (rows.length > 0) {
          await tx.insert(userLinkMetadata).values(rows);
        }
      }
    });

    // Invalidate the in-memory user cache so the next session-bound lookup
    // (getUserBySession, validateSessionById) re-reads from Postgres and
    // serves the just-updated avatar/name/etc. Without this, the cache
    // returns the pre-write document and clients see their update silently
    // revert on the next refetch.
    userCache.invalidate(userId);

    // Log security events
    try {
      const updatedFields = Object.keys(filteredUpdates);

      // Log email change if it occurred
      if (emailChanged && oldEmail && nextEmail) {
        await securityActivityService.logEmailChange(userId, oldEmail, nextEmail, req);
      }

      // Log profile update (excluding email which is logged separately)
      const profileFields = updatedFields.filter(field => field !== 'email');
      if (profileFields.length > 0) {
        await securityActivityService.logProfileUpdate(userId, profileFields, req);
      }
    } catch (error) {
      // Don't fail the update if logging fails
      logger.error('Failed to log security event for profile update:', error);
    }

    const updated = await this.getUserById(userId);
    if (!updated) {
      throw new Error('User not found');
    }
    return updated;
  }

  /**
   * Validate unique fields (email, username).
   *
   * Both lookups are written against the EXPRESSION their unique index is built
   * on — `lower(btrim(...))`, see `db/schema/users.ts`. A plain `email = $1` is
   * correct-looking, case-sensitive, and would let ` Alice@x.com ` through to
   * fail as a 500 on the constraint instead of a 400 here.
   */
  private async validateUniqueFields(
    userId: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    const db = getDb();

    const email = stringOrUndefined(updates.email);
    if (email) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(btrim(${users.email})) = lower(btrim(${email}))`,
            ne(users.id, userId)
          )
        )
        .limit(1);
      if (existing) {
        throw new Error('Email already exists');
      }
    }

    const username = stringOrUndefined(updates.username);
    if (username) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(btrim(${users.username})) = lower(btrim(${username}))`,
            ne(users.id, userId)
          )
        )
        .limit(1);
      if (existing) {
        throw new Error('Username already exists');
      }
    }
  }

  /**
   * Get user followers with pagination and ordering
   */
  async getUserFollowers(
    userId: string,
    params: FollowGraphParams = {}
  ): Promise<PaginatedResponse<PublicUserProfile>> {
    const db = getDb();
    const limit = Math.min(
      params.limit || PAGINATION.DEFAULT_LIMIT,
      PAGINATION.MAX_LIMIT
    );
    const offset = params.offset || 0;

    const { userIds: followerIds, total } = await paginateActiveFollowUserIds(
      db,
      eq(userFollows.followedId, userId),
      'followerId',
      limit,
      offset,
      params.sort,
    );

    const followers = await loadPublicUsersInOrder(db, followerIds);

    return {
      data: followers.map((user) => this.formatUserResponse(user)),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /**
   * Get user following with pagination and ordering
   */
  async getUserFollowing(
    userId: string,
    params: FollowGraphParams = {}
  ): Promise<PaginatedResponse<PublicUserProfile>> {
    const db = getDb();
    const limit = Math.min(
      params.limit || PAGINATION.DEFAULT_LIMIT,
      PAGINATION.MAX_LIMIT
    );
    const offset = params.offset || 0;

    const { userIds: followingIds, total } = await paginateActiveFollowUserIds(
      db,
      eq(userFollows.followerId, userId),
      'followedId',
      limit,
      offset,
      params.sort,
    );

    const following = await loadPublicUsersInOrder(db, followingIds);

    return {
      data: following.map((user) => this.formatUserResponse(user)),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /**
   * Get the MUTUAL followers between a viewer and a target user — "followers you
   * know": users U such that the VIEWER follows U AND U follows `targetUserId`.
   *
   * Optional-viewer semantics (the viewer id is always derived server-side from
   * the auth token by the route, never from a client param):
   * - No viewer (anonymous caller, or a service token with no user context) ⇒
   *   there is no "you follow" set, so the result is an empty page.
   * - A self-target (`viewerId === targetUserId`) has no mutuals with itself ⇒
   *   empty page.
   *
   * The viewer's following set is bounded to the same window the recommendation
   * pipeline uses (`MAX_FOLLOWING_FOR_MUTUALS`) so the `IN` stays small. The
   * returned page mirrors `getUserFollowers`: ordered by `params.sort`
   * (most-recent mutual first by default), public DTOs via
   * `formatUserResponse`, and the same `{ data, total, hasMore, limit, offset }`
   * shape.
   */
  async getUserMutuals(
    viewerId: string | undefined,
    targetUserId: string,
    params: FollowGraphParams = {}
  ): Promise<PaginatedResponse<PublicUserProfile>> {
    const db = getDb();
    const limit = Math.min(
      params.limit || PAGINATION.DEFAULT_LIMIT,
      PAGINATION.MAX_LIMIT
    );
    const offset = params.offset || 0;

    const empty = (): PaginatedResponse<PublicUserProfile> => ({
      data: [],
      total: 0,
      hasMore: false,
      limit,
      offset,
    });

    // No viewer ⇒ no "you follow" set; self ⇒ no mutuals with yourself.
    if (!viewerId || viewerId === targetUserId) {
      return empty();
    }

    // 1. The viewer's following set V (bounded — mirrors the recommendations
    //    mutual-overlap window so the `IN` below stays small).
    const viewerFollowing = await db
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, viewerId))
      .limit(MAX_FOLLOWING_FOR_MUTUALS);

    const followingIds = viewerFollowing.map((follow) => follow.followedId);
    if (followingIds.length === 0) {
      return empty();
    }

    // 2. Mutuals = the target's followers who are also in V.
    const { userIds: mutualIds, total } = await paginateActiveFollowUserIds(
      db,
      and(
        eq(userFollows.followedId, targetUserId),
        inArray(userFollows.followerId, followingIds)
      ) ?? sql`false`,
      'followerId',
      limit,
      offset,
      params.sort,
    );
    if (total === 0) {
      return empty();
    }

    const mutuals = await loadPublicUsersInOrder(db, mutualIds);

    return {
      data: mutuals.map((user) => this.formatUserResponse(user)),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /**
   * Get the VIEWER's OWN mutual-follow user ids — the accounts the viewer follows
   * that ALSO follow the viewer back (a bidirectional follow edge). This is the
   * SELF intersection `following(viewer) ∩ followers(viewer)`.
   *
   * Distinct from {@link getUserMutuals} ("followers you know" about ANOTHER
   * profile, which returns hydrated DTOs and is empty for a self-target). This
   * method is lean and ids-only on purpose: it SEEDS Mention's "Mutuals" feed,
   * which then hydrates and ranks the mutuals' posts itself, so shipping bare ids
   * (not profile DTOs) keeps the payload small.
   *
   * The viewer id is ALWAYS derived server-side by the route (`resolveViewerId`),
   * never a client param. An anonymous caller (or a service token with no user
   * context) has no "you follow" set ⇒ empty. A viewer who follows nobody
   * short-circuits before the second query.
   *
   * Bounded by `MAX_MUTUAL_IDS`: both the following window scanned AND the number
   * of ids returned are capped, so the `IN` and the payload stay small. When the
   * viewer has more mutuals than the cap, the most-recently-established mutuals
   * are returned first (`created_at` desc).
   */
  async getMutualUserIds(
    viewerId: string | undefined,
    params: { limit?: number } = {}
  ): Promise<string[]> {
    if (!viewerId) {
      return [];
    }

    const db = getDb();
    const limit = Math.min(
      params.limit && params.limit > 0 ? params.limit : MAX_MUTUAL_IDS,
      MAX_MUTUAL_IDS
    );

    // 1. The viewer's following set (bounded so the `IN` below stays small).
    const viewerFollowing = await db
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, viewerId))
      .limit(MAX_MUTUAL_IDS);

    const followingIds = viewerFollowing.map((follow) => follow.followedId);
    if (followingIds.length === 0) {
      return [];
    }

    // 2. Of those, the accounts that follow the viewer BACK — the bidirectional
    //    edges — most-recently-established first.
    const mutualFollows = await db
      .select({ followerId: userFollows.followerId })
      .from(userFollows)
      .where(
        and(
          eq(userFollows.followedId, viewerId),
          inArray(userFollows.followerId, followingIds)
        )
      )
      .orderBy(sql`${userFollows.createdAt} desc`, sql`${userFollows.id} desc`)
      .limit(limit);

    return filterDiscoverableUserIds(
      db,
      mutualFollows.map((follow) => follow.followerId),
    );
  }

  /**
   * Get the authenticated VIEWER's OWN social graph — the accounts they follow,
   * the subset who follow back (mutuals), and the accounts they have blocked or
   * restricted — as ONE ids-only payload.
   *
   * Consolidates four per-viewer graph reads consuming apps (Mention, Allo,
   * Homiio) previously made as separate round trips into a single service call,
   * so the consolidated `GET /users/me/graph` endpoint can serve (and cache) the
   * whole graph in one request. Each sub-read REUSES the existing logic: the same
   * following query as {@link getUserFollowing}, the same bidirectional
   * intersection as {@link getMutualUserIds}, and the same block/restriction
   * reads the privacy routes use. The four sub-reads run in PARALLEL — they are
   * independent queries.
   *
   * The viewer id is ALWAYS derived server-side by the route (`resolveViewerId`),
   * never a client param. An anonymous caller (or a service token with no user
   * context) has no graph ⇒ every list is empty.
   *
   * Every list is bounded (`MAX_FOLLOWING_IDS` / `MAX_MUTUAL_IDS` /
   * `MAX_BLOCKED_IDS`) so the queries and the payload stay small regardless of
   * how large the viewer's graph is. Bare ids only — no hydrated DTOs, no
   * `_count` — because the consumer hydrates/ranks itself.
   */
  async getViewerGraph(
    viewerId: string | undefined,
    opts: {
      followingLimit?: number;
      mutualLimit?: number;
      blockedLimit?: number;
    } = {}
  ): Promise<ViewerGraph> {
    if (!viewerId) {
      return { followingIds: [], mutualIds: [], blockedIds: [], restrictedIds: [] };
    }

    const db = getDb();
    const followingLimit = Math.min(
      opts.followingLimit && opts.followingLimit > 0
        ? opts.followingLimit
        : MAX_FOLLOWING_IDS,
      MAX_FOLLOWING_IDS
    );
    const blockedLimit = Math.min(
      opts.blockedLimit && opts.blockedLimit > 0
        ? opts.blockedLimit
        : MAX_BLOCKED_IDS,
      MAX_BLOCKED_IDS
    );

    const [followingPage, mutualIds, blockedIds, restrictedIds] = await Promise.all([
      // Following — same eligibility filter as getUserFollowing, ids-only.
      paginateActiveFollowUserIds(
        db,
        eq(userFollows.followerId, viewerId),
        'followedId',
        followingLimit,
        0,
      ).then((page) => page.userIds),

      // Mutuals — reuse the canonical bidirectional intersection so there is a
      // single source of truth for "mutual" semantics and caps.
      this.getMutualUserIds(viewerId, { limit: opts.mutualLimit }),

      // Blocked — the same read the privacy routes use, ids-only and bounded.
      db
        .select({ blockedId: blocks.blockedId })
        .from(blocks)
        .where(eq(blocks.userId, viewerId))
        .limit(blockedLimit)
        .then((rows) => rows.map((row) => row.blockedId)),

      // Restricted — the asymmetric counterpart of the block list, read the
      // same way. Delegated callers have no user token for `/privacy/restricted`
      // (that router is user-auth only), so this is the only server-side read
      // of the viewer's restrictions they can make.
      db
        .select({ restrictedId: restrictions.restrictedId })
        .from(restrictions)
        .where(eq(restrictions.userId, viewerId))
        .limit(blockedLimit)
        .then((rows) => rows.map((row) => row.restrictedId)),
    ]);

    return { followingIds: followingPage, mutualIds, blockedIds, restrictedIds };
  }

  /**
   * Get the VIEWER's bounded "follows-of-follows" user ids — the union of the
   * accounts followed by the accounts the viewer follows (a two-hop walk of the
   * follow graph), MINUS the viewer's own follows and the viewer themselves.
   * This SEEDS Mention's friends-of-friends feed, which hydrates and ranks the
   * posts itself, so the payload is lean and ids-only — mirroring
   * {@link getMutualUserIds}.
   *
   * Bounded so the fan-out cannot blow up:
   *  - the viewer's following set (used for exclusion) is scanned most-recent
   *    first and capped at `MAX_FOLLOWS_OF_FOLLOWS_IDS`;
   *  - only the `MAX_FOF_FIRST_HOP` most-recent of those follows seed the second
   *    hop, so the `IN` over the follow table stays small no matter how many
   *    accounts the viewer follows;
   *  - the returned set is capped at `MAX_FOLLOWS_OF_FOLLOWS_IDS`.
   *
   * Ordering: candidates are ranked by how many of the viewer's sampled follows
   * follow each one (frequency — the strongest friends-of-friends signal), with
   * the most-recently-established edge breaking ties (recency).
   */
  async getFollowsOfFollowsIds(
    viewerId: string | undefined,
    params: { limit?: number } = {}
  ): Promise<string[]> {
    if (!viewerId) {
      return [];
    }

    const db = getDb();
    const limit = Math.min(
      params.limit && params.limit > 0 ? params.limit : MAX_FOLLOWS_OF_FOLLOWS_IDS,
      MAX_FOLLOWS_OF_FOLLOWS_IDS
    );

    // 1. The viewer's following set, most-recent first. Bounded so both the
    //    exclusion set and the first-hop seed stay small.
    const viewerFollowing = await db
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, viewerId))
      .orderBy(sql`${userFollows.createdAt} desc`, sql`${userFollows.id} desc`)
      .limit(MAX_FOLLOWS_OF_FOLLOWS_IDS);

    const followingIds = viewerFollowing.map((follow) => follow.followedId);
    if (followingIds.length === 0) {
      return [];
    }

    // 2. Seed the second hop with only the most-recent follows to cap the
    //    fan-out. Everything the viewer already follows, plus the viewer, is
    //    excluded from the result — a follow-of-follow the viewer already
    //    follows is not a recommendation.
    const firstHopIds = followingIds.slice(0, MAX_FOF_FIRST_HOP);
    const excludeIds = [viewerId, ...followingIds];

    // 3. Union of the accounts THOSE follows follow, ranked by how many of the
    //    viewer's follows follow each candidate (frequency), then recency.
    const rows = await db
      .select({
        id: userFollows.followedId,
        followerCount: sql<number>`count(*)::int`,
        lastFollowedAt: sql<Date>`max(${userFollows.createdAt})`,
      })
      .from(userFollows)
      .innerJoin(users, eq(users.id, userFollows.followedId))
      .where(
        and(
          inArray(userFollows.followerId, firstHopIds),
          notInArray(userFollows.followedId, excludeIds),
          discoverableUserPredicate()
        )
      )
      .groupBy(userFollows.followedId)
      .orderBy(sql`count(*) desc`, sql`max(${userFollows.createdAt}) desc`)
      .limit(limit);

    return rows.map((row) => row.id);
  }

  /**
   * Read the current follower/following totals for the two sides of a follow
   * edge. Called AFTER a follow/unfollow mutation so the returned counts reflect
   * the post-write state.
   *
   * A MEASUREMENT, not a cached counter: the `_count` subdocument the Mongo
   * version read is gone, so these two numbers cannot disagree with the edges.
   */
  private async readFollowCounts(
    targetId: string,
    followerId: string
  ): Promise<FollowCounts> {
    const db = getDb();
    const [followers, following] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(userFollows)
        .where(eq(userFollows.followedId, targetId)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(userFollows)
        .where(eq(userFollows.followerId, followerId)),
    ]);

    return {
      followers: followers[0]?.n ?? 0,
      following: following[0]?.n ?? 0,
    };
  }

  /** Whether both ids name a real account. */
  private async bothUsersExist(a: string, b: string): Promise<boolean> {
    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [a, b]));
    return rows.length === 2;
  }

  /**
   * Idempotently create a follow edge from `followerId` to `targetId`.
   *
   * `ON CONFLICT DO NOTHING ... RETURNING` is the atomic arbiter of
   * "created vs already-following": a concurrent duplicate insert returns no
   * row and is treated as a no-op. This replaces the E11000 catch entirely —
   * the duplicate is no longer an error to classify, it is an empty result.
   */
  async followUser(
    followerId: string,
    targetId: string
  ): Promise<FollowUserResult> {
    if (followerId === targetId) {
      throw new Error('Cannot follow yourself');
    }

    if (!(await this.bothUsersExist(followerId, targetId))) {
      throw new Error('User not found');
    }

    const inserted = await getDb()
      .insert(userFollows)
      .values({ followerId, followedId: targetId })
      .onConflictDoNothing()
      .returning({ id: userFollows.id });

    const created = inserted.length === 1;

    if (created) {
      // The follow edge changed both sides' cached graph: the follower's
      // `followingIds`, and — because a follow can complete a bidirectional
      // edge — either side's `mutualIds`. Invalidate BOTH (mutuals are
      // symmetric) so the next `GET /users/me/graph` recomputes fresh truth.
      // No-op when the edge already existed (nothing changed) or when Redis is
      // unconfigured; invalidation errors are swallowed inside graphCache.
      await Promise.all([
        graphCache.invalidate(followerId),
        graphCache.invalidate(targetId),
      ]);
      // `'graph'` — only the follow counts moved. Identity is untouched, so this
      // is not broadcast to other backends; follows are far too frequent to put
      // on a channel every Oxy service subscribes to.
      userCache.invalidate(followerId, 'graph');
      userCache.invalidate(targetId, 'graph');
    }

    const counts = await this.readFollowCounts(targetId, followerId);
    return { created, counts };
  }

  /**
   * Idempotently remove a follow edge from `followerId` to `targetId`.
   *
   * `DELETE ... RETURNING` reports whether a row was actually removed, so
   * unfollowing an edge that does not exist is a safe no-op.
   */
  async unfollowUser(
    followerId: string,
    targetId: string
  ): Promise<UnfollowUserResult> {
    if (followerId === targetId) {
      throw new Error('Cannot follow yourself');
    }

    if (!(await this.bothUsersExist(followerId, targetId))) {
      throw new Error('User not found');
    }

    const deleted = await getDb()
      .delete(userFollows)
      .where(
        and(
          eq(userFollows.followerId, followerId),
          eq(userFollows.followedId, targetId)
        )
      )
      .returning({ id: userFollows.id });

    const removed = deleted.length === 1;

    if (removed) {
      // Symmetric to followUser: removing the edge changed the follower's
      // `followingIds` and can break a bidirectional edge, so invalidate BOTH
      // sides' cached graph. No-op when no edge was actually removed.
      await Promise.all([
        graphCache.invalidate(followerId),
        graphCache.invalidate(targetId),
      ]);
      // Counts only — not broadcast. See `followUser`.
      userCache.invalidate(followerId, 'graph');
      userCache.invalidate(targetId, 'graph');
    }

    const counts = await this.readFollowCounts(targetId, followerId);
    return { removed, counts };
  }

  /**
   * Follow or unfollow a user, toggling on the current relationship. Thin
   * dispatcher over the idempotent `followUser` / `unfollowUser` primitives.
   */
  async toggleFollow(
    currentUserId: string,
    targetUserId: string
  ): Promise<FollowActionResult> {
    if (await this.isFollowing(currentUserId, targetUserId)) {
      const { counts } = await this.unfollowUser(currentUserId, targetUserId);
      return { action: 'unfollow', counts };
    }

    const { counts } = await this.followUser(currentUserId, targetUserId);
    return { action: 'follow', counts };
  }

  /**
   * Follow many users in a single batched operation.
   *
   * Follow-only and idempotent: users already followed stay followed and are
   * never toggled/unfollowed. One bad id never fails the whole batch — every
   * deduped candidate gets an entry in the returned `results` array.
   *
   * Efficiency: at most one batched query for existing follows, one for user
   * existence, and ONE bulk insert — regardless of how many targets are
   * supplied. Does NOT loop over `toggleFollow`.
   *
   * @param currentUserId The follower (authenticated user) id.
   * @param targetUserIds Candidate user ids to follow (may contain duplicates,
   *   the caller's own id, or ids that name no account).
   * @returns Per-target results and the count of NEWLY created follows.
   */
  async bulkFollow(
    currentUserId: string,
    targetUserIds: string[]
  ): Promise<BulkFollowResult> {
    const db = getDb();

    // Dedupe while preserving first-seen order, and drop the caller's own id
    // (cannot self-follow). The deduped list drives the results array.
    const candidateIds = dedupeTargetIds(currentUserId, targetUserIds);

    if (candidateIds.length === 0) {
      return { results: [], followedCount: 0 };
    }

    // ONE batched query for follows that already exist.
    const existingFollows = await db
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(
        and(
          eq(userFollows.followerId, currentUserId),
          inArray(userFollows.followedId, candidateIds)
        )
      );
    const alreadyFollowedIds = new Set(existingFollows.map((row) => row.followedId));

    // ONE batched query to verify which candidates correspond to real users.
    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, candidateIds));
    const existingUserIds = new Set(existingUsers.map((row) => row.id));

    // Candidates that exist and are not yet followed are the insert set.
    const toInsertIds = candidateIds.filter(
      (id) => existingUserIds.has(id) && !alreadyFollowedIds.has(id)
    );

    let newlyFollowedIds: string[] = [];
    const racedDuplicateIds = new Set<string>();

    if (toInsertIds.length > 0) {
      // ONE insert. A row that lost a concurrency race simply does not come
      // back from RETURNING — no error to classify, no write-error index to map.
      const inserted = await db
        .insert(userFollows)
        .values(toInsertIds.map((followedId) => ({ followerId: currentUserId, followedId })))
        .onConflictDoNothing()
        .returning({ followedId: userFollows.followedId });

      newlyFollowedIds = inserted.map((row) => row.followedId);
      const newlySet = new Set(newlyFollowedIds);
      for (const id of toInsertIds) {
        if (!newlySet.has(id)) racedDuplicateIds.add(id);
      }
    }

    if (newlyFollowedIds.length > 0) {
      // The batch changed the viewer's `followingIds` and can complete
      // bidirectional edges, so invalidate the viewer plus every newly-followed
      // target's cached graph (mutuals are symmetric). Only the ids whose edge
      // actually changed are invalidated.
      await Promise.all([
        graphCache.invalidate(currentUserId),
        ...newlyFollowedIds.map((id) => graphCache.invalidate(id)),
      ]);
      // Counts only — not broadcast. See `followUser`. This is the site the
      // suppression exists for: one bulk call moves up to 200 edges, which
      // would otherwise be a 200-message burst every subscriber discards.
      userCache.invalidate(currentUserId, 'graph');
      for (const id of newlyFollowedIds) {
        userCache.invalidate(id, 'graph');
      }
    }

    const newlyFollowedSet = new Set(newlyFollowedIds);
    const results: BulkFollowEntry[] = candidateIds.map((userId) => {
      if (newlyFollowedSet.has(userId)) {
        return { userId, success: true, alreadyFollowing: false };
      }
      if (alreadyFollowedIds.has(userId) || racedDuplicateIds.has(userId)) {
        return { userId, success: true, alreadyFollowing: true };
      }
      // Names no account.
      return { userId, success: false, alreadyFollowing: false };
    });

    return { results, followedCount: newlyFollowedIds.length };
  }

  /**
   * Unfollow many users in a single batched operation.
   *
   * Unfollow-only and idempotent: ids that are not currently followed are left
   * untouched and reported as already in the desired (not-following) state.
   *
   * Efficiency: ONE `DELETE ... RETURNING` regardless of how many targets are
   * supplied. The Mongo version issued one `findOneAndDelete` PER target,
   * because `deleteMany` reported only an aggregate count and that is not
   * enough to attribute a decrement safely under a race; a single statement's
   * RETURNING names exactly the rows THIS call removed, so the per-target loop
   * has no reason to survive.
   *
   * @param currentUserId The follower (authenticated user) id.
   * @param targetUserIds Candidate user ids to unfollow (may contain duplicates
   *   or the caller's own id).
   * @returns Per-target results and the count of follows actually removed.
   */
  async bulkUnfollow(
    currentUserId: string,
    targetUserIds: string[]
  ): Promise<BulkUnfollowResult> {
    const candidateIds = dedupeTargetIds(currentUserId, targetUserIds);

    if (candidateIds.length === 0) {
      return { results: [], unfollowedCount: 0 };
    }

    const deleted = await getDb()
      .delete(userFollows)
      .where(
        and(
          eq(userFollows.followerId, currentUserId),
          inArray(userFollows.followedId, candidateIds)
        )
      )
      .returning({ followedId: userFollows.followedId });

    const actuallyRemovedIds = deleted.map((row) => row.followedId);

    if (actuallyRemovedIds.length > 0) {
      // Symmetric to bulkFollow: invalidate the viewer plus every target
      // whose edge was actually removed (mutuals are symmetric).
      await Promise.all([
        graphCache.invalidate(currentUserId),
        ...actuallyRemovedIds.map((id) => graphCache.invalidate(id)),
      ]);
      // Counts only — not broadcast. See `bulkFollow`.
      userCache.invalidate(currentUserId, 'graph');
      for (const id of actuallyRemovedIds) {
        userCache.invalidate(id, 'graph');
      }
    }

    const removedSet = new Set(actuallyRemovedIds);
    const results: BulkUnfollowEntry[] = candidateIds.map((userId) => ({
      userId,
      success: true,
      wasFollowing: removedSet.has(userId),
    }));

    return { results, unfollowedCount: actuallyRemovedIds.length };
  }

  /**
   * Purge every social-graph edge touching a user.
   *
   * Shared by `DELETE /users/me` (self-delete) and `deleteFederatedActor`
   * (federation teardown). Does NOT delete the account row — callers own that.
   *
   * The foreign keys would cascade all of this on delete; the method still
   * exists because federation teardown purges the graph WITHOUT deleting the
   * account, and because the counterparties' caches have to be invalidated by
   * name — a cascade tells nobody whose graph just changed.
   */
  async purgeUserSocialGraph(
    userId: string
  ): Promise<{ followEdgesRemoved: number }> {
    const db = getDb();

    const removedEdges = await db
      .delete(userFollows)
      .where(
        or(eq(userFollows.followerId, userId), eq(userFollows.followedId, userId))
      )
      .returning({
        followerId: userFollows.followerId,
        followedId: userFollows.followedId,
      });

    const counterpartyIds = new Set<string>();
    for (const edge of removedEdges) {
      counterpartyIds.add(edge.followerId === userId ? edge.followedId : edge.followerId);
    }
    counterpartyIds.delete(userId);

    await Promise.all([
      db
        .delete(blocks)
        .where(or(eq(blocks.userId, userId), eq(blocks.blockedId, userId))),
      db
        .delete(restrictions)
        .where(or(eq(restrictions.userId, userId), eq(restrictions.restrictedId, userId))),
    ]);

    blockCache.invalidateUser(userId);
    restrictCache.invalidateUser(userId);
    // The subject's account is going away — that IS an identity change, so it
    // broadcasts. The counterparties only lose an edge, so they do not.
    userCache.invalidate(userId);
    for (const counterpartyId of counterpartyIds) {
      userCache.invalidate(counterpartyId, 'graph');
    }
    await Promise.all(
      [userId, ...counterpartyIds].map((id) => graphCache.invalidate(id))
    );

    return { followEdgesRemoved: removedEdges.length };
  }

  /**
   * HARD-DELETE a dead federated actor and purge its entire follow graph.
   *
   * This is the irreversible teardown behind `POST /federation/actor-delete`:
   * when a remote fediverse account is permanently gone (410) the caller purges
   * the corresponding Oxy identity AND every social-graph edge it left behind.
   *
   * CALLER CONTRACT: the route MUST have already loaded the user and confirmed
   * `type === 'federated'` before calling this — this method performs
   * destructive writes and only re-asserts the guard atomically on the final
   * delete (`where id = $1 and type = 'federated'`), never on the graph purge.
   * It must never be called for a local/agent/automated account.
   *
   * @param oxyUserId The federated actor's Oxy user id.
   * @returns The number of follow-graph edges removed.
   */
  async deleteFederatedActor(
    oxyUserId: string
  ): Promise<{ followEdgesRemoved: number }> {
    const { followEdgesRemoved } = await this.purgeUserSocialGraph(oxyUserId);

    await getDb()
      .delete(users)
      .where(and(eq(users.id, oxyUserId), eq(users.type, 'federated')));

    return { followEdgesRemoved };
  }

  /**
   * Check if current user is following target user
   */
  async isFollowing(
    currentUserId: string,
    targetUserId: string
  ): Promise<boolean> {
    const [row] = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(
        and(
          eq(userFollows.followerId, currentUserId),
          eq(userFollows.followedId, targetUserId)
        )
      )
      .limit(1);
    return !!row;
  }

  /**
   * Resolve the authenticated viewer's relationship to a target profile in ONE
   * indexed query.
   *
   * Returns both directional flags: `isFollowing` (viewer → target) and
   * `followsYou` (target → viewer). Both edges are read with a single query
   * whose two `OR` branches each hit the
   * `user_follows_follower_id_followed_id_key` unique index as a point lookup —
   * so this stays O(1) index work, not a scan, and adds no round-trip to the
   * profile fetch that already loads the target row.
   *
   * The caller is responsible for skipping this on a self-view (`viewerId ===
   * targetId`) and for omitting the field entirely on anonymous requests.
   *
   * @param viewerId The authenticated viewer's user id.
   * @param targetId The fetched profile's user id.
   * @returns `{ isFollowing, followsYou }`.
   */
  async getViewerRelationship(
    viewerId: string,
    targetId: string
  ): Promise<UserRelationship> {
    const edges = await getDb()
      .select({
        followerId: userFollows.followerId,
        followedId: userFollows.followedId,
      })
      .from(userFollows)
      .where(
        or(
          and(
            eq(userFollows.followerId, viewerId),
            eq(userFollows.followedId, targetId)
          ),
          and(
            eq(userFollows.followerId, targetId),
            eq(userFollows.followedId, viewerId)
          )
        )
      );

    let isFollowing = false;
    let followsYou = false;
    for (const edge of edges) {
      if (edge.followerId === viewerId && edge.followedId === targetId) {
        isFollowing = true;
      }
      if (edge.followerId === targetId && edge.followedId === viewerId) {
        followsYou = true;
      }
    }

    return { isFollowing, followsYou };
  }

  /**
   * Batch follow-status resolution for the authenticated viewer.
   *
   * Returns a boolean for EVERY requested target id: `true` when the viewer
   * follows that user, `false` otherwise. An anonymous viewer or an empty id set
   * resolves to all-`false` with no query.
   *
   * Efficiency contract: at most ONE indexed query regardless of N — keyed on
   * `(follower_id, followed_id in (…))`, the same axis `isFollowing` uses.
   * Built to replace N per-button `GET /users/:id/follow-status` requests with a
   * single round-trip.
   *
   * @param currentUserId The authenticated viewer (follower) id.
   * @param targetIds Candidate user ids to check (may contain duplicates).
   * @returns A map of every requested id → whether the viewer follows it.
   */
  async getFollowingStatuses(
    currentUserId: string,
    targetIds: string[]
  ): Promise<Record<string, boolean>> {
    // Dedupe requested ids preserving first-seen order; every requested id must
    // appear in the result (default false).
    const seen = new Set<string>();
    const requestedIds: string[] = [];
    for (const rawId of targetIds) {
      if (typeof rawId !== 'string') continue;
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      requestedIds.push(id);
    }

    const statuses: Record<string, boolean> = {};
    for (const id of requestedIds) {
      statuses[id] = false;
    }

    // Anonymous viewer or nothing to check → all false, no query.
    if (!currentUserId || requestedIds.length === 0) {
      return statuses;
    }

    const follows = await getDb()
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(
        and(
          eq(userFollows.followerId, currentUserId),
          inArray(userFollows.followedId, requestedIds)
        )
      );

    for (const follow of follows) {
      statuses[follow.followedId] = true;
    }

    return statuses;
  }

  /**
   * Batch-resolve PUBLIC user DTOs for a set of ids.
   *
   * Returns the SAME shape as `GET /users/:id` (`formatUserResponse`), including
   * canonical `name.displayName` and an `_count: { followers, following }` block
   * for every returned user. Designed for server-to-server fan-out (e.g. Mention
   * feed hydration) so callers avoid N+1 `GET /users/:id` round-trips.
   *
   * Efficiency contract: ONE query regardless of `ids.length`. The two follow
   * totals ride it as correlated aggregates rather than the two extra grouped
   * aggregations Mongo needed.
   *
   * Resilient to bad input: ids that match no user are silently dropped — the
   * result only contains resolved users. Order is NOT guaranteed to match the
   * input order.
   *
   * @param ids - Candidate user ids.
   * @returns Array of public user DTOs, each with `_count`.
   */
  async getUsersByIds(ids: string[]): Promise<PublicUserProfile[]> {
    const candidateIds = ids.filter((id) => typeof id === 'string' && id.length > 0);
    if (candidateIds.length === 0) {
      return [];
    }

    const rows = await getDb()
      .select({ ...publicUserColumns, ...publicUserFollowCounts })
      .from(users)
      .where(and(inArray(users.id, candidateIds), discoverableUserPredicate()));

    return rows.map((row) =>
      this.formatUserResponse(toPublicUserView(row), {
        followers: row.followersCount,
        following: row.followingCount,
      })
    );
  }

  /**
   * Get user statistics (followers, following)
   */
  async getUserStats(userId: string): Promise<UserStatistics> {
    return this.readFollowCounts(userId, userId);
  }

  /**
   * Format user response with stats.
   *
   * Reads only PUBLIC profile fields; the four owner-only ones are gated behind
   * `includePrivateFields`. A source must therefore be produced by a query that
   * covers them — `publicUserColumns` for list queries, `selfUserColumns` for
   * the single-user self reads — otherwise the unselected fields serialize as
   * `undefined` with no error anywhere.
   */
  formatUserResponse(
    user: UserResponseSource,
    stats?: UserStatistics,
    options: { includePrivateFields?: boolean } = {}
  ): PublicUserProfile {
    // The load-bearing identity fields (`id`, `name`, `username`, `avatar`) come
    // from the SHARED `userIdentityFields` definer, so this serializer can never
    // diverge from the public/self/recommendation serializers on them. In
    // particular the DTO `id` is ALWAYS the stable account id, never the
    // publicKey: the social graph the whole ecosystem keys on (`Post.oxyUserId`,
    // follow edges, client follow-state maps) is anchored on it, so a
    // key-anchored account keeps `id === _id`.
    const identity = userIdentityFields(user);
    if (!identity.id) {
      throw new Error('User must have an _id');
    }

    const response: PublicUserProfile = {
      id: identity.id,
      username: identity.username,
      name: identity.name,
      avatar: identity.avatar,
      verified: typeof user.verified === 'boolean' ? user.verified : undefined,
      bio: stringOrUndefined(user.bio),
      description: stringOrUndefined(user.description),
      color: stringOrUndefined(user.color),
      links: Array.isArray(user.links)
        ? user.links.filter((link): link is string => typeof link === 'string')
        : undefined,
      linksMetadata: Array.isArray(user.linksMetadata) ? user.linksMetadata : undefined,
      createdAt: user.createdAt instanceof Date ? user.createdAt : undefined,
      updatedAt: user.updatedAt instanceof Date ? user.updatedAt : undefined,
    };

    if (options.includePrivateFields) {
      response.phone = stringOrUndefined(user.phone);
      response.address = stringOrUndefined(user.address);
      response.birthday = stringOrUndefined(user.birthday);
      // Portable theme preference — a personal setting, so it rides ONLY the
      // self payload (`GET /users/me`, `PUT /users/me`), which is what cold boot
      // loads. Gated with the other private fields so it never leaks onto other
      // users' public profile fetches. Omitted when unset (consumers keep their
      // own default).
      const themePreference =
        toThemePreference(user.themePreference) ??
        toThemePreference({
          mode: user.themePreferenceMode,
          colorPreset: user.themePreferenceColorPreset,
        });
      if (themePreference) {
        response.themePreference = themePreference;
      }
    }

    if (user.type) {
      response.type = user.type;
    }
    // Account-graph classification, on EVERY public profile row. This is the
    // field a consumer rendering authored content reads to tell a channel's post
    // from a person's; without it the only signal would be a second identity
    // carried alongside the author, which is exactly what modelling a channel as
    // an account removes. Orthogonal to `type` — both ride the DTO.
    if (isAccountKind(user.kind)) {
      response.kind = user.kind;
    }
    const federation = user.federation ?? flatFederation(user);
    if (federation) {
      response.federation = federation;
    }
    response.isFederated = deriveIsFederated(user.type);
    // Public, derived: whether this account participates in fediverse sharing.
    // Intentionally public (like isFederated) — the state is observable anyway
    // (the AP actor 404s when off). The rest of the privacy settings stay private.
    const privacySettings = isRecord(user.privacySettings) ? user.privacySettings : undefined;
    const fediverseSharing =
      privacySettings && 'fediverseSharing' in privacySettings
        ? privacySettings.fediverseSharing
        : user.privacyFediverseSharing;
    response.fediverseSharing = fediverseSharing !== false;

    if (stats) {
      response._count = stats;
    }

    return response;
  }
}

/**
 * Dedupe target ids preserving first-seen order and drop the caller's own id.
 *
 * There is no id-FORMAT filter any more. Mongo needed one because an
 * ObjectId-shaped cast failure threw; a `text` id that names no account simply
 * matches nothing, which is the same answer by a shorter road — and the
 * per-target result entry for it is identical (`success: false`).
 */
function dedupeTargetIds(currentUserId: string, targetUserIds: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawId of targetUserIds) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id || id === currentUserId || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

/**
 * Map the validated profile-update allowlist onto `users` columns.
 *
 * The nested Mongo subdocuments (`name`, `notificationPreferences`,
 * `userPreferences`, `themePreference`) are flat columns here, so this is where
 * the wire's nesting is unwound — the mirror image of `toPublicUserView`. Only
 * keys the caller supplied are written; a partial `userPreferences` leaves the
 * fields it omitted untouched, matching Mongoose's dot-path `set`.
 */
function buildUserColumnUpdates(
  filtered: Record<string, unknown>
): Record<string, unknown> {
  const set: Record<string, unknown> = {};

  if (isRecord(filtered.name)) {
    const name = filtered.name as NameParts;
    if ('first' in name) set.nameFirst = blankToNull(name.first);
    if ('last' in name) set.nameLast = blankToNull(name.last);
    // `blankToNull` is what lets a caller CLEAR the explicit name and fall back
    // to the composed `first`/`last` — the same semantics the other two halves
    // already had.
    if ('displayName' in name) set.nameDisplay = blankToNull(name.displayName);
  }
  if (typeof filtered.email === 'string') set.email = blankToNull(filtered.email);
  if (typeof filtered.username === 'string') set.username = blankToNull(filtered.username);
  if (typeof filtered.avatar === 'string') set.avatar = blankToNull(filtered.avatar);
  if (typeof filtered.color === 'string') set.color = filtered.color;
  if (typeof filtered.bio === 'string') set.bio = blankToNull(filtered.bio);
  if (typeof filtered.description === 'string') set.description = blankToNull(filtered.description);
  if (typeof filtered.phone === 'string') set.phone = blankToNull(filtered.phone);
  if (typeof filtered.address === 'string') set.address = blankToNull(filtered.address);
  if (typeof filtered.birthday === 'string') set.birthday = blankToNull(filtered.birthday);
  if (Array.isArray(filtered.links)) {
    set.links = filtered.links.filter((link): link is string => typeof link === 'string');
  }
  if (Array.isArray(filtered.languages)) set.languages = filtered.languages;
  if ('accountExpiresAfterInactivityDays' in filtered) {
    const days = filtered.accountExpiresAfterInactivityDays;
    set.accountExpiresAfterInactivityDays = typeof days === 'number' ? days : null;
  }

  if (isRecord(filtered.notificationPreferences)) {
    const prefs = filtered.notificationPreferences;
    if (typeof prefs.pushEnabled === 'boolean') set.notificationPushEnabled = prefs.pushEnabled;
    if (typeof prefs.emailDigest === 'boolean') set.notificationEmailDigest = prefs.emailDigest;
    if (typeof prefs.securityAlerts === 'boolean') set.notificationSecurityAlerts = prefs.securityAlerts;
    if (typeof prefs.marketingEmails === 'boolean') set.notificationMarketingEmails = prefs.marketingEmails;
  }

  if (isRecord(filtered.userPreferences)) {
    const prefs = filtered.userPreferences;
    if (typeof prefs.language === 'string') set.preferenceLanguage = blankToNull(prefs.language);
    if (prefs.theme === 'light' || prefs.theme === 'dark' || prefs.theme === 'system') {
      set.preferenceTheme = prefs.theme;
    }
    if (typeof prefs.reduceMotion === 'boolean') set.preferenceReduceMotion = prefs.reduceMotion;
    if (typeof prefs.timezone === 'string') set.preferenceTimezone = blankToNull(prefs.timezone);
  }

  if (isRecord(filtered.themePreference)) {
    const theme = filtered.themePreference;
    set.themePreferenceMode = theme.mode;
    set.themePreferenceColorPreset = theme.colorPreset;
  }

  return set;
}

/**
 * One `locations[]` entry → a `user_locations` row.
 *
 * `coordinates.lat` / `.lon` become the NAMED `latitude` / `longitude` columns.
 * The spatial `geo` point is GENERATED from that pair, so it is never written
 * and the coordinate ordering cannot be got wrong here — see
 * `db/schema/userLocations.ts`.
 *
 * Returns `null` for an entry with no usable `name`, which is the field the
 * column requires; Mongoose would have rejected the same row on `required`.
 */
function toLocationRow(userId: string, entry: unknown, index: number) {
  if (!isRecord(entry)) return null;
  const name = stringOrUndefined(entry.name);
  if (!name) return null;

  const address = isRecord(entry.address) ? entry.address : {};
  const coordinates = isRecord(entry.coordinates) ? entry.coordinates : {};
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const type: (typeof USER_LOCATION_TYPES)[number] =
    entry.type === 'home' || entry.type === 'work' || entry.type === 'school'
      ? entry.type
      : 'other';

  return {
    userId,
    // The client-supplied handle every call site addresses the row by. An entry
    // that carries none still needs one, and its position in the submitted list
    // is the only stable thing about it.
    locationKey: stringOrUndefined(entry.id) ?? `location-${index}`,
    name,
    label: blankToNull(entry.label),
    type,
    street: blankToNull(address.street),
    streetNumber: blankToNull(address.streetNumber),
    streetDetails: blankToNull(address.streetDetails),
    postalCode: blankToNull(address.postalCode),
    city: blankToNull(address.city),
    state: blankToNull(address.state),
    country: blankToNull(address.country),
    formattedAddress: blankToNull(address.formattedAddress),
    latitude: typeof coordinates.lat === 'number' ? coordinates.lat : null,
    longitude: typeof coordinates.lon === 'number' ? coordinates.lon : null,
    placeId: blankToNull(metadata.placeId),
    osmId: blankToNull(metadata.osmId),
    osmType: blankToNull(metadata.osmType),
    countryCode: blankToNull(metadata.countryCode),
    timezone: blankToNull(metadata.timezone),
  };
}

/**
 * One `linksMetadata[]` entry → a `user_link_metadata` row.
 *
 * `position` is the submitted order, which is the only ordering the wire ever
 * carried — an embedded array is ordered, a child table is not until something
 * says so.
 */
function toLinkMetadataRow(userId: string, entry: unknown, index: number) {
  if (!isRecord(entry)) return null;
  const url = stringOrUndefined(entry.url);
  if (!url) return null;

  return {
    userId,
    position: index,
    url,
    title: stringOrUndefined(entry.title) ?? '',
    description: stringOrUndefined(entry.description) ?? '',
    image: blankToNull(entry.image),
  };
}

/** Re-exported so consumers can name the row shape a link-metadata write takes. */
export type { LinkMetadataDto };

// Export singleton instance
export const userService = new UserService();
export default userService;
