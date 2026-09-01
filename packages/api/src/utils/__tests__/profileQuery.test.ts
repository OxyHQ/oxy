/**
 * Profile-discovery predicates, executed against a REAL Postgres.
 *
 * The suite this replaces asserted the SHAPE of a Mongo match object —
 * `expect(match.$and).toEqual(expect.arrayContaining([{ accountStatus: { $ne:
 * 'archived' } }]))`. That assertion could not distinguish a predicate that
 * excludes archived accounts from one that merely mentions them, and both of
 * its subjects (`buildPeopleSearchOrClause`, `eligibleUserMatch`) were deleted
 * by the port. Every case below instead seeds rows whose visibility is KNOWN,
 * runs the predicate as the `where` of a real query, and asserts exactly which
 * ids come back.
 *
 * Two of these can only be caught against a database:
 *
 * - **The correlated subquery in {@link peopleSearchMatch}.** A drizzle column
 *   interpolated into `sql` renders BARE when its table is not in that
 *   statement's `FROM`, so `where ${userLocations.userId} = ${users.id}`
 *   becomes `where "user_id" = "id"` — both resolve against the subquery's own
 *   table, the predicate compares two of its own columns, and the query returns
 *   nothing WITH NO ERROR (`db/schema/CONVENTIONS.md`). The location cases
 *   below fail if `qualified()` is dropped.
 * - **{@link peopleSearchOrder} is a STRICT TOTAL ORDER.** Its third key
 *   (`id asc`) is what stops an `OFFSET`/`LIMIT` page from repeating or
 *   skipping a row when the first two keys tie. Rows with IDENTICAL type and
 *   rank weight are the only input that can tell a total order from a partial
 *   one.
 *
 * The whole run shares one database, so every row carries a per-test random id
 * and every query is scoped to the ids the test wrote — no assertion depends on
 * a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { and, inArray, type SQL } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userLocations } from '../../db/schema/userLocations';
import { users } from '../../db/schema/users';
import {
  discoverableUserPredicate,
  eligibleUserPredicate,
  FEDERATED_RECOMMENDATION_MAX_AGE_MS,
  federatedRecommendationEligibility,
  isDiscoverableUser,
  isFederatableUser,
  isPublicGraphTarget,
  peopleSearchMatch,
  peopleSearchOrder,
  peopleSearchPredicate,
  normalizePeopleSearchTerm,
  profileQualityPredicate,
} from '../profileQuery';

const uniqueId = () => randomUUID().replace(/-/g, '');

/**
 * A row that clears every quality/eligibility gate, so a test only has to state
 * the ONE property it is about. Without this a "rejects archived" case could
 * pass because the fixture also failed the profile-quality bar.
 */
function eligibleDefaults(id: string): typeof users.$inferInsert {
  return {
    id,
    // The FULL id, because `users` is unique on `lower(btrim(username))` and
    // ids that share a prefix are exactly what the ordering test needs.
    username: `u${id}`,
    nameFirst: 'Ada',
    nameLast: 'Lovelace',
    avatar: 'file-1',
    bio: 'Analytical engines',
    description: 'Mathematician',
  };
}

async function makeUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ ...eligibleDefaults(id), ...overrides });
  return id;
}

/** Ids matching `predicate`, restricted to the ids this test wrote. */
async function idsMatching(predicate: SQL, scope: string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, scope), predicate));
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('discoverableUserPredicate', () => {
  it('returns active accounts and excludes archived and restricted ones', async () => {
    const active = await makeUser();
    const archived = await makeUser({ accountStatus: 'archived' });
    const restricted = await makeUser({ reputationTier: 'restricted' });
    const scope = [active, archived, restricted];

    expect(await idsMatching(discoverableUserPredicate(), scope)).toEqual([active]);
  });

  it('keeps an account whose tier is punitive-adjacent but not `restricted`', async () => {
    const trusted = await makeUser({ reputationTier: 'trusted' });
    const brandNew = await makeUser({ reputationTier: 'new' });
    const scope = [trusted, brandNew];

    expect(await idsMatching(discoverableUserPredicate(), scope)).toEqual(
      [trusted, brandNew].sort()
    );
  });
});

describe('peopleSearchPredicate', () => {
  it('adds the private-account opt-out on top of discoverability', async () => {
    const findable = await makeUser();
    const priv = await makeUser({ privacyIsPrivateAccount: true });
    const archived = await makeUser({ accountStatus: 'archived' });
    const scope = [findable, priv, archived];

    expect(await idsMatching(peopleSearchPredicate(), scope)).toEqual([findable]);
    // The private account IS still discoverable — the two gates are distinct,
    // and conflating them would silently hide private accounts from the follow
    // graph too.
    expect(await idsMatching(discoverableUserPredicate(), scope)).toEqual(
      [findable, priv].sort()
    );
  });
});

describe('peopleSearchPredicate — account kind', () => {
  /**
   * PINS A PRODUCT DECISION THAT NOTHING ELSE PINNED.
   *
   * People search is BLIND to `users.kind`: a bot, an organization, a project
   * and a channel are all returned beside people, on every people surface
   * (`GET /search`, `GET /profiles/search`, `POST /users/search`), because all
   * three share this predicate and it has no kind clause.
   *
   * Before this test, no suite in the API seeded a non-personal account into a
   * search — every people-search case used `personal` rows. So adding a kind
   * clause here, which would remove every bot, organization and channel from
   * every search surface in the ecosystem at once, was a change CI COULD NOT
   * SEE. That is the failure this exists for: not that the current behaviour is
   * right, but that changing it must be a decision somebody makes on purpose.
   *
   * The exclusions are the control, and they are what stop this from being
   * vacuous. "Every kind comes back" is exactly what a predicate that had
   * stopped filtering ANYTHING would also produce, so a private bot and an
   * archived bot are seeded alongside: they must NOT come back, which proves
   * the predicate still discriminates and simply does not discriminate on kind.
   *
   * If this ever needs to change, the axis is almost certainly `published` vs
   * `unpublished` rather than kind — an organization exists to be found, and so
   * does a channel. `privacyIsPrivateAccount` already expresses that, as the
   * private bot below demonstrates.
   */
  it('returns EVERY account kind, while still excluding private and archived ones', async () => {
    const personal = await makeUser({ kind: 'personal' });
    const bot = await makeUser({ kind: 'bot' });
    const organization = await makeUser({ kind: 'organization' });
    const project = await makeUser({ kind: 'project' });
    const channel = await makeUser({ kind: 'channel' });
    // The controls. Same kind as one of the rows above, so the only thing that
    // can explain their absence is the gate rather than the kind.
    const privateBot = await makeUser({ kind: 'bot', privacyIsPrivateAccount: true });
    const archivedBot = await makeUser({ kind: 'bot', accountStatus: 'archived' });
    const scope = [personal, bot, organization, project, channel, privateBot, archivedBot];

    expect(await idsMatching(peopleSearchPredicate(), scope)).toEqual(
      [personal, bot, organization, project, channel].sort()
    );
  });
});

describe('normalizePeopleSearchTerm', () => {
  it('strips one leading @ and caps fuzzy terms at 100 characters', () => {
    const fuzzy = 'a'.repeat(120);
    expect(normalizePeopleSearchTerm(`@${fuzzy}`)).toHaveLength(100);
    expect(normalizePeopleSearchTerm(`@${fuzzy}`)).toBe(fuzzy.slice(0, 100));
  });

  it('keeps pasted profile URLs long enough for tracking parameters to parse', () => {
    const marker = uniqueId().slice(0, 8);
    const tracking = 't='.concat('x'.repeat(150));
    const url = `https://x.com/${marker}?s=20&${tracking}`;
    expect(url.length).toBeGreaterThan(100);
    expect(normalizePeopleSearchTerm(url)).toBe(url);
  });
});

describe('peopleSearchMatch — a pasted upstream profile URL', () => {
  /**
   * The owner's ask: paste an x.com / instagram.com / bsky.app profile link into
   * search and find the account we hold for that person. We hold them under the
   * federated username a bridge derived (`nasa@x.com`), which the substring match
   * can never reach from a URL — so without this branch, pasting the link a user
   * is looking at reports that we do not have the account.
   */
  it('finds the account a pasted x.com URL names', async () => {
    const marker = uniqueId().slice(0, 10);
    const bridged = await makeUser({ username: `${marker}@x.com`, type: 'federated' });
    const lookalike = await makeUser({ username: `${marker}@mastodon.social`, type: 'federated' });
    const scope = [bridged, lookalike];

    expect(await idsMatching(peopleSearchMatch(`https://x.com/${marker}`), scope))
      .toEqual([bridged]);
  });

  it('treats twitter.com and mobile.x.com as the same network, and ignores case', async () => {
    const marker = uniqueId().slice(0, 10);
    const bridged = await makeUser({ username: `${marker}@x.com`, type: 'federated' });
    const scope = [bridged];

    expect(await idsMatching(peopleSearchMatch(`https://twitter.com/${marker}`), scope))
      .toEqual([bridged]);
    expect(await idsMatching(peopleSearchMatch(`https://mobile.x.com/${marker}`), scope))
      .toEqual([bridged]);
    expect(await idsMatching(peopleSearchMatch(`https://x.com/${marker.toUpperCase()}`), scope))
      .toEqual([bridged]);
  });

  it('drops the tracking parameters a pasted link usually carries', async () => {
    const marker = uniqueId().slice(0, 10);
    const bridged = await makeUser({ username: `${marker}@x.com`, type: 'federated' });

    expect(await idsMatching(peopleSearchMatch(`https://x.com/${marker}?s=20&t=abc`), [bridged]))
      .toEqual([bridged]);
  });

  it('applies the Bluesky suffix rule, so a default handle URL still resolves', async () => {
    // The case a second parsing rule in this file would get wrong: the stored
    // username drops `.bsky.social`, so a literal parse finds nobody.
    const marker = uniqueId().slice(0, 10);
    const bridged = await makeUser({ username: `${marker}@bsky.social`, type: 'federated' });

    expect(await idsMatching(
      peopleSearchMatch(`https://bsky.app/profile/${marker}.bsky.social`),
      [bridged]
    )).toEqual([bridged]);
  });

  it('returns nothing — not noise — for a URL naming an account we do not hold', async () => {
    // "We do not have this account" is a fine answer and must look like one.
    const unrelated = await makeUser({ description: `mentions x.com/${uniqueId()} in passing` });

    expect(await idsMatching(peopleSearchMatch(`https://x.com/${uniqueId()}`), [unrelated]))
      .toEqual([]);
  });

  it('does not let a bio quoting the URL crowd out the precise answer', async () => {
    const marker = uniqueId().slice(0, 10);
    const bridged = await makeUser({ username: `${marker}@x.com`, type: 'federated' });
    const quoter = await makeUser({ description: `see https://x.com/${marker} for more` });
    const scope = [bridged, quoter];

    // A pasted URL is an exact request; whoever merely quotes it was not asked for.
    expect(await idsMatching(peopleSearchMatch(`https://x.com/${marker}`), scope))
      .toEqual([bridged]);
  });

  it('finds a row whose STORED username carries uppercase', async () => {
    // The comparison is written against `lower(btrim(username))` — the expression
    // the username unique index is built on, so it is an index seek rather than a
    // scan. It also has to hold for a row that is not already lowercased: every
    // other case here seeds a lowercase username, so a case-SENSITIVE comparison
    // passes all of them and only this one tells the two apart.
    const marker = uniqueId().slice(0, 10);
    const mixedCase = await makeUser({ username: `Mi${marker}@X.com`, type: 'federated' });

    expect(await idsMatching(peopleSearchMatch(`https://x.com/MI${marker}`), [mixedCase]))
      .toEqual([mixedCase]);
  });

  it('leaves an ordinary search term on the substring path', async () => {
    const marker = uniqueId().slice(0, 10);
    const byName = await makeUser({ nameFirst: marker });
    expect(await idsMatching(peopleSearchMatch(marker), [byName])).toEqual([byName]);
  });

  it('leaves a non-profile URL on the substring path', async () => {
    const marker = uniqueId().slice(0, 10);
    const quoter = await makeUser({ description: `https://mastodon.social/@${marker}` });
    expect(await idsMatching(peopleSearchMatch(`https://mastodon.social/@${marker}`), [quoter]))
      .toEqual([quoter]);
  });
});

describe('peopleSearchMatch', () => {
  it('matches username, first name, last name and description, case-insensitively', async () => {
    const marker = uniqueId().slice(0, 10);
    const byUsername = await makeUser({
      username: `zz${marker}`,
      nameFirst: 'None',
      nameLast: 'None',
      description: 'nothing',
    });
    const byFirst = await makeUser({
      nameFirst: marker.toUpperCase(),
      nameLast: 'None',
      description: 'nothing',
    });
    const byLast = await makeUser({
      nameFirst: 'None',
      nameLast: `${marker}son`,
      description: 'nothing',
    });
    const byDescription = await makeUser({
      nameFirst: 'None',
      nameLast: 'None',
      description: `Writes about ${marker} daily`,
    });
    const unrelated = await makeUser({
      nameFirst: 'None',
      nameLast: 'None',
      description: 'nothing',
    });
    const scope = [byUsername, byFirst, byLast, byDescription, unrelated];

    expect(await idsMatching(peopleSearchMatch(marker), scope)).toEqual(
      [byUsername, byFirst, byLast, byDescription].sort()
    );
  });

  it('drops description from the match when includeDescription is false', async () => {
    const marker = uniqueId().slice(0, 10);
    const byName = await makeUser({ nameFirst: marker, description: 'nothing' });
    const byDescription = await makeUser({
      nameFirst: 'None',
      description: `about ${marker}`,
    });
    const scope = [byName, byDescription];

    expect(
      await idsMatching(peopleSearchMatch(marker, { includeDescription: false }), scope)
    ).toEqual([byName]);
  });

  it('matches a location name, city or country only under includeLocations', async () => {
    const marker = uniqueId().slice(0, 10);
    const byLocationName = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const byCity = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const byCountry = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const elsewhere = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const scope = [byLocationName, byCity, byCountry, elsewhere];

    await getDb()
      .insert(userLocations)
      .values([
        { userId: byLocationName, locationKey: 'home', name: `Cafe ${marker}` },
        { userId: byCity, locationKey: 'home', name: 'Home', city: marker },
        { userId: byCountry, locationKey: 'home', name: 'Home', country: marker },
        { userId: elsewhere, locationKey: 'home', name: 'Home', city: 'Nowhere' },
      ]);

    // Without `includeLocations` a location must NOT widen the match.
    expect(await idsMatching(peopleSearchMatch(marker), scope)).toEqual([]);

    // With it, exactly the three located users come back. This is the assertion
    // that fails if the correlated subquery's references stop being qualified:
    // the bare-identifier form compares the subquery's own columns and returns
    // an empty set with no error, so the result would be `[]` here too.
    expect(
      await idsMatching(peopleSearchMatch(marker, { includeLocations: true }), scope)
    ).toEqual([byLocationName, byCity, byCountry].sort());
  });

  it('correlates each location to ITS OWN user, never to any located user', async () => {
    // The bare-identifier bug's OTHER failure mode: a subquery that ignores the
    // correlation matches every outer row as soon as ANY location matches. A
    // fixture with one located user cannot tell that from a correct answer.
    const marker = uniqueId().slice(0, 10);
    const located = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const unlocated = await makeUser({ nameFirst: 'None', description: 'nothing' });
    const scope = [located, unlocated];

    await getDb()
      .insert(userLocations)
      .values({ userId: located, locationKey: 'home', name: 'Home', city: marker });

    expect(
      await idsMatching(peopleSearchMatch(marker, { includeLocations: true }), scope)
    ).toEqual([located]);
  });

  it('treats LIKE metacharacters in the term as literal text', async () => {
    const marker = uniqueId().slice(0, 8);
    // `%` and `_` are LIKE wildcards; if the term is not escaped, `a%b` matches
    // this row's neighbour and the search silently widens.
    const literal = await makeUser({ nameFirst: `a%_${marker}`, description: 'nothing' });
    const decoy = await makeUser({ nameFirst: `axyb${marker}`, description: 'nothing' });
    const scope = [literal, decoy];

    expect(await idsMatching(peopleSearchMatch(`a%_${marker}`), scope)).toEqual([literal]);
    // A backslash must not escape the following character either.
    expect(await idsMatching(peopleSearchMatch(`a\\%_${marker}`), scope)).toEqual([]);
  });
});

describe('peopleSearchOrder', () => {
  it('orders native before federated, then by rank weight, then by id', async () => {
    const scope: string[] = [];
    // Three rows sharing type AND rank weight: the ONLY input that can tell the
    // `id asc` tiebreak from its absence. Ids are supplied and digits-only so
    // JS and every Postgres collation agree on their order. The shared prefix
    // keeps them adjacent in id order while staying unique across runs, which
    // the run-wide database requires.
    const tiedPrefix = uniqueId().replace(/\D/g, '').padEnd(20, '0').slice(0, 20);
    const tiedIds = ['3', '1', '2'].map((n) => `${tiedPrefix}${n.padStart(4, '0')}`);
    for (const id of tiedIds) {
      await getDb()
        .insert(users)
        .values({ ...eligibleDefaults(id), reputationRankWeight: 5 });
      scope.push(id);
    }

    const federated = await makeUser({ type: 'federated', reputationRankWeight: 99 });
    const highRankNative = await makeUser({ reputationRankWeight: 50 });
    scope.push(federated, highRankNative);

    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, scope))
      .orderBy(...peopleSearchOrder());

    expect(rows.map((row) => row.id)).toEqual([
      // Native first, highest rank weight first...
      highRankNative,
      // ...then the tied trio in ID order, which only the third key can produce.
      ...[...tiedIds].sort(),
      // ...and the federated account last despite the highest rank weight.
      federated,
    ]);
  });
});

describe('profileQualityPredicate', () => {
  it('requires a username plus at least one curated signal', async () => {
    const curatedByAvatar = await makeUser({
      avatar: 'file-1',
      nameFirst: null,
      nameLast: null,
      bio: null,
      description: null,
    });
    const curatedByVerified = await makeUser({
      avatar: null,
      nameFirst: null,
      nameLast: null,
      bio: null,
      description: null,
      verified: true,
    });
    const shell = await makeUser({
      avatar: null,
      nameFirst: null,
      nameLast: null,
      bio: null,
      description: null,
    });
    const keyOnly = await makeUser({ username: null });
    const scope = [curatedByAvatar, curatedByVerified, shell, keyOnly];

    expect(await idsMatching(profileQualityPredicate(), scope)).toEqual(
      [curatedByAvatar, curatedByVerified].sort()
    );
  });

  it('rejects a value the backfill carried over as the empty string', async () => {
    // `''` is forbidden as a DEFAULT but reaches this predicate from migrated
    // rows, which is why the check is `is not null and <> ''` and not just
    // `is not null`. A row whose every curated field is `''` is a shell.
    const emptyStrings = await makeUser({
      avatar: '',
      nameFirst: '',
      nameLast: '',
      bio: '',
      description: '',
    });
    const emptyUsername = await makeUser({ username: '' });
    const scope = [emptyStrings, emptyUsername];

    expect(await idsMatching(profileQualityPredicate(), scope)).toEqual([]);
  });
});

describe('federatedRecommendationEligibility', () => {
  const minResolvedAt = () => new Date(Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS);

  /** `federation_actor_uri` is UNIQUE, so every fixture needs its own. */
  const federatedActor = (overrides: Partial<typeof users.$inferInsert> = {}) => ({
    type: 'federated' as const,
    federationActorUri: `https://remote.test/users/${uniqueId()}`,
    federationDomain: 'remote.test',
    federationLastResolvedAt: new Date(),
    ...overrides,
  });

  it('passes a non-federated account unconditionally', async () => {
    const local = await makeUser();
    expect(await idsMatching(federatedRecommendationEligibility(minResolvedAt()), [local])).toEqual([
      local,
    ]);
  });

  it('passes a federated actor that is complete, fresh and available', async () => {
    const fresh = await makeUser(federatedActor());
    expect(await idsMatching(federatedRecommendationEligibility(minResolvedAt()), [fresh])).toEqual([
      fresh,
    ]);
  });

  it('rejects a federated actor that is stale, unavailable, or missing its identifiers', async () => {
    const stale = await makeUser(
      federatedActor({
        federationLastResolvedAt: new Date(
          Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS - 60_000
        ),
      })
    );
    const unavailable = await makeUser(
      federatedActor({ federationUnavailableAt: new Date() })
    );
    const noUri = await makeUser(federatedActor({ federationActorUri: null }));
    const noDomain = await makeUser(federatedActor({ federationDomain: null }));
    const neverResolved = await makeUser(
      federatedActor({ federationLastResolvedAt: null })
    );
    const scope = [stale, unavailable, noUri, noDomain, neverResolved];

    expect(await idsMatching(federatedRecommendationEligibility(minResolvedAt()), scope)).toEqual(
      []
    );
  });
});

describe('eligibleUserPredicate', () => {
  const minResolvedAt = () => new Date(Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS);

  it('admits an account that clears every gate at once', async () => {
    const eligible = await makeUser();
    expect(await idsMatching(eligibleUserPredicate(minResolvedAt()), [eligible])).toEqual([
      eligible,
    ]);
  });

  it('rejects an account failing ANY ONE gate while passing the rest', async () => {
    // Each fixture differs from the eligible one above in exactly one property,
    // so a gate that stopped being enforced fails here by name rather than
    // hiding behind another gate that happens to reject the same row.
    const archived = await makeUser({ accountStatus: 'archived' });
    const restricted = await makeUser({ reputationTier: 'restricted' });
    const sensitive = await makeUser({ isSensitive: true });
    const shell = await makeUser({
      avatar: null,
      nameFirst: null,
      nameLast: null,
      bio: null,
      description: null,
    });
    const staleFederated = await makeUser({
      type: 'federated',
      federationActorUri: `https://remote.test/users/${uniqueId()}`,
      federationDomain: 'remote.test',
      federationLastResolvedAt: new Date(
        Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS - 60_000
      ),
    });
    const scope = [archived, restricted, sensitive, shell, staleFederated];

    expect(await idsMatching(eligibleUserPredicate(minResolvedAt()), scope)).toEqual([]);
  });

  it('does NOT read the account-sensitive flag off the viewer preference column', async () => {
    // `is_sensitive` is the moderation flag; `privacy_sensitive_content` is the
    // viewer's own preference. Confusing the two would hide every account that
    // merely opted into seeing sensitive content.
    const optedIntoSeeingSensitive = await makeUser({ privacySensitiveContent: true });
    expect(
      await idsMatching(eligibleUserPredicate(minResolvedAt()), [optedIntoSeeingSensitive])
    ).toEqual([optedIntoSeeingSensitive]);
  });
});

describe('isDiscoverableUser', () => {
  it('accepts active users without a reputation tier', () => {
    expect(isDiscoverableUser({ accountStatus: 'active' })).toBe(true);
  });

  it('rejects archived accounts', () => {
    expect(isDiscoverableUser({ accountStatus: 'archived' })).toBe(false);
  });

  it('rejects restricted-tier accounts', () => {
    expect(isDiscoverableUser({ accountStatus: 'active', reputationTier: 'restricted' })).toBe(
      false
    );
  });

  it('rejects a null or undefined user', () => {
    expect(isDiscoverableUser(null)).toBe(false);
    expect(isDiscoverableUser(undefined)).toBe(false);
  });

  it('agrees with the SQL predicate over the same stored rows', async () => {
    // The in-memory predicate and the SQL one are two spellings of one rule and
    // are applied to the same accounts at different layers; a divergence shows
    // up as a row that a list query returns and the hydrated check then hides.
    const active = await makeUser();
    const archived = await makeUser({ accountStatus: 'archived' });
    const restricted = await makeUser({ reputationTier: 'restricted' });
    const scope = [active, archived, restricted];

    const rows = await getDb()
      .select({
        id: users.id,
        accountStatus: users.accountStatus,
        reputationTier: users.reputationTier,
      })
      .from(users)
      .where(inArray(users.id, scope));

    const inMemory = rows.filter(isDiscoverableUser).map((row) => row.id).sort();
    expect(inMemory).toEqual(await idsMatching(discoverableUserPredicate(), scope));
  });
});

describe('isPublicGraphTarget', () => {
  it('accepts discoverable users without a private-account flag', () => {
    expect(isPublicGraphTarget({ accountStatus: 'active', reputationTier: 'trusted' })).toBe(true);
  });

  it('rejects private accounts', () => {
    expect(
      isPublicGraphTarget({
        accountStatus: 'active',
        reputationTier: 'trusted',
        privacySettings: { isPrivateAccount: true },
      })
    ).toBe(false);
  });

  it('rejects archived and restricted users', () => {
    expect(isPublicGraphTarget({ accountStatus: 'archived' })).toBe(false);
    expect(isPublicGraphTarget({ accountStatus: 'active', reputationTier: 'restricted' })).toBe(
      false
    );
  });
});

describe('isFederatableUser', () => {
  it('accepts discoverable users with sharing enabled or unset', () => {
    expect(isFederatableUser({ accountStatus: 'active' })).toBe(true);
    expect(
      isFederatableUser({ accountStatus: 'active', privacySettings: { fediverseSharing: true } })
    ).toBe(true);
  });

  it('rejects users who opted out of fediverse sharing', () => {
    expect(
      isFederatableUser({
        accountStatus: 'active',
        privacySettings: { fediverseSharing: false },
      })
    ).toBe(false);
  });

  it('rejects archived and restricted users regardless of sharing', () => {
    expect(
      isFederatableUser({
        accountStatus: 'archived',
        privacySettings: { fediverseSharing: true },
      })
    ).toBe(false);
    expect(
      isFederatableUser({
        accountStatus: 'active',
        reputationTier: 'restricted',
        privacySettings: { fediverseSharing: true },
      })
    ).toBe(false);
  });
});
