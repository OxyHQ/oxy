/**
 * `GET /internal/service-acting-as/verify`, over real HTTP against a real
 * Postgres, with the REAL service-token middleware.
 *
 * This endpoint is the only thing standing between a service token and
 * impersonation of any user: `@oxyhq/core`'s `oxy.auth()` attaches
 * `req.userId` from the `X-Oxy-User-Id` header if and only if this answers
 * `authorized: true`. So the suite is built around what must be REFUSED, and
 * every refusal has its own case: no grant, a revoked grant, a grant naming
 * other scopes, a grant belonging to another user, a grant belonging to another
 * application, and a subject application that is no longer active.
 *
 * `serviceAuthMiddleware` is NOT mocked, and `jsonwebtoken` is restored to the
 * real implementation. Mocking either would delete the half of this endpoint's
 * gate that decides a service token is a service token at all — the suite would
 * still be green with the authentication removed, which is the failure mode
 * these tests exist to rule out. Only the rate limiter and the logger are
 * mocked: one is a Redis dependency, the other is noise.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

/** The middleware verifies the token itself, so the real JWT must be used. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { SERVICE_ACTING_AS_SCOPE } from '../../services/serviceActingAs.service';
import internalRouter from '../internal';

const ACCESS_TOKEN_SECRET = 'service-acting-as-verify-test-secret';

interface VerifyResponse {
  status: number;
  body: { data?: { authorized?: boolean; scopes?: string[] }; error?: string; message?: string };
}

let server: http.Server;

interface SeededApp {
  appId: string;
  credentialId: string;
  ownerAccountId: string;
}

async function user(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/**
 * An application plus one service credential — real rows, so every FK the grant
 * and the token point at resolves.
 *
 * `type` is the trust dial: `internal` is platform-trusted, `third_party` is
 * not. Both can carry a service credential, which is exactly why the router's
 * trust check is not redundant with holding a token.
 */
async function seedApp(
  type: 'internal' | 'third_party' = 'internal',
  status: 'active' | 'suspended' = 'active'
): Promise<SeededApp> {
  const ownerAccountId = await user();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type,
      status,
      scopes: ['user:read'],
      ownerAccountId,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'service',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return { appId: app.id, credentialId: credential.id, ownerAccountId };
}

async function grant(userId: string, applicationId: string, scopes: string[]): Promise<void> {
  await getDb().insert(appGrants).values({ userId, applicationId, scopes });
}

function serviceToken(app: SeededApp, options: { expiresIn?: number; secret?: string } = {}) {
  return jwt.sign(
    {
      type: 'service',
      appId: app.appId,
      appName: 'Verifier',
      credentialId: app.credentialId,
      ownerAccountId: app.ownerAccountId,
      environment: 'production',
      scopes: ['user:read'],
    },
    options.secret ?? ACCESS_TOKEN_SECRET,
    { expiresIn: options.expiresIn ?? 3600 }
  );
}

function verify(
  query: { appId: string; userId: string },
  token: string | null
): Promise<VerifyResponse> {
  const address = server.address() as AddressInfo;
  const path =
    '/internal/service-acting-as/verify' +
    `?appId=${encodeURIComponent(query.appId)}&userId=${encodeURIComponent(query.userId)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

// ---------------------------------------------------------------------------
// Gate 1 — a service token, and nothing else, opens this router
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('refuses a request with no Authorization header (401)', async () => {
    const subject = await seedApp();
    const subjectUser = await user();

    const res = await verify({ appId: subject.appId, userId: subjectUser }, null);

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a USER session token (403) — this is not a user-facing surface', async () => {
    const subject = await seedApp();
    const subjectUser = await user();
    // The shape a real session bearer has: `type` is anything but 'service'.
    const userJwt = jwt.sign(
      { type: 'access', userId: subjectUser, sessionId: 'session-1' },
      ACCESS_TOKEN_SECRET,
      { expiresIn: 3600 }
    );

    const res = await verify({ appId: subject.appId, userId: subjectUser }, userJwt);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a service token signed with the wrong secret (401)', async () => {
    const caller = await seedApp();
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const forged = serviceToken(caller, { secret: 'not-the-access-token-secret' });
    const res = await verify({ appId: subject.appId, userId: subjectUser }, forged);

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses an EXPIRED service token (401), even with a live grant behind it', async () => {
    const caller = await seedApp();
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const stale = serviceToken(caller, { expiresIn: -10 });
    const res = await verify({ appId: subject.appId, userId: subjectUser }, stale);

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — the CALLER must be a platform-trusted application
// ---------------------------------------------------------------------------

describe('caller trust', () => {
  it('refuses a THIRD-PARTY caller holding a valid service token (403)', async () => {
    // Not hypothetical: the service-token mint lets a non-trusted application
    // mint one from a payments-only credential, so "holds a service token" and
    // "is a first-party Oxy service" are different sets.
    const caller = await seedApp('third_party');
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a caller whose application is no longer active (403)', async () => {
    // The token lives an hour. An application suspended inside that window must
    // lose the router immediately, not when its last token expires.
    const caller = await seedApp('internal', 'suspended');
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The grant itself
// ---------------------------------------------------------------------------

describe('delegation grants', () => {
  let caller: SeededApp;

  beforeAll(async () => {
    caller = await seedApp('internal');
  });

  it('authorizes when the user granted the subject app acting-as:offline', async () => {
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE, 'podcasts:write']);

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      authorized: true,
      scopes: [SERVICE_ACTING_AS_SCOPE, 'podcasts:write'],
    });
  });

  it('REFUSES a grant that does not name acting-as:offline', async () => {
    // The whole hazard of reusing `app_grants`: a user has a row for every app
    // they ever signed into. If the row's existence authorized delegation, every
    // one of those apps could act as them. This is the case that proves it does
    // not.
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, ['user:read', 'files:write', 'podcasts:write']);

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('refuses when the user has no grant for the subject app at all', async () => {
    const subject = await seedApp();
    const subjectUser = await user();

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('refuses once the grant is REVOKED, having authorized before', async () => {
    const subject = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const before = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );
    expect(before.body.data).toEqual({ authorized: true, scopes: [SERVICE_ACTING_AS_SCOPE] });

    // Exactly what `DELETE /auth/grants/:applicationId` does.
    await getDb()
      .delete(appGrants)
      .where(
        and(eq(appGrants.userId, subjectUser), eq(appGrants.applicationId, subject.appId))
      );

    const after = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );
    expect(after.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('refuses for a DIFFERENT user than the one who granted', async () => {
    const subject = await seedApp();
    const granter = await user();
    const stranger = await user();
    await grant(granter, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const res = await verify({ appId: subject.appId, userId: stranger }, serviceToken(caller));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('refuses for a DIFFERENT app than the one granted', async () => {
    const granted = await seedApp();
    const other = await seedApp();
    const subjectUser = await user();
    await grant(subjectUser, granted.appId, [SERVICE_ACTING_AS_SCOPE]);

    const res = await verify({ appId: other.appId, userId: subjectUser }, serviceToken(caller));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('refuses when the SUBJECT application is no longer active, grant notwithstanding', async () => {
    const subject = await seedApp('internal', 'suspended');
    const subjectUser = await user();
    await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);

    const res = await verify(
      { appId: subject.appId, userId: subjectUser },
      serviceToken(caller)
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('answers 200 false for ids that name nothing — never 404, so it is no existence oracle', async () => {
    const unknownApp = randomUUID();
    const unknownUser = randomUUID();

    const res = await verify({ appId: unknownApp, userId: unknownUser }, serviceToken(caller));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authorized: false, scopes: [] });
  });

  it('rejects a request missing the query parameters entirely (400)', async () => {
    const address = server.address() as AddressInfo;
    const token = serviceToken(caller);
    const res = await new Promise<VerifyResponse>((resolve, reject) => {
      const req = http.request(
        {
          method: 'GET',
          host: '127.0.0.1',
          port: address.port,
          path: '/internal/service-acting-as/verify',
          headers: { authorization: `Bearer ${token}`, connection: 'close' },
        },
        (r) => {
          let raw = '';
          r.on('data', (c) => {
            raw += c;
          });
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
  });
});
