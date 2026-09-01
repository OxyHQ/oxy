/**
 * `getMutualUserIds` — the VIEWER's own bidirectional follow edges, ids only.
 *
 * This is the SELF intersection `following(viewer) ∩ followers(viewer)`, and it
 * seeds Mention's "Mutuals" feed. Distinct from `getUserMutuals`, which answers
 * "followers you know" about ANOTHER profile.
 *
 * The suite this replaces asserted the two-query pipeline's SHAPE — that the
 * second query was skipped when the first returned nothing, that a `$limit`
 * stage carried a particular number. Neither says the returned set is the right
 * one. The two failures that actually matter here are both invisible to a
 * shape check:
 *
 *  - the intersection is BIDIRECTIONAL, so a one-way follow must not appear —
 *    a second query keyed on the wrong column returns the viewer's whole
 *    following list and looks entirely plausible;
 *  - archived/restricted accounts are dropped AFTER the intersection, so an
 *    ineligible mutual must not survive.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { MAX_MUTUAL_IDS } from '../../utils/recommendationWeights';
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

/** Make `mutualIds` mutual with `viewer`, and `oneWayIds` followed-only. */
async function seedGraph(
  viewer: string,
  mutualIds: string[],
  oneWayIds: string[] = []
): Promise<void> {
  const edges = [
    ...mutualIds.flatMap((id) => [
      { followerId: viewer, followedId: id },
      { followerId: id, followedId: viewer },
    ]),
    ...oneWayIds.map((id) => ({ followerId: viewer, followedId: id })),
  ];
  if (edges.length > 0) {
    await getDb().insert(userFollows).values(edges);
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the intersection is bidirectional', () => {
  it('returns only the accounts the viewer follows that follow back', async () => {
    const [viewer, mutualA, mutualB, oneWayOut, oneWayIn] = await makeUsers(5);
    await seedGraph(viewer, [mutualA, mutualB], [oneWayOut]);
    // Follows the viewer but is not followed back — the other one-way case.
    await getDb().insert(userFollows).values({ followerId: oneWayIn, followedId: viewer });

    const ids = await userService.getMutualUserIds(viewer);

    expect([...ids].sort()).toEqual([mutualA, mutualB].sort());
    expect(ids).not.toContain(oneWayOut);
    expect(ids).not.toContain(oneWayIn);
  });

  it('is empty when every edge is one-way', async () => {
    const [viewer, outbound, inbound] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: outbound },
        { followerId: inbound, followedId: viewer },
      ]);

    expect(await userService.getMutualUserIds(viewer)).toEqual([]);
  });

  it('does not report another user’s mutuals', async () => {
    const [viewer, stranger, theirMutual] = await makeUsers(3);
    await seedGraph(stranger, [theirMutual]);

    expect(await userService.getMutualUserIds(viewer)).toEqual([]);
  });
});

describe('ineligible mutuals are dropped after the intersection', () => {
  it.each([
    ['archived', { accountStatus: 'archived' as const }],
    ['restricted', { reputationTier: 'restricted' as const }],
  ])('excludes a %s mutual while keeping the eligible ones', async (_label, overrides) => {
    const [viewer, eligible] = await makeUsers(2);
    const [ineligible] = await makeUsers(1, overrides);
    await seedGraph(viewer, [eligible, ineligible]);

    const ids = await userService.getMutualUserIds(viewer);

    expect(ids).toEqual([eligible]);
  });
});

describe('ordering and bounds', () => {
  it('returns the most recently established mutuals first', async () => {
    const [viewer, older, newer] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: older },
        { followerId: viewer, followedId: newer },
        // The INBOUND edges are the ones ordered — that is what "established"
        // means for a mutual.
        { followerId: older, followedId: viewer, createdAt: new Date('2026-01-01T00:00:00Z') },
        { followerId: newer, followedId: viewer, createdAt: new Date('2026-06-01T00:00:00Z') },
      ]);

    expect(await userService.getMutualUserIds(viewer)).toEqual([newer, older]);
  });

  it('honours a caller limit smaller than the cap', async () => {
    const [viewer, ...mutuals] = await makeUsers(6);
    await seedGraph(viewer, mutuals);

    const ids = await userService.getMutualUserIds(viewer, { limit: 2 });

    expect(ids).toHaveLength(2);
    // Every returned id is a real mutual, not merely the right count.
    for (const id of ids) {
      expect(mutuals).toContain(id);
    }
  });

  it('clamps an over-cap limit to MAX_MUTUAL_IDS', async () => {
    const [viewer, ...mutuals] = await makeUsers(4);
    await seedGraph(viewer, mutuals);

    // The cap is far above any fixture, so the observable property is that an
    // absurd limit is accepted and answered rather than passed through to the
    // query as-is.
    const ids = await userService.getMutualUserIds(viewer, { limit: MAX_MUTUAL_IDS * 10 });

    expect([...ids].sort()).toEqual([...mutuals].sort());
    expect(ids.length).toBeLessThanOrEqual(MAX_MUTUAL_IDS);
  });

  it('treats a zero or negative limit as "use the cap"', async () => {
    const [viewer, ...mutuals] = await makeUsers(4);
    await seedGraph(viewer, mutuals);

    expect((await userService.getMutualUserIds(viewer, { limit: 0 })).sort()).toEqual(
      [...mutuals].sort()
    );
    expect((await userService.getMutualUserIds(viewer, { limit: -5 })).sort()).toEqual(
      [...mutuals].sort()
    );
  });
});

describe('degenerate viewers', () => {
  it('returns empty for an anonymous viewer', async () => {
    expect(await userService.getMutualUserIds(undefined)).toEqual([]);
    expect(await userService.getMutualUserIds('')).toEqual([]);
  });

  it('returns empty for a viewer who follows nobody', async () => {
    const [viewer, admirer] = await makeUsers(2);
    // Followed BY someone, but follows nobody — the intersection is empty.
    await getDb().insert(userFollows).values({ followerId: admirer, followedId: viewer });

    expect(await userService.getMutualUserIds(viewer)).toEqual([]);
  });

  it('returns empty for an id that names no account', async () => {
    expect(await userService.getMutualUserIds(uniqueId())).toEqual([]);
  });
});
