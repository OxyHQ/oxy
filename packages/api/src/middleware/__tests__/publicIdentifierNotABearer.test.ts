/**
 * A bare `oxy_dk_*` cannot authenticate anywhere a BEARER is required — the
 * middleware lanes, against a REAL Postgres. Issue #972, workstream 2.1.
 *
 * The companion file `routes/__tests__/publicIdentifierNotASecret.test.ts`
 * covers the two lanes that take a credential in a request BODY. This one
 * covers the two that read `Authorization: Bearer`, which is the exact header
 * the wrong Console documentation told developers to put a client id into:
 *
 *   1. `authMiddleware` — the user session lane. It accepts a session-bound
 *      access token and nothing else.
 *   2. `serviceAuthMiddleware` — the service-token lane. It accepts only a
 *      signed `type: 'service'` JWT minted by `POST /auth/service-token`.
 *
 * They are separate cases because they reject for structurally different
 * reasons — one fails at session resolution, the other at signature
 * verification — and a change that broke one would leave the other passing.
 *
 * Each rejection is paired with a POSITIVE CONTROL that differs ONLY in the
 * credential presented, so a lane broken for an unrelated reason cannot pass
 * itself off as "correctly refused".
 */

import express, { type Response } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

/*
 * The global `jest.setup.cjs` mocks `jsonwebtoken` to a constant string. Both
 * lanes here turn on real signing and real verification: `sessions.access_token`
 * is UNIQUE (a constant collides on the second insert), and the service lane's
 * whole subject is whether a signature verifies.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import sessionService from '../../services/session.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../auth';
import { rateLimit } from '../rateLimiter';

/**
 * The probe routes below carry the repo's real limiter, exactly as a production
 * route that performs authorization does.
 *
 * It is SCAFFOLDING — nothing here asserts anything about rate limiting, and the
 * ceiling is far above what these few cases send, so it can never colour a
 * result. It exists because a probe app that mounts real authorization
 * middleware without a limiter is not a faithful model of production, and
 * static analysis is right to say so. Keep it: removing it makes this harness
 * describe a shape the API does not actually ship.
 *
 * The prefix follows the `rl:<scope>:` convention and is unique to this file —
 * two limiters sharing one key would double-count and throw
 * `ERR_ERL_DOUBLE_COUNT`. With no Redis configured under test the factory falls
 * back to express-rate-limit's in-memory store, whose sweep interval is
 * `unref`'d, so it cannot hold jest open.
 */
const probeLimiter = rateLimit({
  prefix: 'rl:test:public-identifier-probe:',
  windowMs: 60_000,
  max: 10_000,
});

/**
 * A public identifier of exactly the shape `applications.ts` mints:
 * `oxy_dk_` + 24 random bytes as hex.
 */
function publicIdentifier(): string {
  return `oxy_dk_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

let server: http.Server;

interface Probe {
  status: number;
  body: { authenticated?: boolean; userId?: unknown; appId?: unknown };
}

function get(path: string, bearer?: string): Promise<Probe> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
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

/**
 * A LIVE `application_credentials` row, and its public key. Used to prove the
 * refusal is not merely "this string is unknown" — the identifier below is a
 * real, active, resolvable client id at the moment it is presented.
 */
async function registeredClientId(): Promise<string> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });
  const publicKey = publicIdentifier();
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    type: 'public',
    environment: 'production',
    publicKey,
  });
  return publicKey;
}

/** A `users` row. Never deleted — the throwaway database is shared by the run. */
async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `dkbearer-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

/** Mint a REAL session and return the access token `authMiddleware` accepts. */
async function signIn(userId: string): Promise<string> {
  const session = await sessionService.createSession(
    userId,
    {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'accept-language': 'en-US',
      },
    } as unknown as Parameters<typeof sessionService.createSession>[1],
    { deviceId: `dev-${randomUUID()}` },
  );
  // Both caches are process-global; clearing makes each case read through to
  // the database rather than inheriting another's hydration.
  sessionCache.clear();
  userCache.clear();
  return session.accessToken;
}

/** A REAL service JWT, signed exactly as `POST /auth/service-token` signs one. */
function serviceToken(): string {
  return jwt.sign(
    {
      type: 'service',
      appId: randomUUID(),
      appName: 'Probe',
      credentialId: randomUUID(),
      // The full attribution tuple the real mint emits (ADR 0007). Omitting
      // `ownerAccountId` makes `verifyServiceToken` answer `not_service`, which
      // would quietly turn the positive control below into a second negative.
      ownerAccountId: randomUUID(),
      environment: 'production',
      scopes: ['user:read'],
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h', issuer: 'oxy-api', audience: 'oxy-services' },
  );
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);

  const app = express();
  app.get('/probe/user', probeLimiter, authMiddleware, (req: AuthRequest, res: Response) => {
    res.json({ authenticated: Boolean(req.user), userId: req.user?._id });
  });
  app.get(
    '/probe/service',
    probeLimiter,
    serviceAuthMiddleware,
    (req: ServiceAuthRequest, res: Response) => {
      res.json({ authenticated: Boolean(req.serviceApp), appId: req.serviceApp?.appId });
    },
  );
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

describe('lane 3 — authMiddleware (the user session bearer)', () => {
  it('REFUSES a bare oxy_dk_* presented as the bearer', async () => {
    const res = await get('/probe/user', publicIdentifier());

    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBeUndefined();
  });

  it('REFUSES a bare oxy_dk_* even when it names a REAL, usable credential', async () => {
    // The identifier being REGISTERED changes nothing: this lane never looks
    // credentials up, so a live client id is as worthless here as noise. The
    // case exists because "unknown value rejected" and "public identifier is
    // not a bearer" are different claims, and only the second is the invariant
    // — an implementation that resolved client ids would pass the first.
    const clientId = await registeredClientId();

    const res = await get('/probe/user', clientId);

    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL: a real session access token authenticates', async () => {
    const userId = await account();
    const token = await signIn(userId);

    const res = await get('/probe/user', token);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.userId).toBe(userId);
  });
});

describe('lane 4 — serviceAuthMiddleware (the service token bearer)', () => {
  it('REFUSES a bare oxy_dk_* presented as the bearer', async () => {
    const res = await get('/probe/service', publicIdentifier());

    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBeUndefined();
  });

  it('POSITIVE CONTROL: a real service token authenticates', async () => {
    const res = await get('/probe/service', serviceToken());

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(typeof res.body.appId).toBe('string');
  });

  it('does not accept a USER session token either — the two bearers stay distinct', async () => {
    const token = await signIn(await account());

    const res = await get('/probe/service', token);

    expect(res.status).toBe(403);
  });
});
