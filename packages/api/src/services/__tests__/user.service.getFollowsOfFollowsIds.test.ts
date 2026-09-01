/**
 * `getFollowsOfFollowsIds` — the viewer's bounded two-hop follow walk.
 *
 * Candidates are the accounts followed by the accounts the viewer follows,
 * MINUS the viewer's own follows and the viewer, ranked by how many of the
 * sampled first-hop follows follow each candidate (frequency), then recency.
 *
 * The suite this replaces asserted the `$limit` stages of the aggregation —
 * "seeds the second hop with only the MAX_FOF_FIRST_HOP most-recent follows"
 * was checked by reading a number out of a pipeline stage. That is the
 * definition restated, not a measurement: a `$limit` placed after the grouping
 * instead of before it carries the same number and bounds nothing.
 *
 * The ordering is the part that carries product meaning and the part a shape
 * check cannot see, so the fixtures below build a candidate set whose expected
 * RANK is known and assert the sequence.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import {
  MAX_FOF_FIRST_HOP,
  MAX_FOLLOWS_OF_FOLLOWS_IDS,
} from '../../utils/recommendationWeights';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUsers(
  count: number,
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uniqueId());
  await getDb()
    .insert(users)
    .values(ids.map((id) => ({ id, username: `u${id}`, ...overrides })));
  return ids;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the two-hop walk', () => {
  it('returns the union of second-hop accounts, excluding self and own follows', async () => {
    const [viewer, hopA, hopB, candidate, alsoFollowedByViewer] = await makeUsers(5);

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hopA },
        { followerId: viewer, followedId: hopB },
        { followerId: viewer, followedId: alsoFollowedByViewer },
        // Second hop.
        { followerId: hopA, followedId: candidate },
        // Already followed by the viewer — not a recommendation.
        { followerId: hopB, followedId: alsoFollowedByViewer },
        // The viewer themselves — never a recommendation.
        { followerId: hopA, followedId: viewer },
      ]);

    const ids = await userService.getFollowsOfFollowsIds(viewer);

    expect(ids).toEqual([candidate]);
    expect(ids).not.toContain(viewer);
    expect(ids).not.toContain(hopA);
    expect(ids).not.toContain(alsoFollowedByViewer);
  });

  it('ranks by how many of the viewer’s follows follow each candidate', async () => {
    const [viewer, hopA, hopB, hopC, popular, twice, once] = await makeUsers(7);

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hopA },
        { followerId: viewer, followedId: hopB },
        { followerId: viewer, followedId: hopC },
        // `popular` is followed by all three first-hop accounts.
        { followerId: hopA, followedId: popular },
        { followerId: hopB, followedId: popular },
        { followerId: hopC, followedId: popular },
        // `twice` by two of them.
        { followerId: hopA, followedId: twice },
        { followerId: hopB, followedId: twice },
        // `once` by one.
        { followerId: hopC, followedId: once },
      ]);

    // The exact sequence: frequency is the product signal, and a query that
    // merely returns the right SET would satisfy a membership assertion.
    expect(await userService.getFollowsOfFollowsIds(viewer)).toEqual([popular, twice, once]);
  });

  it('breaks a frequency tie with the most recent second-hop edge', async () => {
    const [viewer, hop, older, newer] = await makeUsers(4);

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hop },
        {
          followerId: hop,
          followedId: older,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          followerId: hop,
          followedId: newer,
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ]);

    expect(await userService.getFollowsOfFollowsIds(viewer)).toEqual([newer, older]);
  });

  it('excludes an archived or restricted-tier candidate', async () => {
    const [viewer, hop, visible] = await makeUsers(3);
    const [archived] = await makeUsers(1, { accountStatus: 'archived' });
    const [restricted] = await makeUsers(1, { reputationTier: 'restricted' });

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hop },
        { followerId: hop, followedId: visible },
        { followerId: hop, followedId: archived },
        { followerId: hop, followedId: restricted },
      ]);

    expect(await userService.getFollowsOfFollowsIds(viewer)).toEqual([visible]);
  });
});

describe('bounds', () => {
  it('seeds the second hop with only the MAX_FOF_FIRST_HOP most-recent follows', async () => {
    // The real cap, measured. The viewer follows one more account than the
    // first-hop sample admits; the OLDEST of those follows is the one dropped,
    // so the candidate reachable only through it must not appear while a
    // candidate reachable through a sampled follow must.
    const hopCount = MAX_FOF_FIRST_HOP + 1;
    const [viewer, reachable, unreachable] = await makeUsers(3);
    const hops = await makeUsers(hopCount);

    const base = Date.now();
    await getDb()
      .insert(userFollows)
      .values(
        hops.map((hopId, index) => ({
          followerId: viewer,
          followedId: hopId,
          // Index 0 is the OLDEST, so it falls outside the most-recent sample.
          createdAt: new Date(base + index * 1000),
        }))
      );

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: hops[0], followedId: unreachable },
        { followerId: hops[hopCount - 1], followedId: reachable },
      ]);

    const ids = await userService.getFollowsOfFollowsIds(viewer);

    expect(ids).toContain(reachable);
    // The discriminating half: without the first-hop bound this id comes back.
    expect(ids).not.toContain(unreachable);
  }, 60_000);

  it('honours a caller limit smaller than the cap, keeping the highest-ranked', async () => {
    const [viewer, hopA, hopB, popular, single] = await makeUsers(5);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hopA },
        { followerId: viewer, followedId: hopB },
        { followerId: hopA, followedId: popular },
        { followerId: hopB, followedId: popular },
        { followerId: hopA, followedId: single },
      ]);

    // A limit that truncates must keep the TOP of the ranking, not an arbitrary
    // row — otherwise the bound quietly degrades the recommendation.
    expect(await userService.getFollowsOfFollowsIds(viewer, { limit: 1 })).toEqual([popular]);
  });

  it('clamps an over-cap limit to MAX_FOLLOWS_OF_FOLLOWS_IDS', async () => {
    const [viewer, hop, candidate] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hop },
        { followerId: hop, followedId: candidate },
      ]);

    const ids = await userService.getFollowsOfFollowsIds(viewer, {
      limit: MAX_FOLLOWS_OF_FOLLOWS_IDS * 10,
    });

    expect(ids).toEqual([candidate]);
    expect(ids.length).toBeLessThanOrEqual(MAX_FOLLOWS_OF_FOLLOWS_IDS);
  });

  it('treats a zero or negative limit as "use the cap"', async () => {
    const [viewer, hop, candidate] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hop },
        { followerId: hop, followedId: candidate },
      ]);

    expect(await userService.getFollowsOfFollowsIds(viewer, { limit: 0 })).toEqual([candidate]);
    expect(await userService.getFollowsOfFollowsIds(viewer, { limit: -3 })).toEqual([candidate]);
  });
});

describe('degenerate viewers', () => {
  it('returns empty for an anonymous viewer', async () => {
    expect(await userService.getFollowsOfFollowsIds(undefined)).toEqual([]);
    expect(await userService.getFollowsOfFollowsIds('')).toEqual([]);
  });

  it('returns empty for a viewer who follows nobody', async () => {
    const [viewer, admirer] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: admirer, followedId: viewer });

    expect(await userService.getFollowsOfFollowsIds(viewer)).toEqual([]);
  });

  it('returns empty when the first hop leads nowhere', async () => {
    const [viewer, hop] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: viewer, followedId: hop });

    expect(await userService.getFollowsOfFollowsIds(viewer)).toEqual([]);
  });
});
