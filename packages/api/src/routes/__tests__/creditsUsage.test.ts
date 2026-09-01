/**
 * Credit balance + usage history — against a REAL Postgres, through the REAL routes.
 *
 * The usage endpoint was a Mongo aggregation pipeline: a `$match` on a time
 * window, a `$group` on `$dateToString` of the event timestamp, and a `$cond`
 * that billed recorded credits when present and otherwise one credit per started
 * 1000 tokens with a floor of 1. Rewriting that as SQL is the kind of change
 * where a plausible-looking translation returns plausible-looking numbers, so
 * each clause is pinned separately here.
 *
 * The grouping is checked in UTC on purpose. A bare `date_trunc('day', …)` on a
 * `timestamptz` truncates in the SESSION's `TimeZone`, which would silently move
 * events between days depending on server configuration, while the gap-fill keys
 * on `toISOString()` — always UTC. That mismatch would show up as zeros in the
 * response and full rows in the database.
 *
 * ## The reported window ends BEFORE today — carried across deliberately
 *
 * The gap-fill emits `days` keys starting at `since`, which is local midnight
 * `days` ago, so the last key is `since + (days - 1)` — YESTERDAY at best, and a
 * day earlier still wherever the local midnight falls on the previous UTC date.
 * The aggregation matches `>= since` and therefore DOES count today's events;
 * they simply have no slot in the response and are dropped.
 *
 * That is a pre-existing display bug, and this port keeps it byte-for-byte: the
 * wire format is the contract, and every ecosystem app consumes this response
 * without being rebuilt. `pins the reported window` below fixes the behaviour in
 * place so a future fix has to be a deliberate one.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/** The account each request authenticates as. Set per test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: { toString: () => currentUserId } };
    next();
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { apiKeyUsageEvents } from '../../db/schema/apiKeyUsageEvents';
import { users } from '../../db/schema/users';
import creditsRoutes from '../credits';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function account(): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return user.id;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(express.json());
  app.use('/credits', creditsRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** One served request, billed either in credits or in tokens. */
async function recordUsage(
  userId: string,
  at: Date,
  billed: { creditsUsed?: number; tokensUsed?: number },
): Promise<void> {
  await getDb().insert(apiKeyUsageEvents).values({
    userId,
    endpoint: '/v1/test',
    method: 'GET',
    statusCode: 200,
    creditsUsed: billed.creditsUsed ?? 0,
    tokensUsed: billed.tokensUsed ?? 0,
    createdAt: at,
  });
}

/** The `used` figure the response reports for a given UTC day. */
function usedOn(body: unknown, date: string): number | undefined {
  const rows = body as { date: string; used: number }[];
  return rows.find((row) => row.date === date)?.used;
}

/**
 * A UTC instant `daysAgo` days back. Four and five days back sit inside the
 * reported window for every plausible server time zone — see the header for why
 * "today" does not.
 */
function daysAgo(days: number, utcHour = 12, utcMinute = 0): Date {
  const at = new Date(Date.now() - days * DAY_MS);
  at.setUTCHours(utcHour, utcMinute, 0, 0);
  return at;
}

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

describe('GET /credits', () => {
  it('creates the credit row on first touch and reports the schema defaults', async () => {
    currentUserId = await account();

    const { status, body } = await get('/credits/');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      credits: 1000,
      freeCredits: 1000,
      paidCredits: 0,
      dailyRefresh: 300,
    });
  });

  it('is idempotent — a second call does not mint a second balance', async () => {
    currentUserId = await account();

    await get('/credits/');
    const { body } = await get('/credits/');

    expect(body).toMatchObject({ credits: 1000, freeCredits: 1000 });
  });
});

describe('GET /credits/usage', () => {
  it('bills the recorded credits when there are any', async () => {
    currentUserId = await account();
    const at = daysAgo(4);
    await recordUsage(currentUserId, at, { creditsUsed: 4 });
    await recordUsage(currentUserId, at, { creditsUsed: 6 });

    const { body } = await get('/credits/usage?period=7d');

    expect(usedOn(body, dayKey(at))).toBe(10);
  });

  it('falls back to one credit per started 1000 tokens, with a floor of 1', async () => {
    currentUserId = await account();
    const at = daysAgo(4);
    // 1 token rounds UP to 1 credit (the floor), 1001 tokens to 2.
    await recordUsage(currentUserId, at, { tokensUsed: 1 });
    await recordUsage(currentUserId, at, { tokensUsed: 1001 });

    const { body } = await get('/credits/usage?period=7d');

    expect(usedOn(body, dayKey(at))).toBe(3);
  });

  it('prefers recorded credits over the token fallback on the same row', async () => {
    currentUserId = await account();
    const at = daysAgo(4);
    // Both columns populated: the `$cond` billed credits and IGNORED the tokens.
    await recordUsage(currentUserId, at, { creditsUsed: 2, tokensUsed: 50_000 });

    const { body } = await get('/credits/usage?period=7d');

    expect(usedOn(body, dayKey(at))).toBe(2);
  });

  it('excludes rows that billed neither credits nor tokens', async () => {
    currentUserId = await account();
    const at = daysAgo(4);
    await recordUsage(currentUserId, at, {});

    const { body } = await get('/credits/usage?period=7d');

    expect(usedOn(body, dayKey(at))).toBe(0);
  });

  it('groups by UTC day, not by the session time zone', async () => {
    currentUserId = await account();
    // 23:30 UTC and 00:30 UTC the next morning are one hour apart and belong to
    // DIFFERENT days. Under a non-UTC session zone they would collapse into one.
    const late = daysAgo(5, 23, 30);
    const early = daysAgo(4, 0, 30);

    await recordUsage(currentUserId, late, { creditsUsed: 7 });
    await recordUsage(currentUserId, early, { creditsUsed: 9 });

    const { body } = await get('/credits/usage?period=7d');

    expect(dayKey(late)).not.toBe(dayKey(early));
    expect(usedOn(body, dayKey(late))).toBe(7);
    expect(usedOn(body, dayKey(early))).toBe(9);
  });

  it('pins the reported window: it starts at local midnight `days` ago and ENDS BEFORE TODAY', async () => {
    currentUserId = await account();

    const { body } = await get('/credits/usage?period=7d');
    const rows = body as { date: string; used: number }[];

    // Recomputed exactly as the route does, so this asserts the CONTRACT rather
    // than restating the implementation's arithmetic in different words.
    const since = new Date();
    since.setDate(since.getDate() - 7);
    since.setHours(0, 0, 0, 0);
    const expected = Array.from({ length: 7 }, (_unused, i) => {
      const day = new Date(since);
      day.setDate(day.getDate() + i);
      return day.toISOString().slice(0, 10);
    });

    expect(rows.map((row) => row.date)).toEqual(expected);
    // The consequence, stated outright: today never appears, so today's usage is
    // counted by the aggregation and then dropped on the floor. Pre-existing, and
    // preserved on purpose — fixing it is a wire change and needs its own decision.
    expect(rows.map((row) => row.date)).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it('fills days with no usage with zero and returns the whole window', async () => {
    currentUserId = await account();

    const seven = await get('/credits/usage?period=7d');
    expect(seven.body).toHaveLength(7);
    expect((seven.body as { used: number }[]).every((row) => row.used === 0)).toBe(true);

    const thirty = await get('/credits/usage?period=30d');
    expect(thirty.body).toHaveLength(30);
  });

  it('does not count another account\'s usage', async () => {
    const otherUserId = await account();
    const at = daysAgo(4);
    await recordUsage(otherUserId, at, { creditsUsed: 500 });

    currentUserId = await account();
    const { body } = await get('/credits/usage?period=7d');

    expect(usedOn(body, dayKey(at))).toBe(0);
  });
});
