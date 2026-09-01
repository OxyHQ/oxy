/**
 * `/users/me/app-data/...` — the per-user key/value store, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **A request can only ever reach the AUTHENTICATED account's rows.** Every
 * read, write and delete is scoped by `user_id` in the same `WHERE` as the
 * `(namespace, key)` it names. The previous suite could not have checked this:
 * it replaced the model with `jest.fn()`s and asserted the FILTER OBJECT each
 * one was called with, which is a statement about a query's shape. A shape
 * assertion stays green against a port that scopes nothing, because the shape it
 * describes no longer exists. Here two accounts each store a value under the
 * same `(namespace, key)` and the assertions are about which bytes come back.
 *
 * ## The second guarantee: `{}` is a VALUE
 *
 * Mongoose set `minimize: false` on this schema precisely so an empty object was
 * STORED rather than stripped to absent — a progress record with no entries yet
 * is not the same thing as no record. `jsonb` preserves it natively, and the
 * response contract (`{ value }`) must never collapse it to `null`. That is one
 * `??` away from breaking and nothing else would notice.
 *
 * ## What is mocked
 *
 * The auth middleware (this file is not about token parsing) and the rate
 * limiter (it is not about Redis). The quota counters, the
 * `(user_id, namespace, key)` unique constraint, the identifier CHECKs and the
 * jsonb round trip are the real database.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

/** The account each request authenticates as. Set per test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAppData } from '../../db/schema/userAppData';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import {
  APP_DATA_MAX_NAMESPACE_KEYS,
  APP_DATA_MAX_USER_KEYS,
} from '../../schemas/userData.schemas';
import userDataRouter from '../userData';

interface JsonResponse {
  status: number;
  body: {
    value?: unknown;
    entries?: Record<string, unknown>;
    message?: string;
    error?: string;
  };
}

let server: http.Server;
let OWNER = '';
let STRANGER = '';

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function request(
  method: string,
  path: string,
  payload?: unknown
): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

/** The row as STORED, read without going through the routes. */
async function storedRow(userId: string, namespace: string, key: string) {
  const [row] = await getDb()
    .select()
    .from(userAppData)
    .where(
      and(
        eq(userAppData.userId, userId),
        eq(userAppData.namespace, namespace),
        eq(userAppData.key, key)
      )
    );
  return row;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users/me/app-data', userDataRouter);
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

beforeEach(async () => {
  // Fresh accounts per case: the quota counters are per user and the unique
  // constraint is real, so a leftover row would decide the next case.
  OWNER = await insertUser();
  STRANGER = await insertUser();
  currentUserId = OWNER;
});

describe('scoping — one account can never reach another account\'s data', () => {
  beforeEach(async () => {
    // The SAME (namespace, key) for both accounts, holding different bytes.
    await getDb()
      .insert(userAppData)
      .values([
        { userId: OWNER, namespace: 'academy', key: 'progress', value: { owner: true } },
        { userId: STRANGER, namespace: 'academy', key: 'progress', value: { stranger: true } },
      ]);
  });

  it('reads only its own value', async () => {
    const mine = await request('GET', '/users/me/app-data/academy/progress');
    expect(mine).toEqual({ status: 200, body: { value: { owner: true } } });

    currentUserId = STRANGER;
    const theirs = await request('GET', '/users/me/app-data/academy/progress');
    expect(theirs).toEqual({ status: 200, body: { value: { stranger: true } } });
  });

  it('lists only its own namespace', async () => {
    const listed = await request('GET', '/users/me/app-data/academy');
    expect(listed).toEqual({ status: 200, body: { entries: { progress: { owner: true } } } });
  });

  it('writes without touching the other account\'s row', async () => {
    const written = await request('PUT', '/users/me/app-data/academy/progress', {
      value: { owner: 'updated' },
    });
    expect(written.status).toBe(200);

    expect((await storedRow(OWNER, 'academy', 'progress')).value).toEqual({ owner: 'updated' });
    expect((await storedRow(STRANGER, 'academy', 'progress')).value).toEqual({ stranger: true });
  });

  it('deletes without touching the other account\'s row', async () => {
    const deleted = await request('DELETE', '/users/me/app-data/academy/progress');
    expect(deleted.status).toBe(204);

    expect(await storedRow(OWNER, 'academy', 'progress')).toBeUndefined();
    expect((await storedRow(STRANGER, 'academy', 'progress')).value).toEqual({ stranger: true });
  });
});

describe('the stored value round trip', () => {
  it('preserves an EMPTY OBJECT rather than collapsing it to null', async () => {
    // Mongoose's `minimize: false` existed for exactly this: a record that
    // legitimately has no entries yet is not the same thing as no record.
    const written = await request('PUT', '/users/me/app-data/academy/progress', { value: {} });
    expect(written).toEqual({ status: 200, body: { value: {} } });

    expect((await storedRow(OWNER, 'academy', 'progress')).value).toEqual({});
    const read = await request('GET', '/users/me/app-data/academy/progress');
    expect(read.body.value).toEqual({});
  });

  it.each([
    ['an object', { done: [1, 2, 3], step: 'two' }],
    ['an array', [1, 'two', { three: true }]],
    ['a string', 'hello'],
    ['a number', 42],
    ['a boolean', false],
    ['null', null],
  ])('round-trips %s', async (_label, value) => {
    const written = await request('PUT', '/users/me/app-data/academy/progress', { value });
    expect(written).toEqual({ status: 200, body: { value } });

    const read = await request('GET', '/users/me/app-data/academy/progress');
    expect(read).toEqual({ status: 200, body: { value } });
  });

  it('reports a missing entry as `null` rather than 404', async () => {
    const read = await request('GET', '/users/me/app-data/academy/never_stored');
    expect(read).toEqual({ status: 200, body: { value: null } });
  });

  it('replaces the value on a second write, keeping `created_at` and moving `updated_at`', async () => {
    await request('PUT', '/users/me/app-data/academy/progress', { value: { v: 1 } });
    const first = await storedRow(OWNER, 'academy', 'progress');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await request('PUT', '/users/me/app-data/academy/progress', { value: { v: 2 } });
    const second = await storedRow(OWNER, 'academy', 'progress');

    expect(second.id).toBe(first.id);
    expect(second.value).toEqual({ v: 2 });
    // `$setOnInsert: { createdAt }` has no counterpart because `created_at` is
    // absent from the conflict arm; `updated_at` is bumped by `$onUpdate`.
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it('deletes idempotently', async () => {
    expect((await request('DELETE', '/users/me/app-data/academy/absent')).status).toBe(204);
    expect((await request('DELETE', '/users/me/app-data/academy/absent')).status).toBe(204);
  });
});

describe('quotas', () => {
  it('rejects a NEW key once the namespace quota is reached', async () => {
    await getDb()
      .insert(userAppData)
      .values(
        Array.from({ length: APP_DATA_MAX_NAMESPACE_KEYS }, (_, index) => ({
          userId: OWNER,
          namespace: 'academy',
          key: `key_${index}`,
          value: index,
        }))
      );

    const response = await request('PUT', '/users/me/app-data/academy/new_key', { value: true });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('App-data namespace key quota exceeded');
    expect(await storedRow(OWNER, 'academy', 'new_key')).toBeUndefined();
  });

  it('still allows OVERWRITING an existing key at the quota', async () => {
    // The quota bounds how many keys exist, not how often they are written —
    // the existence probe is what makes an update exempt.
    await getDb()
      .insert(userAppData)
      .values(
        Array.from({ length: APP_DATA_MAX_NAMESPACE_KEYS }, (_, index) => ({
          userId: OWNER,
          namespace: 'academy',
          key: `key_${index}`,
          value: index,
        }))
      );

    const response = await request('PUT', '/users/me/app-data/academy/key_0', { value: 'again' });

    expect(response).toEqual({ status: 200, body: { value: 'again' } });
  });

  it('counts the namespace quota per NAMESPACE, not across the account', async () => {
    await getDb()
      .insert(userAppData)
      .values(
        Array.from({ length: APP_DATA_MAX_NAMESPACE_KEYS }, (_, index) => ({
          userId: OWNER,
          namespace: 'academy',
          key: `key_${index}`,
          value: index,
        }))
      );

    const response = await request('PUT', '/users/me/app-data/other/new_key', { value: true });

    expect(response).toEqual({ status: 200, body: { value: true } });
  });

  it('counts a quota only against the requesting account', async () => {
    // A stranger filling their own namespace must not lock this account out.
    await getDb()
      .insert(userAppData)
      .values(
        Array.from({ length: APP_DATA_MAX_NAMESPACE_KEYS }, (_, index) => ({
          userId: STRANGER,
          namespace: 'academy',
          key: `key_${index}`,
          value: index,
        }))
      );

    const response = await request('PUT', '/users/me/app-data/academy/mine', { value: 1 });

    expect(response).toEqual({ status: 200, body: { value: 1 } });
  });

  it('keeps the per-user quota above the per-namespace one', () => {
    // The order the handler checks them in is only meaningful while this holds.
    expect(APP_DATA_MAX_USER_KEYS).toBeGreaterThan(APP_DATA_MAX_NAMESPACE_KEYS);
  });
});

describe('listing a namespace', () => {
  it('returns a key → value map', async () => {
    await getDb()
      .insert(userAppData)
      .values([
        { userId: OWNER, namespace: 'academy', key: 'alpha', value: 1 },
        { userId: OWNER, namespace: 'academy', key: 'beta', value: { deep: true } },
        { userId: OWNER, namespace: 'other', key: 'gamma', value: 'elsewhere' },
      ]);

    const response = await request('GET', '/users/me/app-data/academy');

    expect(response).toEqual({
      status: 200,
      body: { entries: { alpha: 1, beta: { deep: true } } },
    });
  });

  it('refuses to materialize a namespace over the list quota', async () => {
    await getDb()
      .insert(userAppData)
      .values(
        Array.from({ length: APP_DATA_MAX_NAMESPACE_KEYS + 1 }, (_, index) => ({
          userId: OWNER,
          namespace: 'academy',
          key: `key_${index}`,
          value: index,
        }))
      );

    const response = await request('GET', '/users/me/app-data/academy');

    expect(response.status).toBe(413);
    expect(response.body.message).toBe(
      'App-data namespace exceeds the maximum list response size'
    );
  });

  it('answers an empty namespace with an empty map', async () => {
    const response = await request('GET', '/users/me/app-data/academy');
    expect(response).toEqual({ status: 200, body: { entries: {} } });
  });
});

describe('identifier handling', () => {
  it.each([
    ['a namespace with a dot', '/users/me/app-data/academy.v2/progress'],
    ['an over-long key', `/users/me/app-data/academy/${'k'.repeat(65)}`],
  ])('rejects %s with 400 before reaching the database', async (_label, path) => {
    const response = await request('PUT', path, { value: 1 });
    expect(response.status).toBe(400);
  });

  it('lower-cases an identifier before it reaches the CHECK constraint', async () => {
    // `identifierSchema` NORMALIZES (`.trim().toLowerCase()`) rather than
    // rejecting, and `user_app_data_namespace_check` uses Postgres's
    // case-SENSITIVE `~`. The normalized value therefore has to be what the
    // handler actually writes — if `validate` stopped writing the parsed params
    // back, this insert would fail the constraint rather than store an
    // uppercase namespace.
    const response = await request('PUT', '/users/me/app-data/Academy/Progress', { value: 1 });

    expect(response).toEqual({ status: 200, body: { value: 1 } });
    expect((await storedRow(OWNER, 'academy', 'progress')).value).toBe(1);
  });
});
