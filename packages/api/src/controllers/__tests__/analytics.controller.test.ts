/**
 * The premium analytics surface, against a REAL Postgres.
 *
 * ## The two guarantees this file exists for
 *
 * **1. Every aggregate is attributed to the AUTHENTICATED account.** Each
 * handler takes a `userID` from the query string or the body and must ignore it
 * — the previous suite pinned that, and it stays pinned here, but over rows that
 * really exist rather than over the arguments a mock was called with. That
 * distinction matters: the old assertions were of the form "`Analytics.find` was
 * called with `{ userID: <me> }`", which is a statement about a query SHAPE. A
 * shape assertion survives a port that reads the wrong rows, returns the wrong
 * numbers, or writes nothing at all.
 *
 * **2. A DOT PATH MUST NOT REACH DRIZZLE.** `updateAnalytics` accepts Mongo dot
 * paths on the wire (`stats.engagement.likes`) and the storage is now FLAT
 * COLUMNS. Drizzle keys `values()` / `set()` by column PROPERTY and silently
 * ignores a key naming no column, so passing the wire key straight through
 * writes NOTHING and throws NOTHING — an increment endpoint that returns
 * `200 {"message":"Analytics updated successfully"}` while storing zero. Every
 * increment case below reads the stored row back.
 *
 * ## What is NOT mocked
 *
 * Nothing except the logger. The rows, the `(user_id, period, date)` unique
 * constraint, the `user_follows` foreign keys and the check constraints are the
 * real database.
 *
 * ## The wire format, which is a Mongoose document shape
 *
 * `timeSeriesData` used to be serialized `Analytics` documents, so the response
 * still carries `_id`, the capital-D `userID`, and the NESTED `stats` tree even
 * though the table spells them `id`, `user_id` and one flat column per counter.
 * `__v` deliberately does not travel — it is a driver artifact the migration
 * contract forbids and no reader ever consumed it.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import type { Response } from 'express';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAnalytics } from '../../db/schema/userAnalytics';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import type { AuthRequest } from '../../middleware/auth';
import {
  getAnalytics,
  getContentViewers,
  getFollowerDetails,
  updateAnalytics,
} from '../analytics.controller';

const DAY_MS = 24 * 60 * 60 * 1000;

let USER_ID = '';
let OTHER_USER_ID = '';

/** What a handler passed to `res.json`, plus the status it set. */
interface Captured {
  status: number;
  body: unknown;
}

function capture(): { res: Response; taken: Captured } {
  const taken: Captured = { status: 200, body: undefined };
  const res = {
    status: (code: number) => {
      taken.status = code;
      return res;
    },
    json: (payload: unknown) => {
      taken.body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, taken };
}

/**
 * A request authenticated as `USER_ID` that ALSO carries a different account id
 * in both the query string and the body — the attacker-supplied value every
 * handler must ignore.
 */
function makeRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    user: { _id: USER_ID } as AuthRequest['user'],
    query: { userID: OTHER_USER_ID, period: 'weekly' },
    body: {
      userID: OTHER_USER_ID,
      type: 'profileViews',
      data: { 'stats.reach.impressions': 4 },
    },
    ...overrides,
  } as AuthRequest;
}

async function insertUser(createdAt?: Date): Promise<string> {
  const values = createdAt
    ? { color: 'teal', createdAt, updatedAt: createdAt }
    : { color: 'teal' };
  const [row] = await getDb().insert(users).values(values).returning({ id: users.id });
  return row.id;
}

/** Every stored aggregate for one account, oldest first. */
async function storedRows(userId: string) {
  return getDb()
    .select()
    .from(userAnalytics)
    .where(eq(userAnalytics.userId, userId))
    .orderBy(userAnalytics.date);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Fresh accounts per case: `(user_id, period, date)` is a real unique
  // constraint here, and the follow graph is scoped by foreign key.
  USER_ID = await insertUser();
  OTHER_USER_ID = await insertUser();
});

describe('getAnalytics', () => {
  it('rebuilds the nested `stats` tree and the Mongo field spellings', async () => {
    const date = new Date(Date.now() - DAY_MS);
    await getDb().insert(userAnalytics).values({
      userId: USER_ID,
      period: 'weekly',
      date,
      postViews: 11,
      profileViews: 12,
      engagementLikes: 1,
      engagementReplies: 2,
      engagementReposts: 3,
      engagementQuotes: 4,
      engagementBookmarks: 5,
      reachImpressions: 6,
      reachUniqueViewers: 7,
      demographicsCountries: { ES: 3 },
      demographicsLanguages: { es: 3 },
      peakActivityHour: 9,
      peakActivityCount: 21,
    });

    const { res, taken } = capture();
    await getAnalytics(makeRequest(), res);

    const body = taken.body as { timeSeriesData: Record<string, unknown>[] };
    expect(body.timeSeriesData).toHaveLength(1);
    const row = body.timeSeriesData[0];

    // `userID`, not `userId`: the column rename is storage-only.
    expect(row.userID).toBe(USER_ID);
    expect(typeof row._id).toBe('string');
    expect(row.period).toBe('weekly');
    expect(row.date).toEqual(date);
    // `__v` was a driver artifact; it must not reappear.
    expect(row).not.toHaveProperty('__v');
    expect(row.stats).toEqual({
      postViews: 11,
      profileViews: 12,
      engagement: { likes: 1, replies: 2, reposts: 3, quotes: 4, bookmarks: 5 },
      reach: { impressions: 6, uniqueViewers: 7 },
      demographics: { countries: { ES: 3 }, languages: { es: 3 } },
      peakActivity: { hour: 9, count: 21 },
    });
  });

  it('reads only the AUTHENTICATED account, ignoring the query `userID`', async () => {
    // The attacker-supplied id owns a row inside the same window; if the handler
    // read it, the counter below would be 99.
    const date = new Date(Date.now() - DAY_MS);
    await getDb()
      .insert(userAnalytics)
      .values([
        { userId: USER_ID, period: 'weekly', date, postViews: 1 },
        { userId: OTHER_USER_ID, period: 'weekly', date, postViews: 99 },
      ]);

    const { res, taken } = capture();
    await getAnalytics(makeRequest(), res);

    const body = taken.body as { timeSeriesData: { userID: string; stats: { postViews: number } }[] };
    expect(body.timeSeriesData).toHaveLength(1);
    expect(body.timeSeriesData[0].userID).toBe(USER_ID);
    expect(body.timeSeriesData[0].stats.postViews).toBe(1);
  });

  it('filters to the requested period and window, ordered by date', async () => {
    const inside = new Date(Date.now() - DAY_MS);
    const older = new Date(Date.now() - 2 * DAY_MS);
    const outside = new Date(Date.now() - 30 * DAY_MS);
    await getDb()
      .insert(userAnalytics)
      .values([
        { userId: USER_ID, period: 'weekly', date: inside },
        { userId: USER_ID, period: 'weekly', date: older },
        { userId: USER_ID, period: 'weekly', date: outside },
        { userId: USER_ID, period: 'daily', date: inside },
      ]);

    const { res, taken } = capture();
    await getAnalytics(makeRequest(), res);

    const body = taken.body as { timeSeriesData: { date: Date; period: string }[] };
    expect(body.timeSeriesData.map((row) => row.date)).toEqual([older, inside]);
    expect(body.timeSeriesData.every((row) => row.period === 'weekly')).toBe(true);
  });

  it('answers an unknown period with an empty series rather than an error', async () => {
    // Mongo matched nothing for a `period` outside the enum; the port
    // short-circuits to the same empty result instead of reaching the query.
    const { res, taken } = capture();
    await getAnalytics(makeRequest({ query: { period: 'fortnightly' } }), res);

    expect(taken.status).toBe(200);
    expect((taken.body as { timeSeriesData: unknown[] }).timeSeriesData).toEqual([]);
  });

  it('reports growth as a MEASUREMENT over the follow graph', async () => {
    // `users._count` is deleted — a cached counter existed only because Mongo
    // cannot JOIN. These two numbers cannot disagree with the edges any more.
    const followerA = await insertUser();
    const followerB = await insertUser();
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: followerA, followedId: USER_ID },
        { followerId: followerB, followedId: USER_ID },
        { followerId: USER_ID, followedId: OTHER_USER_ID },
      ]);

    const { res, taken } = capture();
    await getAnalytics(makeRequest(), res);

    expect((taken.body as { growth: unknown }).growth).toEqual({ followers: 2, following: 1 });
  });

  it('emits growth counts as JSON numbers, not bigint strings', async () => {
    const follower = await insertUser();
    await getDb().insert(userFollows).values({ followerId: follower, followedId: USER_ID });

    const { res, taken } = capture();
    await getAnalytics(makeRequest(), res);

    const growth = (taken.body as { growth: Record<string, unknown> }).growth;
    expect(typeof growth.followers).toBe('number');
    expect(typeof growth.following).toBe('number');
  });

  it('returns an empty growth object for an account that does not exist', async () => {
    // `User.findById` found nothing and `userStats?._count || {}` produced `{}`.
    const { res, taken } = capture();
    await getAnalytics(makeRequest({ user: { _id: randomUUID() } as AuthRequest['user'] }), res);

    expect(taken.body).toEqual({ timeSeriesData: [], growth: {} });
  });

  it('rejects the request without an authenticated account', async () => {
    const { res, taken } = capture();
    await getAnalytics(makeRequest({ user: undefined }), res);

    expect(taken.status).toBe(401);
    expect(taken.body).toEqual({ message: 'Authentication required' });
  });
});

describe('updateAnalytics', () => {
  it('STORES the increment for every period — the dot paths reach real columns', async () => {
    // The failure this guards is silent by construction: drizzle drops a key
    // that names no column, so `stats.reach.impressions` would leave the row at
    // its default and the endpoint would still answer 200.
    const { res, taken } = capture();
    await updateAnalytics(makeRequest(), res);

    expect(taken.status).toBe(200);
    expect(taken.body).toEqual({ message: 'Analytics updated successfully' });

    const rows = await storedRows(USER_ID);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.period).sort()).toEqual([
      'daily',
      'monthly',
      'weekly',
      'yearly',
    ]);
    for (const row of rows) {
      expect(row.profileViews).toBe(1);
      expect(row.reachImpressions).toBe(4);
      // Untouched counters keep their defaults rather than being overwritten.
      expect(row.postViews).toBe(0);
      expect(row.engagementLikes).toBe(0);
    }
  });

  it('writes to the AUTHENTICATED account, ignoring the body `userID`', async () => {
    const { res } = capture();
    await updateAnalytics(makeRequest(), res);

    expect(await storedRows(USER_ID)).toHaveLength(4);
    expect(await storedRows(OTHER_USER_ID)).toHaveLength(0);
  });

  it('translates every accepted dot path to its own column', async () => {
    const { res } = capture();
    await updateAnalytics(
      makeRequest({
        body: {
          type: 'postViews',
          data: {
            'stats.engagement.likes': 1,
            'stats.engagement.replies': 2,
            'stats.engagement.reposts': 3,
            'stats.engagement.quotes': 4,
            'stats.engagement.bookmarks': 5,
            'stats.reach.impressions': 6,
            'stats.reach.uniqueViewers': 7,
          },
        },
      }),
      res
    );

    const [row] = await storedRows(USER_ID);
    expect(row.postViews).toBe(1);
    expect(row.engagementLikes).toBe(1);
    expect(row.engagementReplies).toBe(2);
    expect(row.engagementReposts).toBe(3);
    expect(row.engagementQuotes).toBe(4);
    expect(row.engagementBookmarks).toBe(5);
    expect(row.reachImpressions).toBe(6);
    expect(row.reachUniqueViewers).toBe(7);
  });

  it('ADDS to an existing aggregate rather than replacing it', async () => {
    // The conflict arm of the upsert, which is the port of `$inc`. Forced by
    // pinning the row's `date` — the handler uses the current instant, so in
    // practice each call inserts.
    const date = new Date();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(date);
    try {
      const first = capture();
      await updateAnalytics(makeRequest(), first.res);
      const second = capture();
      await updateAnalytics(makeRequest(), second.res);
    } finally {
      jest.useRealTimers();
    }

    const rows = await storedRows(USER_ID);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.profileViews).toBe(2);
      expect(row.reachImpressions).toBe(8);
    }
  });

  it('ignores a data key outside the whitelist', async () => {
    const { res } = capture();
    await updateAnalytics(
      makeRequest({
        body: { type: 'postViews', data: { 'stats.engagement.likes': 2, peakActivityHour: 5 } },
      }),
      res
    );

    const [row] = await storedRows(USER_ID);
    expect(row.engagementLikes).toBe(2);
    // A column named directly rather than through the whitelist must not be
    // reachable — the map is an authorization boundary, not just a translation.
    expect(row.peakActivityHour).toBe(0);
  });

  it('rejects an unknown analytics type without writing anything', async () => {
    const { res, taken } = capture();
    await updateAnalytics(makeRequest({ body: { type: 'somethingElse' } }), res);

    expect(taken.status).toBe(400);
    expect(taken.body).toEqual({ message: 'Invalid analytics type' });
    expect(await storedRows(USER_ID)).toHaveLength(0);
  });

  it('rejects the request without an authenticated account', async () => {
    const { res, taken } = capture();
    await updateAnalytics(makeRequest({ user: undefined }), res);

    expect(taken.status).toBe(401);
  });
});

describe('getContentViewers', () => {
  it('answers an empty list — the field it aggregated has never existed', async () => {
    // `$match: { "stats.viewers": { $exists: true } }` selected zero documents on
    // every call this endpoint ever served: `stats.viewers` is not in the
    // Mongoose schema and strict mode drops an out-of-schema update path, so no
    // writer could create one. `user_analytics` has no viewers column for the
    // same reason — there is no data to port, and `200 []` IS the contract.
    await getDb().insert(userAnalytics).values({
      userId: USER_ID,
      period: 'weekly',
      date: new Date(),
      profileViews: 5,
    });

    const { res, taken } = capture();
    getContentViewers(makeRequest(), res);

    expect(taken.status).toBe(200);
    expect(taken.body).toEqual([]);
  });

  it('rejects the request without an authenticated account', () => {
    const { res, taken } = capture();
    getContentViewers(makeRequest({ user: undefined }), res);

    expect(taken.status).toBe(401);
  });
});

describe('getFollowerDetails', () => {
  it('counts real follow edges and windows them by follower account age', async () => {
    // The two windowed figures keep the aggregation's original — and genuinely
    // odd — meaning: they count followers whose ACCOUNT was created or last
    // updated inside the window, not edges formed inside it.
    const recent = await insertUser();
    const old = await insertUser(new Date(Date.now() - 400 * DAY_MS));
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: recent, followedId: USER_ID },
        { followerId: old, followedId: USER_ID },
      ]);

    const { res, taken } = capture();
    await getFollowerDetails(makeRequest(), res);

    expect(taken.body).toEqual({
      _id: USER_ID,
      totalFollowers: 2,
      newFollowers: 1,
      activeFollowers: 1,
    });
  });

  it('emits every figure as a JSON number', async () => {
    const follower = await insertUser();
    await getDb().insert(userFollows).values({ followerId: follower, followedId: USER_ID });

    const { res, taken } = capture();
    await getFollowerDetails(makeRequest(), res);

    const body = taken.body as Record<string, unknown>;
    for (const field of ['totalFollowers', 'newFollowers', 'activeFollowers']) {
      expect(typeof body[field]).toBe('number');
    }
  });

  it('counts only edges pointing AT the authenticated account', async () => {
    // Direction matters: `follower_id` and `followed_id` are both `text`
    // columns on the same table, so reversing them is a one-word mistake that
    // returns a plausible number.
    const follower = await insertUser();
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: follower, followedId: USER_ID },
        { followerId: USER_ID, followedId: OTHER_USER_ID },
        { followerId: follower, followedId: OTHER_USER_ID },
      ]);

    const { res, taken } = capture();
    await getFollowerDetails(makeRequest(), res);

    expect((taken.body as { totalFollowers: number }).totalFollowers).toBe(1);
  });

  it('returns the zeroed shape — with NO `_id` — for an account that does not exist', async () => {
    // `$match: { _id: <missing> }` produced no stage output, so the controller
    // fell through to its literal, which never carried an `_id`. Both shapes are
    // part of the contract.
    const { res, taken } = capture();
    await getFollowerDetails(
      makeRequest({ user: { _id: randomUUID() } as AuthRequest['user'] }),
      res
    );

    expect(taken.body).toEqual({ totalFollowers: 0, newFollowers: 0, activeFollowers: 0 });
    expect(taken.body).not.toHaveProperty('_id');
  });

  it('rejects the request without an authenticated account', async () => {
    const { res, taken } = capture();
    await getFollowerDetails(makeRequest({ user: undefined }), res);

    expect(taken.status).toBe(401);
  });
});

describe('the analytics rows are really stored, not mocked', () => {
  it('reads back through a second, independent query', async () => {
    // A vacuity floor for the whole file: every assertion above is about rows in
    // a real database, so at least one of them must be locatable without going
    // through the controller.
    const { res } = capture();
    await updateAnalytics(makeRequest(), res);

    const rows = await getDb()
      .select()
      .from(userAnalytics)
      .where(and(eq(userAnalytics.userId, USER_ID), eq(userAnalytics.period, 'daily')));
    expect(rows).toHaveLength(1);
    expect(rows[0].reachImpressions).toBe(4);
  });
});
