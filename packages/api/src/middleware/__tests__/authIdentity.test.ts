/**
 * What a route handler actually receives on `req.user`, end to end, against a
 * REAL Postgres.
 *
 * ## Why this file exists
 *
 * `middleware/auth.ts` used to attach the authenticated account through
 * `const fullUser = user as IUser & Document`. That cast meant `tsc` checked
 * NONE of the 58 `req.user._id` / `req.user.id` reads that flow from it — so
 * changing the shape of what `sessionService.validateSession` returns could
 * break every authenticated route in the API with a clean compile, and the
 * symptom would be an ownership check silently comparing `undefined`, not a
 * type error.
 *
 * The cast is gone, but a type is not a runtime guarantee: `AuthRequest.user`
 * is `AccountDocument`, whose index signature would happily type a missing
 * property. So the identity is asserted HERE, against a real session minted by
 * the real service, read by a real handler.
 *
 * ## The two fields, and why BOTH are pinned
 *
 * `_id` and `id` are both the ACCOUNT ID on `req.user`, and they always have
 * been. They are pinned separately because they get there differently:
 *
 *  - `_id` comes from the account document (`readAccountDocument` writes
 *    `_id: row.id`) and means the account id unconditionally.
 *  - `id` on that same document is the model's old `id` virtual,
 *    `publicKey ?? _id` — so for an account holding a Commons identity key the
 *    DOCUMENT's `id` is the PUBLIC KEY. The middleware pins it to the account
 *    id, and 43 call sites read it that way.
 *
 * The keyed-account case below is the one that matters: it is the only shape
 * in which the two could disagree, and a regression there hands ownership
 * checks a public key instead of an account id — with both values being
 * non-empty strings, so nothing crashes.
 *
 * MOCKED: nothing on the identity path. `securityActivityService` only, because
 * a first session on a new device writes an activity row this file is not about.
 */

import express, { type Response } from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';

/*
 * The global `jest.setup.cjs` mocks `jsonwebtoken` to a constant string. Real
 * sessions here need real tokens: `sessions.access_token` is UNIQUE, so a
 * constant makes the second insert collide, and `authMiddleware` has to be able
 * to VERIFY what it is handed.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import { authMiddleware, simpleAuthMiddleware, type AuthRequest, type SimpleAuthRequest } from '../auth';
import { optionalAuthMiddleware } from '../optionalAuth';
import type { AuthenticatedRequest } from '../authUtils';
import sessionService from '../../services/session.service';

let server: http.Server;

/** What each probe route echoes back about the identity it was handed. */
interface IdentityEcho {
  present: boolean;
  _id?: unknown;
  id?: unknown;
  username?: unknown;
  isStaff?: unknown;
  email?: unknown;
  keys?: string[];
}

/**
 * A `users` row. Rows are NEVER deleted afterwards: the throwaway database is
 * shared by the whole run, and suites that bracket a global COUNT
 * (`platformStats`) assume counts only grow — a cleanup delete makes the
 * service's count fall below the bracket's floor and fails a suite this file
 * has nothing to do with.
 */
async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `ident-${randomUUID().slice(0, 12)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

/** A minimal Express request carrying only what `extractDeviceInfo` reads. */
function deviceRequest() {
  return {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'accept-language': 'en-US',
    },
  } as unknown as Parameters<typeof sessionService.createSession>[1];
}

/** Mint a real session for `userId` and return its access token. */
async function signIn(userId: string): Promise<string> {
  const session = await sessionService.createSession(userId, deviceRequest(), {
    deviceId: `dev-${randomUUID()}`,
  });
  // Both caches are process-global; clearing makes each test read through to
  // the database rather than inheriting another test's hydration.
  sessionCache.clear();
  userCache.clear();
  return session.accessToken;
}

function get(path: string, token?: string): Promise<{ status: number; body: IdentityEcho }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await connectPostgres();
  // Real JWTs, signed and verified for real: `authMiddleware` has to be able to
  // verify what `sessionService` minted, so these are set rather than mocked
  // (`sessionUtils` reads them at call time).
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);

  const app = express();

  // A handler shaped exactly like the ~25 route files that import `AuthRequest`.
  app.get('/probe/full', authMiddleware, (req: AuthRequest, res: Response) => {
    res.json({
      present: Boolean(req.user),
      _id: req.user?._id,
      id: req.user?.id,
      username: req.user?.username,
      isStaff: req.user?.isStaff,
      email: req.user?.email,
      keys: req.user ? Object.keys(req.user) : [],
    } satisfies IdentityEcho);
  });

  app.get('/probe/simple', simpleAuthMiddleware, (req: SimpleAuthRequest, res: Response) => {
    res.json({ present: Boolean(req.user), id: req.user?.id } satisfies IdentityEcho);
  });

  app.get('/probe/optional', optionalAuthMiddleware, (req: AuthenticatedRequest, res: Response) => {
    res.json({
      present: Boolean(req.user),
      _id: req.user?._id,
      id: req.user?.id,
      keys: req.user ? Object.keys(req.user) : [],
    } satisfies IdentityEcho);
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

describe('authMiddleware — the identity a handler receives', () => {
  it('hands the handler a USABLE account id on `_id`', async () => {
    const userId = await account();
    const token = await signIn(userId);

    const res = await get('/probe/full', token);

    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    // Not merely "defined": the exact account id. A silent `undefined` here is
    // an authentication bug, not a data bug — every ownership check downstream
    // compares against this value.
    expect(res.body._id).toBe(userId);
    expect(typeof res.body._id).toBe('string');
  });

  it('hands the handler the SAME account id on `id`', async () => {
    const userId = await account();
    const token = await signIn(userId);

    const res = await get('/probe/full', token);

    expect(res.body.id).toBe(userId);
    expect(res.body.id).toBe(res.body._id);
  });

  it('keeps `id` the ACCOUNT id for an account that holds a public key', async () => {
    // The account document's own `id` is `publicKey ?? _id`, so this is the one
    // shape where `id` and `_id` could disagree. They must not: 43 call sites
    // read `req.user.id` as the account id, and handing them a public key would
    // be a change of VALUE at ownership checks that no type can catch.
    const publicKey = `04${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const userId = await account({ publicKey });
    const token = await signIn(userId);

    const res = await get('/probe/full', token);

    expect(res.body._id).toBe(userId);
    expect(res.body.id).toBe(userId);
    expect(res.body.id).not.toBe(publicKey);
  });

  it('carries the ordinary account fields a route reads', async () => {
    const userId = await account({ username: `staffer-${randomUUID().slice(0, 8)}`, isStaff: true });
    const token = await signIn(userId);

    const res = await get('/probe/full', token);

    expect(res.body.isStaff).toBe(true);
    expect(typeof res.body.username).toBe('string');
  });

  it('never carries a protected column onto the request', async () => {
    const userId = await account({ phone: '+15550001111' });
    const token = await signIn(userId);

    const res = await get('/probe/full', token);

    // `readAccountDocument` reads through `publicColumns(users)`, so the raw
    // phone number, both contact-discovery hashes and the refresh token cannot
    // reach a handler — which the `.select('-password')` this replaced allowed.
    expect(res.body.keys).not.toContain('phone');
    expect(res.body.keys).not.toContain('hashedEmail');
    expect(res.body.keys).not.toContain('hashedPhone');
    expect(res.body.keys).not.toContain('refreshToken');
    expect(res.body.keys).not.toContain('password');
  });

  it('does NOT write the pinned `id` back into the shared user cache', async () => {
    // `req.user` is a shallow COPY. The code this replaced mutated the cached
    // object (`fullUser.id = fullUser._id`), so every concurrent request for
    // this account — and `GET /users/me/data`, which serves the same document
    // shape — inherited the overwrite.
    const publicKey = `04${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const userId = await account({ publicKey });
    const token = await signIn(userId);

    await get('/probe/full', token);

    const cached = userCache.get(userId);
    expect(cached?._id).toBe(userId);
    expect(cached?.id).toBe(publicKey);
  });

  it('rejects a request with no bearer token', async () => {
    const res = await get('/probe/full');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage bearer token', async () => {
    const res = await get('/probe/full', 'not-a-token');
    expect(res.status).toBe(401);
  });

  it('rejects a token whose session was deactivated', async () => {
    const userId = await account();
    const token = await signIn(userId);
    const validated = await sessionService.validateSession(token);
    await sessionService.deactivateSession(validated?.session.sessionId ?? '');
    sessionCache.clear();

    expect((await get('/probe/full', token)).status).toBe(401);
  });
});

describe('simpleAuthMiddleware — the id-only identity', () => {
  it('resolves the account id from the session', async () => {
    const userId = await account();
    const token = await signIn(userId);

    const res = await get('/probe/simple', token);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
  });

  it('resolves the ACCOUNT id, not the public key, for a keyed account', async () => {
    const publicKey = `04${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const userId = await account({ publicKey });
    const token = await signIn(userId);

    expect((await get('/probe/simple', token)).body.id).toBe(userId);
  });

  it('rejects a garbage token', async () => {
    expect((await get('/probe/simple', 'not-a-token')).status).toBe(401);
  });
});

describe('optionalAuthMiddleware — the non-blocking identity', () => {
  it('resolves `_id` to the account id when a valid bearer is present', async () => {
    const userId = await account();
    const token = await signIn(userId);

    const res = await get('/probe/optional', token);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(userId);
  });

  it('resolves `_id` to the ACCOUNT id, never the public key, for a keyed account', async () => {
    // `normalizeUser` falls back to the document's `id` only when it is NOT the
    // public key. That guard is the reason this cannot become a public key.
    const publicKey = `04${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const userId = await account({ publicKey });
    const token = await signIn(userId);

    const res = await get('/probe/optional', token);

    expect(res.body._id).toBe(userId);
    expect(res.body._id).not.toBe(publicKey);
    // `id` is DROPPED on this path — there is no handler pinning it here, so an
    // ambiguous one must not be readable at all.
    expect(res.body.keys).not.toContain('id');
  });

  it('serves an anonymous request without a user rather than rejecting it', async () => {
    const res = await get('/probe/optional');

    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
  });

  it('serves a request with an invalid bearer as anonymous', async () => {
    const res = await get('/probe/optional', 'not-a-token');

    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
  });
});
