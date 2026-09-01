/**
 * Follow-graph ordering is a STRICT TOTAL ORDER, on every list that takes a sort.
 *
 * The suite this replaces asserted the SHAPE of the `$sort` stage —
 * "always includes a unique tiebreak, whatever the ordering" was checked by
 * inspecting the sort object's keys. That cannot distinguish a tiebreak that is
 * present from one that WORKS, and it says nothing about the pages a client
 * actually receives.
 *
 * The property at stake: `created_at` is not unique, so two follows landing in
 * the same instant tie. Under `OFFSET`/`LIMIT` an unstable sort lets a tied row
 * appear on two consecutive pages while another is skipped entirely — infinite
 * scroll corrupts with NO error and NO failing request. The only input that can
 * tell a total order from a partial one is a set whose sort keys ALL tie, which
 * is what every fixture here builds.
 *
 * `user.service.graph.pg.test.ts` walks the pages for `getUserFollowers`. This
 * suite covers the other two lists that take the same `sort` parameter —
 * `getUserFollowing` and `getUserMutuals` — because each threads it through its
 * own query and they can drift apart independently.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

const EDGE_COUNT = 9;
const PAGE_SIZE = 4;
/** One instant, to the microsecond, shared by every edge in a fixture. */
const TIED_AT = new Date('2026-03-01T12:00:00.000Z');

/**
 * Edge ids are SUPPLIED, digits-only (so JS and every Postgres collation agree)
 * and assigned OUT of insertion order. That is what makes the assertions
 * discriminating: heap order is insertion order, so a page that is merely "in
 * heap order" cannot also be in edge-id order.
 */
function edgeIdFor(prefix: string, index: number): string {
  return `${prefix}${String((index * 7) % EDGE_COUNT).padStart(4, '0')}`;
}

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `u${id}` });
  return id;
}

/** A fresh digits-only id prefix, unique across the run-wide database. */
function edgeIdPrefix(): string {
  return uniqueId().replace(/\D/g, '').padEnd(20, '0').slice(0, 20);
}

/** Counterparty ids in EDGE-ID ascending order — what `oldest` must produce. */
function byEdgeIdAscending(prefix: string, counterpartyIds: string[]): string[] {
  return counterpartyIds
    .map((id, index) => ({ id, edgeId: edgeIdFor(prefix, index) }))
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId))
    .map((entry) => entry.id);
}

/** Walk every page and return the ids in the order they were served. */
async function walkPages(
  fetchPage: (offset: number) => Promise<{ data: { id?: string }[]; total: number }>
): Promise<string[]> {
  const seen: string[] = [];
  for (let offset = 0; offset < EDGE_COUNT; offset += PAGE_SIZE) {
    const page = await fetchPage(offset);
    expect(page.total).toBe(EDGE_COUNT);
    for (const row of page.data) {
      expect(row.id).toBeDefined();
      seen.push(row.id as string);
    }
  }
  return seen;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getUserFollowing', () => {
  let viewerId: string;
  let followedIds: string[];
  let prefix: string;

  beforeAll(async () => {
    viewerId = await makeUser();
    followedIds = [];
    for (let i = 0; i < EDGE_COUNT; i += 1) {
      followedIds.push(await makeUser());
    }
    prefix = edgeIdPrefix();

    await getDb()
      .insert(userFollows)
      .values(
        followedIds.map((followedId, index) => ({
          id: edgeIdFor(prefix, index),
          followerId: viewerId,
          followedId,
          createdAt: TIED_AT,
          updatedAt: TIED_AT,
        }))
      );
  });

  it.each([['recent' as const], ['oldest' as const]])(
    'pages %s without duplicating or skipping a tied row',
    async (sort) => {
      const seen = await walkPages((offset) =>
        userService.getUserFollowing(viewerId, { limit: PAGE_SIZE, offset, sort })
      );

      expect(new Set(seen).size).toBe(EDGE_COUNT);
      expect([...seen].sort()).toEqual([...followedIds].sort());

      // The DISCRIMINATING assertion. Set equality alone is too weak: with every
      // `created_at` tied, Postgres returns a small heap in insertion order, so
      // dropping the tiebreak still yields disjoint pages and the two checks
      // above pass against the exact bug.
      const ascending = byEdgeIdAscending(prefix, followedIds);
      expect(seen).toEqual(sort === 'oldest' ? ascending : [...ascending].reverse());
    }
  );

  it('makes `oldest` the exact reverse of `recent`, mirroring BOTH keys', async () => {
    // Mirroring only the timestamp would leave the tiebreak pointing the same
    // way in both directions, so the two orders would not be reverses.
    const [recent, oldest] = await Promise.all([
      userService.getUserFollowing(viewerId, { limit: EDGE_COUNT, sort: 'recent' }),
      userService.getUserFollowing(viewerId, { limit: EDGE_COUNT, sort: 'oldest' }),
    ]);

    expect(recent.data.map((row) => row.id)).toEqual(
      oldest.data.map((row) => row.id).reverse()
    );
  });

  it('defaults to `recent` when no sort is given', async () => {
    const [defaulted, explicit] = await Promise.all([
      userService.getUserFollowing(viewerId, { limit: EDGE_COUNT }),
      userService.getUserFollowing(viewerId, { limit: EDGE_COUNT, sort: 'recent' }),
    ]);

    expect(defaulted.data.map((row) => row.id)).toEqual(explicit.data.map((row) => row.id));
  });
});

describe('getUserMutuals', () => {
  let viewerId: string;
  let targetId: string;
  let mutualIds: string[];
  let prefix: string;

  beforeAll(async () => {
    viewerId = await makeUser();
    targetId = await makeUser();
    mutualIds = [];
    for (let i = 0; i < EDGE_COUNT; i += 1) {
      mutualIds.push(await makeUser());
    }
    prefix = edgeIdPrefix();

    await getDb()
      .insert(userFollows)
      .values([
        // The viewer follows each candidate (these edges do not order the page).
        ...mutualIds.map((mutualId) => ({ followerId: viewerId, followedId: mutualId })),
        // Each candidate follows the target — THESE are the edges the page
        // orders, so they carry the supplied ids and the tied timestamp.
        ...mutualIds.map((mutualId, index) => ({
          id: edgeIdFor(prefix, index),
          followerId: mutualId,
          followedId: targetId,
          createdAt: TIED_AT,
          updatedAt: TIED_AT,
        })),
      ]);
  });

  it.each([['recent' as const], ['oldest' as const]])(
    'threads %s through to the mutuals page, tiebreak included',
    async (sort) => {
      const seen = await walkPages((offset) =>
        userService.getUserMutuals(viewerId, targetId, { limit: PAGE_SIZE, offset, sort })
      );

      expect(new Set(seen).size).toBe(EDGE_COUNT);

      const ascending = byEdgeIdAscending(prefix, mutualIds);
      expect(seen).toEqual(sort === 'oldest' ? ascending : [...ascending].reverse());
    }
  );
});
