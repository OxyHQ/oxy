/**
 * `getLeaderboard` — eligibility, ordering and paging, against a real Postgres.
 *
 * The suite this replaces asserted on a MONGO AGGREGATION PIPELINE: it mocked
 * `ReputationBalance.aggregate` and then compared the `$lookup` / `$unwind` /
 * `$match` stage objects the service passed it against a literal copy of the
 * same stages written in the test. That is a check that can only ever confirm
 * the test and the implementation contain the same JSON — it would have passed
 * against a pipeline that matched the wrong field, and it fails now for the
 * only reason it ever could: there is no pipeline. The reads are a drizzle
 * `INNER JOIN` with a `<>` predicate.
 *
 * The three properties worth holding, all asserted against rows written here:
 *
 *  - **Ineligibility is by USER, not by balance.** The gate reads
 *    `users.account_status` and `users.reputation_tier` — the tier denormalized
 *    onto the account by `recalculateBalance`, NOT `reputation_balances.trust_tier`.
 *    The restricted fixture below therefore carries a large positive balance and
 *    a restricted USER tier: a board that filtered on the balance's own column
 *    would rank it second and fail here.
 *  - **The join is INNER.** An account with no balance row is absent, rather
 *    than appearing with a null total.
 *  - **`total` is the count of ELIGIBLE rows and is independent of the page.**
 *
 * SCOPING, since the whole run shares one database and other suites write
 * `reputation_balances` concurrently: every account here is awarded a total in
 * the 900-million range, far above anything any other suite produces, so this
 * file's rows are deterministically the top of the board and the exclusion
 * assertions read the page rather than a global count. Nothing below asserts an
 * exact global `total`, which no suite can own.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import reputationService from '../reputation.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

/**
 * Each test claims its own BAND of totals, strictly above every band claimed
 * before it, so the head of the board belongs to the running test alone: large
 * enough to outrank anything a concurrent suite writes, and rising so that this
 * file's own earlier fixtures cannot tie with it either. Within a band the gaps
 * are 1, so an ineligible account that leaked through would land BETWEEN two
 * eligible ones and be caught by an ordering assertion rather than only by a
 * membership one.
 */
let bandsClaimed = 0;
function nextBand(): number {
  bandsClaimed += 1;
  return 900_000_000 + bandsClaimed * 1_000;
}

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({
      id,
      username: `lb${id}`,
      nameFirst: 'Board',
      nameLast: 'Member',
      avatar: `avatar-${id}`,
      publicKey: `pk-${id}`,
    });
  return id;
}

/**
 * Award `points` through the real service, so the balance row AND the
 * denormalized `users.reputation_tier` are both written by production code
 * rather than by the fixture.
 */
async function makeRanked(points: number): Promise<string> {
  const userId = await makeUser();
  const actionType = `leaderboard_${uniqueId().slice(0, 12)}`;
  await reputationService.upsertRule({
    actionType,
    points,
    category: 'content',
    description: 'leaderboard fixture',
    cooldownInMinutes: 0,
    isEnabled: true,
  });
  await reputationService.award({ userId, actionType });
  return userId;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getLeaderboard ranks eligible accounts and hides the rest', () => {
  it('returns the eligible accounts in descending total, with the joined identity', async () => {
    const band = nextBand();
    const first = await makeRanked(band);
    const second = await makeRanked(band - 3);

    const { items } = await reputationService.getLeaderboard(2, 0);

    expect(items).toHaveLength(2);
    expect(items.map((row) => row.user.id)).toEqual([first, second]);
    expect(items[0].total).toBe(band);
    expect(items[1].total).toBe(band - 3);
    // The identity comes from the JOIN, not from the balance row.
    expect(items[0].user).toEqual({
      id: first,
      username: `lb${first}`,
      nameFirst: 'Board',
      nameLast: 'Member',
      avatar: `avatar-${first}`,
      publicKey: `pk-${first}`,
    });
    expect(items[0].trustTier).toBe('high_trust');
  });

  it('hides an ARCHIVED account that would otherwise rank second', async () => {
    const band = nextBand();
    const eligible = await makeRanked(band);
    const archived = await makeRanked(band - 1);
    const behind = await makeRanked(band - 3);
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, archived));

    const { items } = await reputationService.getLeaderboard(2, 0);

    // The archived account outranks `behind`, so a missing gate would put it in
    // slot 2 — the ordering assertion catches it, not just the membership one.
    expect(items.map((row) => row.user.id)).toEqual([eligible, behind]);
  });

  it('hides a RESTRICTED account, reading the tier off the USER row', async () => {
    // The discriminating half: this account's BALANCE says `high_trust` (its
    // total is large and positive) while its USER tier says `restricted`. A
    // board that filtered on `reputation_balances.trust_tier` would rank it
    // second; the one that filters on `users.reputation_tier` hides it.
    const band = nextBand();
    const eligible = await makeRanked(band);
    const restricted = await makeRanked(band - 1);
    const behind = await makeRanked(band - 3);
    await getDb()
      .update(users)
      .set({ reputationTier: 'restricted' })
      .where(eq(users.id, restricted));

    const { items } = await reputationService.getLeaderboard(2, 0);

    expect(items.map((row) => row.user.id)).toEqual([eligible, behind]);
  });

  it('omits an account that has no balance row at all — the join is INNER', async () => {
    const ranked = await makeRanked(nextBand());
    const unranked = await makeUser();

    const { items } = await reputationService.getLeaderboard(5, 0);

    expect(items.map((row) => row.user.id)).toContain(ranked);
    expect(items.map((row) => row.user.id)).not.toContain(unranked);
  });
});

describe('paging', () => {
  it('walks the ranking with offset, without repeating or skipping a row', async () => {
    const band = nextBand();
    const first = await makeRanked(band);
    const second = await makeRanked(band - 1);
    const third = await makeRanked(band - 2);

    const pageOne = await reputationService.getLeaderboard(1, 0);
    const pageTwo = await reputationService.getLeaderboard(1, 1);
    const pageThree = await reputationService.getLeaderboard(1, 2);

    expect(pageOne.items.map((row) => row.user.id)).toEqual([first]);
    expect(pageTwo.items.map((row) => row.user.id)).toEqual([second]);
    expect(pageThree.items.map((row) => row.user.id)).toEqual([third]);
  });

  it('reports the same eligible COUNT whichever page is asked for', async () => {
    // The count is the size of the eligible set, not of the page — the one
    // property of `total` a shared database still lets a test own outright.
    const band = nextBand();
    await makeRanked(band);
    await makeRanked(band - 1);

    const pageOne = await reputationService.getLeaderboard(1, 0);
    const pageTwo = await reputationService.getLeaderboard(1, 1);

    expect(pageOne.total).toBe(pageTwo.total);
    expect(pageOne.total).toBeGreaterThan(pageOne.items.length);
    expect(pageOne.items).toHaveLength(1);
  });

  it('answers an offset past the end with no items and the unchanged count', async () => {
    await makeRanked(nextBand());
    const { total } = await reputationService.getLeaderboard(1, 0);

    const beyond = await reputationService.getLeaderboard(10, total + 50);

    expect(beyond.items).toEqual([]);
    // A count derived from the PAGE would collapse to zero here.
    expect(beyond.total).toBeGreaterThanOrEqual(total);
  });
});
