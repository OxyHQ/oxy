/**
 * The PUBLIC user row — what a list of other people's profiles is allowed to be.
 *
 * SINGLE source of truth for every endpoint that returns other users
 * (followers, following, mutuals, people search, profile lookup). Those lists
 * render the same row everywhere in the ecosystem — avatar, display name,
 * handle, bio, verified badge, federated/remote-instance badge — so they all
 * need the same column set, and a hand-written selection per query is exactly
 * how they drifted apart before: the follower / following / mutual queries
 * silently omitted `bio`, `verified` and `federation`, so the API emitted
 * `bio: undefined` on every row while the serializer and the wire contract
 * (`userResponseSchema`) both carried the field.
 *
 * ## Three things, and the middle one is the whole point
 *
 * 1. {@link publicUserColumns} — the drizzle SELECTION. Inclusion-only, exactly
 *    as the Mongo projection was: every unlisted column (`email`, `phone`, the
 *    contact hashes, `refresh_token`, the private half of the privacy settings)
 *    is absent because it was never named, rather than because someone
 *    remembered to exclude it.
 * 2. {@link toPublicUserView} — the flat row → response-shaped VIEW. The
 *    schema stores `name_first` / `federation_domain` /
 *    `privacy_fediverse_sharing` as flat columns (see
 *    `db/schema/CONVENTIONS.md`), while the WIRE contract nests them as
 *    `name.first` / `federation.domain` / `privacySettings.fediverseSharing`.
 *    The nesting is the API's shape, not Mongo's, so it belongs at the read
 *    boundary — and putting it here means every serializer downstream consumes
 *    one shape and cannot re-derive it differently.
 * 3. {@link publicUserFollowCounts} — the follower/following totals. `_count`
 *    was a denormalized counter on the Mongo document because Mongo cannot
 *    JOIN; here it is a correlated `count(*)` served by
 *    `user_follows_followed_id_created_at_id_idx` and the follower/followed
 *    unique index, so it is a MEASUREMENT and can never drift from the edges.
 *
 * `public_key` is deliberately NOT selected. The DTO `id` is always the stable
 * account id, and the social graph these lists feed (follow edges, the viewer
 * graph id lists, client-side follow-state maps) is keyed by that same id — a
 * public row needs no key material.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AccountCategoryId, AccountKind } from '@oxyhq/contracts';
import { qualified } from '@oxyhq/db';
import { userFollows } from '../db/schema/userFollows';
import { userLinkMetadata } from '../db/schema/userLinkMetadata';
import { users } from '../db/schema/users';
import type { NameParts } from './displayName';

/**
 * One profile link's unfurled metadata, as it appears on the wire.
 *
 * Mongo embedded this as an array on the user document; it is a child table
 * here, aggregated back into an ordered array by {@link publicUserColumns} so a
 * list of N profiles still costs ONE query.
 */
export interface LinkMetadataDto {
  url: string;
  title: string;
  description: string;
  image?: string | null;
}

/**
 * A public profile in the shape the API returns it — the input every user-DTO
 * serializer reads.
 *
 * Deliberately NOT the flat table row: `name`, `federation` and
 * `privacySettings` are nested on the wire, so nesting them once here keeps the
 * serializers free of column-name knowledge and makes a response-parity test a
 * pure function of this type.
 */
export interface PublicUserView {
  _id: string;
  username?: string;
  name?: NameParts;
  avatar?: string;
  color?: string;
  bio?: string;
  description?: string;
  links?: string[];
  linksMetadata?: LinkMetadataDto[];
  verified?: boolean;
  type?: string;
  /**
   * Account-graph classification. PUBLIC on purpose and on every profile row:
   * whether an account is a person or a channel is what a consumer rendering
   * authored content decides on, and it is observable anyway (a channel's AP
   * actor is a `Service`). Orthogonal to `type` — both are carried.
   */
  kind?: AccountKind;
  /**
   * What the account is about — ORDERED, primary first. PUBLIC and on every
   * profile row, because the profile screen renders it: a channel's or an
   * organization's categories are the first thing a visitor reads off the
   * header. Ids only; the reader's own locale supplies the label.
   */
  accountCategories?: AccountCategoryId[];
  federation?: { actorUri?: string; domain?: string };
  /** Only the two leaves a public row may carry — see the module header. */
  privacySettings?: { fediverseSharing?: boolean; isPrivateAccount?: boolean };
  accountStatus?: string;
  reputationTier?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * The ordered link-metadata array for the user of the row being selected.
 *
 * A correlated aggregate rather than a second round trip: a page of 50 profiles
 * costs one query either way, and a second query would have to be re-attached
 * by id at every call site — the shape that drifts.
 *
 * Every identifier is INTERPOLATED as a drizzle column/table so the SQL names
 * come from the casing setting rather than being spelled out here (see the trap
 * in `db/schema/CONVENTIONS.md`).
 */
const linksMetadataAggregate: SQL<LinkMetadataDto[]> = sql`coalesce((
  select json_agg(
    json_build_object(
      'url', ${qualified(userLinkMetadata.url)},
      'title', ${qualified(userLinkMetadata.title)},
      'description', ${qualified(userLinkMetadata.description)},
      'image', ${qualified(userLinkMetadata.image)}
    )
    order by ${qualified(userLinkMetadata.position)}
  )
  from ${userLinkMetadata}
  where ${qualified(userLinkMetadata.userId)} = ${qualified(users.id)}
), '[]'::json)`;

/**
 * Every column a client may see on SOMEONE ELSE's profile.
 *
 * `account_status`, `reputation_tier` and `privacy_is_private_account` are GATE
 * columns: route handlers read them to decide discoverability
 * (`isPublicGraphTarget`). {@link toPublicUserView} carries them, and the
 * serializers never emit them.
 */
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  nameFirst: users.nameFirst,
  nameLast: users.nameLast,
  nameDisplay: users.nameDisplay,
  kind: users.kind,
  accountCategories: users.accountCategories,
  avatar: users.avatar,
  color: users.color,
  bio: users.bio,
  description: users.description,
  links: users.links,
  linksMetadata: linksMetadataAggregate,
  verified: users.verified,
  type: users.type,
  federationActorUri: users.federationActorUri,
  federationDomain: users.federationDomain,
  privacyFediverseSharing: users.privacyFediverseSharing,
  privacyIsPrivateAccount: users.privacyIsPrivateAccount,
  accountStatus: users.accountStatus,
  reputationTier: users.reputationTier,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

/** The row {@link publicUserColumns} yields. */
export interface PublicUserRow {
  id: string;
  username: string | null;
  nameFirst: string | null;
  nameLast: string | null;
  nameDisplay: string | null;
  kind: AccountKind;
  accountCategories: AccountCategoryId[];
  avatar: string | null;
  color: string;
  bio: string | null;
  description: string | null;
  links: string[] | null;
  linksMetadata: LinkMetadataDto[];
  verified: boolean;
  type: string;
  federationActorUri: string | null;
  federationDomain: string | null;
  privacyFediverseSharing: boolean;
  privacyIsPrivateAccount: boolean;
  accountStatus: string;
  reputationTier: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Follower/following totals for the user of the row being selected.
 *
 * Spread into a selection alongside {@link publicUserColumns} by any surface
 * that emits `_count`. `::int` because `count(*)` is `bigint`, which postgres.js
 * hands back as a STRING — a silent `"42"` on the wire where the contract
 * promises a number.
 */
export const publicUserFollowCounts = {
  followersCount: sql<number>`(select count(*)::int from ${userFollows} where ${qualified(userFollows.followedId)} = ${qualified(users.id)})`,
  followingCount: sql<number>`(select count(*)::int from ${userFollows} where ${qualified(userFollows.followerId)} = ${qualified(users.id)})`,
} as const;

/** A `null` column becomes an ABSENT property — `undefined`, never `null`. */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Flat row → the response-shaped view every serializer reads.
 *
 * The three re-nestings (`name`, `federation`, `privacySettings`) are the whole
 * job. `federation` is emitted only for a row that actually has federation
 * data, matching Mongo, where the subdocument was simply absent on a local
 * account and `formatUserResponse` tests it for truthiness.
 */
export function toPublicUserView(row: PublicUserRow): PublicUserView {
  const federation =
    row.federationActorUri !== null || row.federationDomain !== null
      ? {
          actorUri: optional(row.federationActorUri),
          domain: optional(row.federationDomain),
        }
      : undefined;

  return {
    _id: row.id,
    username: optional(row.username),
    name: {
      first: optional(row.nameFirst),
      last: optional(row.nameLast),
      displayName: optional(row.nameDisplay),
    },
    kind: row.kind,
    // Passed through UNTOUCHED. Not sorted, not de-duplicated, not filtered —
    // index 0 is the primary category, so a rewrite here would silently change
    // which one a profile leads with. Empty stays empty; the serializer decides
    // whether an empty list reaches the wire.
    accountCategories: row.accountCategories,
    avatar: optional(row.avatar),
    color: row.color,
    bio: optional(row.bio),
    description: optional(row.description),
    links: optional(row.links),
    linksMetadata: row.linksMetadata,
    verified: row.verified,
    type: row.type,
    federation,
    privacySettings: {
      fediverseSharing: row.privacyFediverseSharing,
      isPrivateAccount: row.privacyIsPrivateAccount,
    },
    accountStatus: row.accountStatus,
    reputationTier: row.reputationTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The Mongoose `.select(...)` argument for a public user row.
 *
 * Retained ONLY for `controllers/session.controller.ts`, whose port belongs to
 * the auth/session batch; it is the last Mongo reader of this module. Delete it
 * with that call site — nothing else may grow a dependency on it.
 */
export const PUBLIC_USER_PROFILE_SELECT = [
  'username',
  'name',
  'kind',
  'avatar',
  'color',
  'bio',
  'description',
  'links',
  'linksMetadata',
  'verified',
  'type',
  'federation',
  'privacySettings.fediverseSharing',
  'createdAt',
  'updatedAt',
  'accountStatus',
  'reputationTier',
  'privacySettings.isPrivateAccount',
].join(' ');
