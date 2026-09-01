/**
 * `GET /reputation/leaderboard` wire shape, against a REAL Postgres.
 *
 * The leaderboard used to hand `sendPaginated` the raw aggregate projection, so
 * each row's `user` carried Mongo's `_id` and the user's RAW stored name
 * subdocument. The SDK type promised `user.id` and the canonical composed
 * `name`, which meant `entry.user.id` was `undefined` for every row — the
 * `@oxyhq/services` leaderboard screen's `keyExtractor` silently fell through to
 * its index fallback, and `name.displayName` did not mean what it means on every
 * other user DTO.
 *
 * The row now goes through `serializeLeaderboardEntry`, annotated against
 * `ReputationLeaderboardEntry` from `@oxyhq/contracts`. These tests lock what a
 * consumer actually receives, over real `reputation_balances` rows joined to
 * real `users` rows — the previous version fed a mocked service a hand-built
 * projection, so it could not have noticed the join changing shape.
 *
 * ## Isolation
 *
 * The leaderboard is global by construction, and jest runs suites in parallel
 * against ONE throwaway database, so no suite can own a position on it. Rows are
 * therefore located by user id rather than by position — including in the one
 * case that is ABOUT position, which locates its own rows first and then asserts
 * their ORDER and their rank numbering RELATIVE to where they landed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { reputationLeaderboardEntrySchema, safeParseContract } from '@oxyhq/contracts';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import reputationRouter from '../reputation.routes';

interface LeaderboardRow {
  user: {
    id?: string;
    _id?: string;
    username: string;
    name: Record<string, unknown>;
    avatar?: string;
    publicKey?: string;
  };
  total: number;
  trustTier: string;
  rank: number;
}

/**
 * A band of totals no other suite sharing this database writes into, so this
 * file's rows are contiguous on the board and land within the first page.
 *
 * It is deliberately NOT a claim to the TOP of the board — that belongs to
 * `services/__tests__/reputation.leaderboard.test.ts`, whose fixtures sit in the
 * 900-million range. See the ordering case below for what that cost.
 */
const TOP_TOTAL = 9_000_003;

let server: http.Server;

function leaderboard(
  query = '',
): Promise<{ status: number; body: { data?: LeaderboardRow[]; pagination?: { total: number } } }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/reputation/leaderboard${query}`,
        headers: { connection: 'close' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function balance(
  userId: string,
  total: number,
  trustTier: (typeof reputationBalances.$inferInsert)['trustTier'] = 'trusted',
): Promise<void> {
  await getDb().insert(reputationBalances).values({ userId, total, positive: total, trustTier });
}

function rowFor(
  res: { body: { data?: LeaderboardRow[] } },
  userId: string,
): LeaderboardRow | undefined {
  return res.body.data?.find((row) => row.user.id === userId);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/reputation', reputationRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

describe('GET /reputation/leaderboard — user identity', () => {
  it('emits the user id as `id`, never a raw `_id`', async () => {
    const username = `board${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const userId = await account({ username, nameFirst: 'Nate', nameLast: 'Isern' });
    await balance(userId, TOP_TOTAL - 100);

    const res = await leaderboard('?limit=50');

    expect(res.status).toBe(200);
    const row = rowFor(res, userId);
    expect(row).toBeDefined();
    expect(row?.user.id).toBe(userId);
    expect(row?.user).not.toHaveProperty('_id');
  });

  it('composes `name.displayName` the same way every other user DTO does', async () => {
    const username = `board${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const userId = await account({ username, nameFirst: 'Nate', nameLast: 'Isern' });
    await balance(userId, TOP_TOTAL - 101);

    const res = await leaderboard('?limit=50');

    expect(rowFor(res, userId)?.user.name).toEqual({
      displayName: 'Nate Isern',
      first: 'Nate',
      last: 'Isern',
      full: 'Nate Isern',
    });
  });

  it('omits `displayName` for an account with no human name', async () => {
    // `composeDisplayName` never synthesizes a name from the username, so the
    // consumer falls back to the handle. Locked here so a future "helpful"
    // fallback cannot creep back in.
    const username = `board${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const userId = await account({ username });
    await balance(userId, TOP_TOTAL - 102);

    const res = await leaderboard('?limit=50');

    const row = rowFor(res, userId);
    expect(row?.user.name).not.toHaveProperty('displayName');
    expect(row?.user.username).toBe(username);
  });
});

describe('GET /reputation/leaderboard — projection', () => {
  it('publishes only the narrow public projection, and the rank', async () => {
    const username = `board${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const publicKey = `04${randomUUID().replace(/-/g, '')}`;
    const userId = await account({
      username,
      publicKey,
      avatar: 'file_board',
      email: `${username}@oxy.so`,
      phone: '+34600999888',
      refreshToken: `rt_secret_${username}`,
      bio: 'a bio',
      description: 'a description',
    });
    await balance(userId, TOP_TOTAL - 103, 'high_trust');

    const res = await leaderboard('?limit=50');

    const row = rowFor(res, userId);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual(['rank', 'total', 'trustTier', 'user']);
    expect(Object.keys(row?.user ?? {}).sort()).toEqual([
      'avatar',
      'id',
      'name',
      'publicKey',
      'username',
    ]);
    expect(row?.total).toBe(TOP_TOTAL - 103);
    expect(row?.trustTier).toBe('high_trust');
    expect(safeParseContract(reputationLeaderboardEntrySchema, row)).not.toBeNull();
  });

  it('never emits the private user columns the join could have carried', async () => {
    const username = `board${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const userId = await account({
      username,
      email: `${username}@oxy.so`,
      phone: '+34600777666',
      refreshToken: `rt_secret_${username}`,
    });
    await balance(userId, TOP_TOTAL - 104);

    const res = await leaderboard('?limit=50');

    const row = rowFor(res, userId);
    expect(row?.user).not.toHaveProperty('email');
    expect(row?.user).not.toHaveProperty('phone');
    expect(row?.user).not.toHaveProperty('refreshToken');
  });
});

describe('GET /reputation/leaderboard — ordering and eligibility', () => {
  it('ranks by total descending, numbering from the page offset', async () => {
    // Three CONSECUTIVE totals no other suite writes between, so these rows are
    // adjacent on the board wherever the board happens to start them.
    //
    // This case is the one thing in the file that is about POSITION, and it used
    // to claim absolute positions 1-2-3 ("the three highest totals in the
    // database"). That claim was not this suite's to make:
    // `services/__tests__/reputation.leaderboard.test.ts` seeds its own fixtures
    // in the 900-million range and asserts IT owns the head of the board, so
    // whenever jest scheduled the two suites concurrently against the shared
    // database this one failed — a latent order dependence that surfaced only as
    // a scheduling accident. Raising this file's band instead would just move
    // the failure to that file: both cannot be rank 1.
    //
    // Every property the case was written for survives, because none of them was
    // ever about being FIRST: descending order among the three, `rank` numbering
    // from the page offset, and `rank` continuing across a page boundary rather
    // than restarting. They are asserted relative to where the rows actually
    // land, which no concurrent writer can move.
    const first = await account({ username: `first${randomUUID().replace(/-/g, '').slice(0, 10)}` });
    const second = await account({ username: `second${randomUUID().replace(/-/g, '').slice(0, 10)}` });
    const third = await account({ username: `third${randomUUID().replace(/-/g, '').slice(0, 10)}` });
    await balance(first, TOP_TOTAL);
    await balance(second, TOP_TOTAL - 1);
    await balance(third, TOP_TOTAL - 2);

    // 100 is `MAX_LEADERBOARD_LIMIT`; only the other leaderboard suite's dozen
    // or so 900-million fixtures can outrank `TOP_TOTAL`, so the page contains
    // these rows with room to spare.
    const page = await leaderboard('?limit=100&offset=0');
    const rows = page.body.data ?? [];
    const start = rows.findIndex((row) => row.user.id === first);
    // Fail naming the cause rather than as a confusing `undefined` comparison.
    expect(start).toBeGreaterThanOrEqual(0);

    expect(rows.slice(start, start + 3).map((row) => row.user.id)).toEqual([first, second, third]);
    expect(rows.slice(start, start + 3).map((row) => row.rank)).toEqual([
      start + 1,
      start + 2,
      start + 3,
    ]);

    // Rank continues across the page boundary rather than restarting at 1.
    const nextPage = await leaderboard(`?limit=3&offset=${start + 3}`);
    expect(nextPage.body.data?.[0]?.rank).toBe(start + 4);
  });

  it('excludes archived accounts and restricted tiers from the public board', async () => {
    const visible = await account({ username: `vis${randomUUID().replace(/-/g, '').slice(0, 12)}` });
    const archived = await account({
      username: `arc${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      accountStatus: 'archived',
    });
    const restricted = await account({
      username: `res${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      reputationTier: 'restricted',
    });
    await balance(visible, TOP_TOTAL - 200);
    await balance(archived, TOP_TOTAL - 201);
    await balance(restricted, TOP_TOTAL - 202, 'restricted');

    const res = await leaderboard('?limit=50');

    const returned = (res.body.data ?? []).map((row) => row.user.id);
    expect(returned).toContain(visible);
    expect(returned).not.toContain(archived);
    expect(returned).not.toContain(restricted);
  });
});
