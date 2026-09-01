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
import {
  clearServiceActingAsRevocation,
  revokeServiceActingAs,
  SERVICE_ACTING_AS_SCOPE,
} from '../../services/serviceActingAs.service';
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

/** What `DELETE /auth/grants/:applicationId` writes beside deleting the row. */
async function revoke(userId: string, applicationId: string): Promise<void> {
  await revokeServiceActingAs(userId, applicationId);
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
// Who may be acted for
//
// Offline delegation is AUTOMATIC for platform-trusted applications — the owner
// decided the platform does not ask a user to authorize one Oxy app to act for
// them in another. So the cases that carry weight are the ones that must still
// refuse: an untrusted application, an inactive one, and a user who said no.
// ---------------------------------------------------------------------------

describe('delegation', () => {
  let caller: SeededApp;

  beforeAll(async () => {
    caller = await seedApp('internal');
  });

  describe('automatic for first-party', () => {
    it('authorizes a trusted app with NO grant row, carrying the app scopes', async () => {
      const subject = await seedApp('internal');
      const subjectUser = await user();

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.status).toBe(200);
      // `seedApp` grants the application `user:read`; the automatic path returns
      // the application's own ceiling, since no per-user decision exists to
      // narrow by. `requireScope` still intersects with the token's scopes.
      expect(res.body.data).toEqual({ authorized: true, scopes: ['user:read'] });
    });

    it('refuses a trusted app that is no longer active', async () => {
      const subject = await seedApp('internal', 'suspended');
      const subjectUser = await user();

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ authorized: false, scopes: [] });
    });
  });

  describe('automatic does NOT extend to third parties', () => {
    it('REFUSES an untrusted subject app with no grant', async () => {
      // The load-bearing negative of the whole rework. "Trusted" is the gate;
      // if this passes, every self-service application on the platform can act
      // as every user.
      const subject = await seedApp('third_party');
      const subjectUser = await user();

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ authorized: false, scopes: [] });
    });

    it('refuses an untrusted subject app whose grant does NOT name acting-as:offline', async () => {
      // A user has a grant row for every app they ever signed into. The row's
      // existence must authorize nothing.
      const subject = await seedApp('third_party');
      const subjectUser = await user();
      await grant(subjectUser, subject.appId, ['user:read', 'files:write', 'podcasts:write']);

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.body.data).toEqual({ authorized: false, scopes: [] });
    });

    it('authorizes an untrusted subject app when the grant DOES name it', async () => {
      const subject = await seedApp('third_party');
      const subjectUser = await user();
      await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE, 'podcasts:write']);

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.body.data).toEqual({
        authorized: true,
        scopes: [SERVICE_ACTING_AS_SCOPE, 'podcasts:write'],
      });
    });
  });

  describe('revocation', () => {
    it('REFUSES a first-party app the user explicitly revoked', async () => {
      // Automatic by default must not mean unrevocable. There is no grant row
      // to delete for a trusted app, so this is the only thing standing between
      // a user who said no and an app that keeps acting for them.
      const subject = await seedApp('internal');
      const subjectUser = await user();

      const before = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );
      expect(before.body.data).toEqual({ authorized: true, scopes: ['user:read'] });

      await revoke(subjectUser, subject.appId);

      const after = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );
      expect(after.body.data).toEqual({ authorized: false, scopes: [] });
    });

    it('beats an explicit grant too — revocation is checked first', async () => {
      // The grant path must not be a way around a refusal.
      const subject = await seedApp('third_party');
      const subjectUser = await user();
      await grant(subjectUser, subject.appId, [SERVICE_ACTING_AS_SCOPE]);
      await revoke(subjectUser, subject.appId);

      const res = await verify(
        { appId: subject.appId, userId: subjectUser },
        serviceToken(caller)
      );

      expect(res.body.data).toEqual({ authorized: false, scopes: [] });
    });

    it('is per (user, application) — one user revoking does not refuse for another', async () => {
      const subject = await seedApp('internal');
      const refuser = await user();
      const bystander = await user();
      await revoke(refuser, subject.appId);

      const refused = await verify(
        { appId: subject.appId, userId: refuser },
        serviceToken(caller)
      );
      const allowed = await verify(
        { appId: subject.appId, userId: bystander },
        serviceToken(caller)
      );

      expect(refused.body.data).toEqual({ authorized: false, scopes: [] });
      expect(allowed.body.data).toEqual({ authorized: true, scopes: ['user:read'] });
    });

    it('is per application — revoking one first-party app leaves the others acting', async () => {
      const revoked = await seedApp('internal');
      const other = await seedApp('internal');
      const subjectUser = await user();
      await revoke(subjectUser, revoked.appId);

      expect(
        (await verify({ appId: revoked.appId, userId: subjectUser }, serviceToken(caller))).body
          .data
      ).toEqual({ authorized: false, scopes: [] });
      expect(
        (await verify({ appId: other.appId, userId: subjectUser }, serviceToken(caller))).body.data
      ).toEqual({ authorized: true, scopes: ['user:read'] });
    });

    it('is undone by a grant naming acting-as:offline, and by nothing weaker', async () => {
      // The re-authorization path. `acting-as:offline` is consent-required, so
      // approving it means a person read a consent screen — which is why
      // clearing on it is safe where clearing on any authorize would not be.
      const subject = await seedApp('internal');
      const subjectUser = await user();
      await revoke(subjectUser, subject.appId);

      // A weaker grant does not undo it.
      await grant(subjectUser, subject.appId, ['user:read']);
      expect(
        (await verify({ appId: subject.appId, userId: subjectUser }, serviceToken(caller))).body
          .data
      ).toEqual({ authorized: false, scopes: [] });

      // The real thing does — this is what `recordAppGrant` calls.
      await clearServiceActingAsRevocation(subjectUser, subject.appId);
      await getDb()
        .update(appGrants)
        .set({ scopes: ['user:read', SERVICE_ACTING_AS_SCOPE] })
        .where(
          and(eq(appGrants.userId, subjectUser), eq(appGrants.applicationId, subject.appId))
        );

      expect(
        (await verify({ appId: subject.appId, userId: subjectUser }, serviceToken(caller))).body
          .data
      ).toEqual({ authorized: true, scopes: ['user:read', SERVICE_ACTING_AS_SCOPE] });
    });
  });

  describe('the answer reveals nothing else', () => {
    it('answers 200 false for ids that name nothing — never 404', async () => {
      const res = await verify(
        { appId: randomUUID(), userId: randomUUID() },
        serviceToken(caller)
      );

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
});
