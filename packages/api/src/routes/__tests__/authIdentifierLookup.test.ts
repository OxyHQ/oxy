/**
 * The four enumeration-sensitive identifier lookups on `/auth`, against a REAL
 * Postgres: `check-username`, `check-email`, `check-publickey` and `lookup`.
 *
 * These had NO suite before the Postgres port, and they are exactly where the
 * port CHANGES observable behaviour, so they get one now. `users` is unique on
 * `lower(btrim(username))`, `lower(btrim(email))` and `lower(btrim(public_key))`
 * — three expression indexes — and every lookup here must apply the same
 * expression on both sides. A plain `username = $1` is correct-looking,
 * case-SENSITIVE, and would not use the index.
 *
 * Behaviour difference this pins, deliberately: `check-username` and
 * `check-publickey` are now case-INSENSITIVE. Mongo indexed `username`
 * case-sensitively (so `Nate` and `nate` could coexist) while every lookup ran an
 * anchored `/i` regex; the expression index resolves that contradiction in favour
 * of one account per casing.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getAccessToken: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({ broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function get(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert>): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** Alphanumeric only, so a generated name is legal under any tightening of the policy. */
const uniqueUsername = () => `u${randomUUID().replace(/-/g, '').slice(0, 20)}`;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
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

describe('GET /auth/check-username/:username', () => {
  it('reports a taken username as unavailable', async () => {
    const username = uniqueUsername();
    await account({ username });

    const res = await get(`/auth/check-username/${username}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      available: false,
      message: 'Username is already taken',
    });
  });

  it('reports an unused username as available', async () => {
    const res = await get(`/auth/check-username/${uniqueUsername()}`);

    expect(res.body.data).toEqual({ available: true, message: 'Username is available' });
  });

  it('matches CASE-INSENSITIVELY — one account per casing', async () => {
    const username = uniqueUsername();
    await account({ username });

    const res = await get(`/auth/check-username/${username.toUpperCase()}`);

    expect((res.body.data as { available: boolean }).available).toBe(false);
  });

  /**
   * A hyphen is INSIDE the policy now, and this endpoint is the one read that
   * applies the write rule — so it has to say "available", not 400. The
   * predecessor rejected it while `POST /accounts` happily stored it, which is
   * the disagreement the single policy exists to end.
   */
  it('reports a hyphenated username as available, because a write would accept it', async () => {
    const res = await get(`/auth/check-username/${uniqueUsername()}-bot`);

    expect(res.status).toBe(200);
    expect((res.body.data as { available: boolean }).available).toBe(true);
  });

  it.each(['has.a.dot', 'has_a__double', '-leading', 'ab'])(
    'rejects %s with 400, because a write would reject it',
    async (username) => {
      const res = await get(`/auth/check-username/${username}`);
      expect(res.status).toBe(400);
    }
  );
});

describe('GET /auth/check-email/:email', () => {
  it('reports a registered email as unavailable', async () => {
    const email = `${randomUUID()}@example.com`;
    await account({ email });

    const res = await get(`/auth/check-email/${encodeURIComponent(email)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      available: false,
      message: 'Email is already registered',
    });
  });

  it('matches CASE-INSENSITIVELY, as the lowercase setter used to guarantee', async () => {
    const email = `${randomUUID()}@example.com`;
    await account({ email });

    const res = await get(`/auth/check-email/${encodeURIComponent(email.toUpperCase())}`);

    expect((res.body.data as { available: boolean }).available).toBe(false);
  });

  it('reports an unused email as available', async () => {
    const res = await get(`/auth/check-email/${encodeURIComponent(`${randomUUID()}@example.com`)}`);
    expect((res.body.data as { available: boolean }).available).toBe(true);
  });
});

describe('GET /auth/check-publickey/:publicKey', () => {
  /** An uncompressed secp256k1 key — `isValidPublicKey` rejects anything else. */
  const publicKey = () =>
    `04${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 0)}`.padEnd(
      130,
      'a',
    );

  it('reports a registered key as registered', async () => {
    const key = publicKey();
    await account({ publicKey: key });

    const res = await get(`/auth/check-publickey/${key}`);

    expect(res.status).toBe(200);
    expect((res.body.data as { registered: boolean }).registered).toBe(true);
  });

  it('reports an unknown key as available', async () => {
    const res = await get(`/auth/check-publickey/${publicKey()}`);
    expect((res.body.data as { registered: boolean }).registered).toBe(false);
  });

  it('rejects a malformed key with 400 before any lookup', async () => {
    const res = await get('/auth/check-publickey/not-a-key');
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/lookup/:username', () => {
  it('returns the minimal public identity for the login flow', async () => {
    const username = uniqueUsername();
    await account({
      username,
      color: 'teal',
      avatar: 'file-id-1',
      nameFirst: 'Ada',
      nameLast: 'Lovelace',
    });

    const res = await get(`/auth/lookup/${username}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      exists: true,
      username,
      color: 'teal',
      avatar: 'file-id-1',
      // `name.displayName` is composed server-side from the FLAT columns; the
      // wire shape is unchanged by the port.
      name: { displayName: 'Ada Lovelace', first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace' },
    });
  });

  it('omits displayName when the account has no real name', async () => {
    const username = uniqueUsername();
    await account({ username, color: 'blue' });

    const res = await get(`/auth/lookup/${username}`);

    // The API never synthesizes a display name from the username — consumers
    // fall back to the handle themselves.
    expect((res.body.data as { name: Record<string, unknown> }).name).toEqual({});
  });

  it('returns null for an absent avatar rather than omitting it', async () => {
    const username = uniqueUsername();
    await account({ username });

    const res = await get(`/auth/lookup/${username}`);

    expect((res.body.data as { avatar: string | null }).avatar).toBeNull();
  });

  it('is case-insensitive', async () => {
    const username = uniqueUsername();
    await account({ username });

    const res = await get(`/auth/lookup/${username.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect((res.body.data as { username: string }).username).toBe(username);
  });

  it('returns 404 for an unknown username', async () => {
    const res = await get(`/auth/lookup/${uniqueUsername()}`);
    expect(res.status).toBe(404);
  });
});
