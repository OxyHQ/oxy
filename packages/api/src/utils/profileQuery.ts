import { organizationProfiles } from '../db/schema/organizationProfiles';
/**
 * Profile-discovery predicates.
 *
 * Pure, stateless builders for the eligibility/quality bar every people surface
 * shares — people search (`GET /search`, `GET /profiles/search`,
 * `POST /users/search`), the follow-graph lists, `/profiles/:id/similar`, and
 * the recommendation scorer. They live in `utils/` because they perform no I/O
 * and hold no state; they only build `SQL` fragments.
 *
 * ## Predicate shapes
 *
 * Every flag column here is `NOT NULL` with a default, so there is no absent
 * case and the predicate is an exact equality — `= false` rather than
 * `<> true`, and it means the same thing for every row.
 *
 * The "non-empty string" tests: the columns are `text` and `CONVENTIONS.md`
 * forbids a `''` default, so new rows have only two states, a value and NULL —
 * but older rows can still hold `''`, which is why the check is written
 * `is not null and <> ''` rather than just `is not null`.
 */

import { and, eq, gte, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { federatedUsernameFromUpstreamUrl } from '@oxy.so/federation';
import { qualified } from '@oxy.so/db';
import {
  type AccountKind,
  PEOPLE_SEARCH_TRGM_EXPRESSION,
  type USER_TYPES,
  users,
} from '../db/schema/users';
import { userLocations } from '../db/schema/userLocations';

export const FEDERATED_RECOMMENDATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * `column` holds a real value: present AND not the empty string.
 *
 * The `<> ''` half is not redundant. A `''` DEFAULT is forbidden by
 * `CONVENTIONS.md`, but older rows store `''` in several of these fields, so an
 * empty string is a state that reaches this predicate from real data.
 */
function nonEmpty(column: SQL | ReturnType<typeof sql>): SQL {
  return sql`${column} is not null and ${column} <> ''`;
}

/**
 * The floor under every people surface: not an archived account, not in the
 * punitive `restricted` reputation tier.
 */
/** A suppressed or redirected directory entry cannot reappear through generic profile APIs. */
export function visibleOrganizationIdentityPredicate(): SQL {
  return sql`(${users.kind} <> 'organization' or exists (select 1 from ${organizationProfiles} where ${organizationProfiles.accountId} = ${users.id} and ${organizationProfiles.status} in ('active','inactive'))) `;
}

export function discoverableUserPredicate(): SQL {
  const predicate = and(
    ne(users.accountStatus, 'archived'),
    ne(users.reputationTier, 'restricted'),
    visibleOrganizationIdentityPredicate(),
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
 * Shortest term that still gets a SUBSTRING match.
 *
 * Three, because that is `pg_trgm`'s trigram width: a pattern with no
 * wildcard-free run of at least three characters yields no trigrams, so
 * `users_people_search_trgm_idx` cannot be used and the query becomes a
 * sequential scan with a concatenation on top. Shorter terms get an anchored
 * prefix match instead — see {@link peopleSearchMatch}.
 */
export const MIN_FUZZY_TERM_LENGTH = 3;

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

/** Escape `\\`, `%` and `_` so a user's term is a LITERAL inside a LIKE pattern. */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
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
 * `ILIKE '%term%'` and not a `tsvector`: this is an unanchored,
 * case-insensitive substring match over `username` / `name.first` /
 * `name.last` / `name.displayName` (a non-personal account's title lives there
 * alone) / `description`, which no b-tree could serve either — a
 * partial-word query (`ali` → `alice`) is the documented behaviour, and a
 * lexeme index would silently stop answering it.
 *
 * `term` is the caller's raw search text. It is escaped for LIKE here (`\`, `%`,
 * `_`) and bound as a parameter, so no input can widen the pattern or reach the
 * SQL — the same job the caller's regex-metacharacter escaping used to do.
 */
export function peopleSearchMatch(term: string, options: PeopleSearchMatchOptions = {}): SQL {
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
  // The username is resolved through `@oxy.so/federation`, the same declaration
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

  const escaped = escapeLikeTerm(term);

  // Below three characters, switch from substring to anchored PREFIX.
  //
  // `pg_trgm` extracts trigrams only from a pattern's wildcard-free runs, so
  // `%ab%` yields none and the GIN index cannot be used at all — the query
  // degrades to a sequential scan PLUS a concatenation per row, i.e. slower
  // than before the index existed. That is the cheapest request in the product
  // to issue and the most expensive to serve, which is a denial-of-service
  // shape, not merely a slow path.
  //
  // This IS a behaviour change for 1-2 character queries: they no longer match
  // mid-word. It is the right trade — "substring anywhere" is not a useful
  // answer to a one-letter query, and the alternative is a guaranteed table
  // scan behind the easiest query to fire. `description` is deliberately left
  // out of the prefix branch: a prefix match against the first word of a bio
  // answers nothing anyone asked.
  if (escaped.length < MIN_FUZZY_TERM_LENGTH) {
    const prefix = `${escaped}%`;
    return (
      or(
        sql`lower(btrim(${users.username})) like ${prefix}`,
        sql`lower(${users.nameFirst}) like ${prefix}`,
        sql`lower(${users.nameLast}) like ${prefix}`,
        sql`lower(${users.nameDisplay}) like ${prefix}`,
      ) ?? sql`false`
    );
  }

  const pattern = `%${escaped}%`;

  const clauses: SQL[] = [
    sql`${users.username} ilike ${pattern}`,
    sql`${users.nameFirst} ilike ${pattern}`,
    sql`${users.nameLast} ilike ${pattern}`,
    sql`${users.nameDisplay} ilike ${pattern}`,
  ];

  if (includeDescription) {
    clauses.push(sql`${users.description} ilike ${pattern}`);
  }

  if (includeLocations) {
    // `locations` is a child table, so the "any location matches" test is an
    // EXISTS.
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

  const exactMatch = or(...clauses) ?? sql`false`;

  // A coarse, INDEX-SERVABLE prefilter AND the exact match above.
  //
  // The prefilter is `<concatenated text> ILIKE '%term%'`, written against the
  // very expression `users_people_search_trgm_idx` is built on, so Postgres can
  // answer it from the GIN index instead of reading the table. Because a
  // substring of any part is a substring of the concatenation, the prefilter
  // can only ever admit MORE rows than the real answer — never fewer — so the
  // exact clauses remain the predicate the result actually depends on. Same
  // escaped, bound pattern goes to both, so no input can widen one and not the
  // other.
  //
  // The location branch is NOT covered by this index (it lives on a different
  // table), so `GET /search`'s `includeLocations: true` variant still needs its
  // own index before that half stops scanning `user_locations`. Adding the
  // prefilter as an AND would be WRONG there: a user whose only match is a city
  // name has nothing matching in the `users` concatenation, so the prefilter
  // would exclude a row the predicate should return.
  if (includeLocations) {
    return exactMatch;
  }

  return and(sql`${PEOPLE_SEARCH_TRGM_EXPRESSION} ilike ${pattern}`, exactMatch) ?? sql`false`;
}

/**
 * The relevance tiers of a people search, best first. A row's tier is the BEST
 * clause it satisfies, read off the row that is actually returned.
 *
 *   0. `exactHandle`    — the username IS the term (`nate`, or a full
 *                         `nate@mastodon.social`), or a federated username's
 *                         local part is (`nate@mstdn.social` for `nate`).
 *   1. `usernamePrefix` — the username starts with the term (`nateisern`).
 *   2. `nameExact`      — the display name, the composed first+last name, the
 *                         first name or the last name IS the term.
 *   3. `namePrefix`     — the display name, first name or last name starts with
 *                         the term, or a later WORD of the display/full name
 *                         does (`Notas de Nate`).
 *   4. `substring`      — the term appears anywhere in the username or a name.
 *   5. `other`          — everything else the match admitted: the description
 *                         (bio), a location (`GET /search`), or a linked
 *                         identity whose canonical row matched through an alias.
 *
 * Exported for tests and documentation; {@link peopleSearchRelevance} renders it.
 */
export const PEOPLE_SEARCH_TIERS = {
  exactHandle: 0,
  usernamePrefix: 1,
  nameExact: 2,
  namePrefix: 3,
  substring: 4,
  other: 5,
} as const;

/**
 * The relevance tier ({@link PEOPLE_SEARCH_TIERS}) of each row for `term`, as a
 * SQL integer expression.
 *
 * It ORDERS; it never filters. `peopleSearchMatch` decides which rows are in the
 * result and this only ranks them, so it is evaluated over the matched set alone
 * (after the trigram/prefix indexes have narrowed it) and needs no index of its
 * own. Every comparison is case-insensitive and the term is LIKE-escaped and
 * bound, exactly as in the match.
 *
 * A pasted upstream profile URL is ranked by the username it resolves to, the
 * same substitution `peopleSearchMatch` makes, so its single answer is tier 0.
 */
export function peopleSearchRelevance(term: string): SQL {
  const rankTerm = federatedUsernameFromUpstreamUrl(term) ?? term;
  const escaped = escapeLikeTerm(rankTerm);
  const exact = sql`lower(${rankTerm}::text)`;
  const prefix = sql`lower(${`${escaped}%`}::text)`;
  const wordPrefix = sql`lower(${`% ${escaped}%`}::text)`;
  const contains = `%${escaped}%`;
  const username = sql`lower(btrim(${users.username}))`;
  const fullName = sql`lower(btrim(concat_ws(' ', ${users.nameFirst}, ${users.nameLast})))`;
  const display = sql`lower(btrim(${users.nameDisplay}))`;
  const first = sql`lower(btrim(${users.nameFirst}))`;
  const last = sql`lower(btrim(${users.nameLast}))`;
  const tier = PEOPLE_SEARCH_TIERS;

  return sql`(case
    when ${username} = ${exact}
      or (${users.type} = 'federated' and split_part(${username}, '@', 1) = ${exact})
      then ${sql.raw(String(tier.exactHandle))}
    when ${username} like ${prefix} then ${sql.raw(String(tier.usernamePrefix))}
    when ${display} = ${exact} or ${fullName} = ${exact} or ${first} = ${exact} or ${last} = ${exact}
      then ${sql.raw(String(tier.nameExact))}
    when ${display} like ${prefix} or ${display} like ${wordPrefix}
      or ${fullName} like ${wordPrefix}
      or ${first} like ${prefix} or ${last} like ${prefix}
      then ${sql.raw(String(tier.namePrefix))}
    when ${users.username} ilike ${contains} or ${users.nameFirst} ilike ${contains}
      or ${users.nameLast} ilike ${contains} or ${users.nameDisplay} ilike ${contains}
      then ${sql.raw(String(tier.substring))}
    else ${sql.raw(String(tier.other))}
  end)`;
}

/**
 * The ONE ordering every people-search surface applies (`GET /profiles/search`,
 * `GET /search`, `POST /users/search`), before paging:
 *
 *   1. relevance tier ascending — {@link peopleSearchRelevance}
 *   2. native (local, agent, automated) before federated, WITHIN a tier
 *   3. higher reputation rank first
 *   4. shorter username first — the closest completion of a prefix
 *      (`natehill` before `natediggitydawg`); a key-only row (no username) last
 *   5. `id` ascending as the FINAL tiebreaker
 *
 * Relevance is the primary key and origin only the second, deliberately: a
 * federated account whose handle IS the query (`nate@mstdn.social` for `nate`)
 * ranks above a local account that merely contains it (`notasdenate`). Within
 * one tier a local account always comes first, so the account a messaging app
 * can actually reach is not pushed down by remote actors that match equally.
 *
 * The last key is load-bearing, not decoration. `id` is unique, so the
 * composite key is a STRICT TOTAL ORDER: two rows can never compare equal, and
 * an `offset`/`limit` page therefore cannot show a row twice or skip one. Drop
 * it and infinite scroll corrupts with no error and no failing request.
 */
export function peopleSearchOrder(term: string): SQL[] {
  return [
    sql`${peopleSearchRelevance(term)} asc`,
    sql`(case when ${users.type} = 'federated' then 1 else 0 end) asc`,
    sql`${users.reputationRankWeight} desc`,
    sql`char_length(btrim(${users.username})) asc nulls last`,
    sql`${users.id} asc`,
  ];
}

/** Optional narrowing of a people search by the row's own `type` / `kind`. */
export interface PeopleSearchFilters {
  /** `users.type`: `local` is an Oxy account, `federated` a remote actor. */
  type?: (typeof USER_TYPES)[number];
  /** `users.kind`: `personal`, `organization`, `bot`, … */
  kind?: AccountKind;
}

/**
 * The `type` / `kind` narrowing of `GET /profiles/search`, or `undefined` when
 * neither is asked for.
 *
 * Applied to the row that is RETURNED (the canonical row of a linked identity),
 * on top of — never instead of — {@link peopleSearchPredicate}, so it can only
 * remove rows search would otherwise show. Both values are already on every
 * result (`type`, `kind`), so a filter reveals nothing the unfiltered search
 * did not.
 */
export function peopleSearchFilterPredicate(filters: PeopleSearchFilters): SQL | undefined {
  return and(
    filters.type ? eq(users.type, filters.type) : undefined,
    filters.kind ? eq(users.kind, filters.kind) : undefined,
  );
}

/**
 * Whether a hydrated user view may appear on people-discovery surfaces
 * (ActivityPub actor lookup, profile shells, etc.).
 */
export function isDiscoverableUser(
  user: { accountStatus?: string; reputationTier?: string } | null | undefined,
): boolean {
  return !!user && user.accountStatus !== 'archived' && user.reputationTier !== 'restricted';
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
 * Whether an account's ActivityPub actor is GONE FOR GOOD, to be answered
 * `410 Gone` rather than 404: a local, non-personal account (a channel, a
 * community, an organization, a project, a bot) that was archived.
 *
 * Permanent because the archive is: it writes a closure fence, nothing restores
 * an archived account, and the row keeps its handle (`users_lower_username_key`
 * is not partial), so nobody can register the name again. The answer lasts as
 * long as the row does, with nothing kept beside it.
 *
 * A personal account is excluded. Its deletion is a privacy erasure, and the
 * relying app answers 410 only while its own ledger keeps the handle (Mention:
 * `account_erasures`, 14 days), whether Oxy deleted the row or archived it to
 * retain financial records. A federated row is a remote actor, never ours to
 * answer for.
 */
export function isPermanentlyGoneActor(
  user: { kind?: string; type?: string; accountStatus?: string } | null | undefined,
): boolean {
  return (
    !!user &&
    user.accountStatus === 'archived' &&
    user.kind !== 'personal' &&
    user.type !== 'federated'
  );
}

/**
 * A federated actor is only recommendable while it is still RESOLVING: it must
 * carry an actor URI and a domain, have been re-resolved inside the freshness
 * window, and not have been marked unavailable. Non-federated accounts pass
 * unconditionally.
 */
export function federatedRecommendationEligibility(minResolvedAt: Date): SQL {
  return (
    or(
      ne(users.type, 'federated'),
      and(
        eq(users.type, 'federated'),
        nonEmpty(sql`${users.federationActorUri}`),
        nonEmpty(sql`${users.federationDomain}`),
        gte(users.federationLastResolvedAt, minResolvedAt),
        isNull(users.federationUnavailableAt),
      ),
    ) ?? sql`true`
  );
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
    nonEmpty(sql`${users.nameDisplay}`),
    nonEmpty(sql`${users.bio}`),
    nonEmpty(sql`${users.description}`),
    eq(users.verified, true),
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
      discoverableUserPredicate(),
    ) ?? sql`true`
  );
}
