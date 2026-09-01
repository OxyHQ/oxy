/**
 * Profile-discovery predicates.
 *
 * Pure, stateless builders for the eligibility/quality bar every people surface
 * shares — people search (`GET /search`, `GET /profiles/search`,
 * `POST /users/search`), the follow-graph lists, `/profiles/:id/similar`, and
 * the recommendation scorer. They live in `utils/` because they perform no I/O
 * and hold no state; they only build `SQL` fragments.
 *
 * ## What the port changed, and what it deliberately did not
 *
 * Mongo spelled "not archived" as `{ $ne: 'archived' }`, which ALSO matches a
 * document where the field is absent. Every one of these columns is `NOT NULL`
 * with a default here, so the absent case does not exist and the predicate is an
 * exact equality — `= false` rather than `<> true`, and it means the same thing
 * for every row.
 *
 * The "non-empty string" tests are the same story. Mongo needed
 * `{ $type: 'string', $ne: '' }` because a field could hold anything or nothing;
 * the columns are `text` and `CONVENTIONS.md` forbids a `''` default, so the
 * only two states are a value and NULL — except for rows carried over by the
 * backfill, which is why the check is still written `is not null and <> ''`
 * rather than just `is not null`.
 */

import { and, eq, gte, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { federatedUsernameFromUpstreamUrl } from '@oxyhq/federation';
import { qualified } from '@oxyhq/db';
import { users } from '../db/schema/users';
import { userLocations } from '../db/schema/userLocations';

export const FEDERATED_RECOMMENDATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * `column` holds a real value: present AND not the empty string.
 *
 * The `<> ''` half is not redundant. A `''` DEFAULT is forbidden by
 * `CONVENTIONS.md`, but Mongoose defaulted several of these fields to `''` and
 * the backfill carries the stored value verbatim, so an empty string is a state
 * that reaches this predicate from real data.
 */
function nonEmpty(column: SQL | ReturnType<typeof sql>): SQL {
  return sql`${column} is not null and ${column} <> ''`;
}

/**
 * The floor under every people surface: not an archived account, not in the
 * punitive `restricted` reputation tier.
 */
export function discoverableUserPredicate(): SQL {
  const predicate = and(
    ne(users.accountStatus, 'archived'),
    ne(users.reputationTier, 'restricted')
  );
  // `and()` of two non-undefined arguments is always defined; the cast-free
  // narrowing keeps the return type honest for callers that compose it.
  return predicate ?? sql`true`;
}

/**
 * {@link discoverableUserPredicate} plus the private-account opt-out — the gate
 * for username/name people-search surfaces, which must not surface an account
 * that asked not to be found.
 */
export function peopleSearchPredicate(): SQL {
  return and(discoverableUserPredicate(), eq(users.privacyIsPrivateAccount, false)) ?? sql`true`;
}

/** Longest fuzzy/substring people-search term honoured. */
export const MAX_PEOPLE_SEARCH_TERM_LENGTH = 100;

/**
 * Pasted profile URLs can carry long tracking query strings. They are parsed
 * exactly, never substring-scanned, so they need a higher ceiling than fuzzy
 * terms — truncating a pasted link at {@link MAX_PEOPLE_SEARCH_TERM_LENGTH}
 * can slice through the handle or drop the path before parsing.
 */
const MAX_PASTED_PROFILE_URL_LENGTH = 2048;

/**
 * Normalise raw people-search input from every surface (`GET /search`,
 * `GET /profiles/search`, `POST /users/search`).
 *
 * Strips one leading `@` (handle-style queries) and applies a length cap.
 * URL-shaped terms keep a much higher cap so a pasted profile link with
 * tracking parameters still parses.
 */
export function normalizePeopleSearchTerm(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.slice(0, MAX_PASTED_PROFILE_URL_LENGTH);
  }
  return trimmed.slice(0, MAX_PEOPLE_SEARCH_TERM_LENGTH);
}

export interface PeopleSearchMatchOptions {
  /** Include `description` (default: true). */
  includeDescription?: boolean;
  /** Include the user's location name/city/country (`GET /search` only). */
  includeLocations?: boolean;
}

/**
 * Case-insensitive SUBSTRING match of `term` across the searchable profile
 * fields.
 *
 * `ILIKE '%term%'` and not a `tsvector`: `CONVENTIONS.md` requires a Mongo TEXT
 * INDEX to become `tsvector` + GIN, and this was never one. It was an unanchored
 * `/i` regex over `username` / `name.first` / `name.last` / `description`, which
 * no b-tree could serve either — a partial-word query (`ali` → `alice`) is the
 * documented behaviour, and a lexeme index would silently stop answering it.
 * The port is behaviour-for-behaviour; the access path is unchanged.
 *
 * `term` is the caller's raw search text. It is escaped for LIKE here (`\`, `%`,
 * `_`) and bound as a parameter, so no input can widen the pattern or reach the
 * SQL — the same job the caller's regex-metacharacter escaping used to do.
 */
export function peopleSearchMatch(
  term: string,
  options: PeopleSearchMatchOptions = {}
): SQL {
  const { includeDescription = true, includeLocations = false } = options;

  // A pasted upstream profile URL is an EXACT request, not a search phrase.
  //
  // `https://x.com/nasa` names one account, and we hold that person under the
  // federated username a bridge derived for them (`nasa@x.com`). Left to the
  // substring match below the URL matches nothing at all — no username or name
  // contains it — so pasting a link a user is looking at reports that we do not
  // have the account, which is very often false.
  //
  // It REPLACES the fuzzy match rather than joining it. Someone whose bio quotes
  // `x.com/nasa` is not who was asked for, and returning them alongside would
  // make the precise answer harder to see. When the URL parses and we hold
  // nobody, no rows is the correct and honest answer.
  //
  // The username is resolved through `@oxyhq/federation`, the same declaration
  // the ingest path reads forwards — not a second parsing rule here, which would
  // work for X (plain lowercasing) and fail silently for Bluesky (a default
  // handle drops its `.bsky.social` suffix), returning nothing for accounts we
  // do hold. The URL is never fetched.
  const upstreamUsername = federatedUsernameFromUpstreamUrl(term);
  if (upstreamUsername !== undefined) {
    // Written against the expression the username unique index is built on
    // (`lower(btrim(username))`), so this is an index seek rather than a scan.
    return sql`lower(btrim(${users.username})) = ${upstreamUsername}`;
  }

  const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

  const clauses: SQL[] = [
    sql`${users.username} ilike ${pattern}`,
    sql`${users.nameFirst} ilike ${pattern}`,
    sql`${users.nameLast} ilike ${pattern}`,
  ];

  if (includeDescription) {
    clauses.push(sql`${users.description} ilike ${pattern}`);
  }

  if (includeLocations) {
    // `locations` was an embedded array; it is a child table now, so the
    // "any location matches" test is an EXISTS rather than Mongo's implicit
    // any-element semantics on a dotted path.
    clauses.push(sql`exists (
      select 1 from ${userLocations}
      where ${qualified(userLocations.userId)} = ${qualified(users.id)}
        and (
          ${qualified(userLocations.name)} ilike ${pattern}
          or ${qualified(userLocations.city)} ilike ${pattern}
          or ${qualified(userLocations.country)} ilike ${pattern}
        )
    )`);
  }

  return or(...clauses) ?? sql`false`;
}

/**
 * Shared native-first ordering for people-search surfaces.
 *
 * Applied BEFORE paging so offset pagination stays deterministic:
 *   1. native before federated
 *   2. higher reputation rank first
 *   3. `id` ascending as the FINAL tiebreaker
 *
 * The third element is load-bearing, not decoration. `id` is unique, so the
 * composite key is a STRICT TOTAL ORDER: two rows can never compare equal, and
 * an `offset`/`limit` page therefore cannot show a row twice or skip one. Drop
 * it and infinite scroll corrupts with no error and no failing request.
 */
export function peopleSearchOrder(): SQL[] {
  return [
    sql`(case when ${users.type} = 'federated' then 1 else 0 end) asc`,
    sql`${users.reputationRankWeight} desc`,
    sql`${users.id} asc`,
  ];
}

/**
 * Whether a hydrated user view may appear on people-discovery surfaces
 * (ActivityPub actor lookup, profile shells, etc.).
 */
export function isDiscoverableUser(
  user: { accountStatus?: string; reputationTier?: string } | null | undefined,
): boolean {
  return (
    !!user &&
    user.accountStatus !== 'archived' &&
    user.reputationTier !== 'restricted'
  );
}

/**
 * Whether a user may seed or expose a social-graph discovery surface
 * (`GET /users/:userId/{followers,following,mutuals}`, `/profiles/:userId/similar`).
 * Extends {@link isDiscoverableUser} with the private-account opt-out.
 */
export function isPublicGraphTarget(
  user:
    | {
        accountStatus?: string;
        reputationTier?: string;
        privacySettings?: { isPrivateAccount?: boolean };
      }
    | null
    | undefined,
): boolean {
  return isDiscoverableUser(user) && user?.privacySettings?.isPrivateAccount !== true;
}

/**
 * Whether a user may be discovered via ActivityPub (actor GET, WebFinger).
 * Extends {@link isDiscoverableUser} with the explicit `fediverseSharing` opt-out.
 */
export function isFederatableUser(
  user:
    | {
        accountStatus?: string;
        reputationTier?: string;
        privacySettings?: { fediverseSharing?: boolean };
      }
    | null
    | undefined,
): boolean {
  if (!user || !isDiscoverableUser(user)) return false;
  return user.privacySettings?.fediverseSharing !== false;
}

/**
 * A federated actor is only recommendable while it is still RESOLVING: it must
 * carry an actor URI and a domain, have been re-resolved inside the freshness
 * window, and not have been marked unavailable. Non-federated accounts pass
 * unconditionally.
 */
export function federatedRecommendationEligibility(minResolvedAt: Date): SQL {
  return or(
    ne(users.type, 'federated'),
    and(
      eq(users.type, 'federated'),
      nonEmpty(sql`${users.federationActorUri}`),
      nonEmpty(sql`${users.federationDomain}`),
      gte(users.federationLastResolvedAt, minResolvedAt),
      isNull(users.federationUnavailableAt)
    )
  ) ?? sql`true`;
}

/**
 * Minimum profile-quality bar for the discovery surface.
 *
 * The recommendation pool is dominated by incomplete shell accounts — created
 * by signup/register/QA with nothing but a username or a bare public key, no
 * avatar, no name, no bio. Surfacing those as "who to follow" is worse than
 * returning a short list, so every candidate must clear two gates:
 *
 *   1. a real, non-empty `username` (no key-only ghost accounts), AND
 *   2. at least ONE genuine signal that a human curated the profile —
 *      an avatar, a structured name, a bio/description, or a verified badge.
 *
 * Intentionally NOT a name/email blocklist: it filters on real profile
 * completeness, so it degrades gracefully (a short, clean list) as the pool
 * fills with genuine profiles rather than padding with shells. Follower count is
 * an additional quality signal applied as a SORT key downstream — it is a
 * measurement over another table, not a column this predicate can read.
 */
export function profileQualityPredicate(): SQL {
  const curated = or(
    nonEmpty(sql`${users.avatar}`),
    nonEmpty(sql`${users.nameFirst}`),
    nonEmpty(sql`${users.nameLast}`),
    nonEmpty(sql`${users.bio}`),
    nonEmpty(sql`${users.description}`),
    eq(users.verified, true)
  );
  return and(nonEmpty(sql`${users.username}`), curated) ?? sql`true`;
}

/**
 * Combined eligibility gate for the recommendation/discovery surface: a fresh,
 * available federated actor (or a non-federated account), clearing the minimum
 * profile-quality bar, not flagged account-level sensitive/NSFW, not archived,
 * and not in the `restricted` tier.
 *
 * `is_sensitive` is the ACCOUNT flag set by moderation — never the viewer's own
 * `privacy_sensitive_content` preference.
 */
export function eligibleUserPredicate(minResolvedAt: Date): SQL {
  return (
    and(
      federatedRecommendationEligibility(minResolvedAt),
      profileQualityPredicate(),
      eq(users.isSensitive, false),
      discoverableUserPredicate()
    ) ?? sql`true`
  );
}
