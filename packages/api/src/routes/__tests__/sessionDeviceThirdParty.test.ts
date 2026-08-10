/**
 * Third-party isolation on the device lane (issue #937, Phase 6).
 *
 * The claim being pinned: a third-party OAuth client holding a perfectly valid
 * user bearer cannot read who is on the device, cannot activate the globally
 * active context, and cannot mint a device-wide background credential. An
 * official application's bearer can do all three, and so can an ordinary
 * device session that belongs to no application at all.
 *
 * WHAT IS REAL HERE, and why it has to be. The bearer path is the SUBJECT, so
 * `authMiddleware`, `sessionService.validateSession`, the binding check and the
 * `applications` lookup all run for real against Postgres — a mocked
 * `authMiddleware` (which the sibling device suites use, correctly, because the
 * mint is their subject) would never populate `req.oxyToken` and this whole
 * file would pass against a deleted guard. Only the edges are mocked: the CSRF
 * origin check, the Redis limiter, Socket.IO and the logger.
 *
 * `jsonwebtoken` is restored to the real signer: `sessions.access_token` is
 * UNIQUE, so the global constant-token mock collides on the second mint, and a
 * constant token could not carry the claims this file is about.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../middleware/originGuard', () => ({
  requireSameSiteOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: jest.fn().mockResolvedValue({ locked: false, attempts: 0 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import deviceSessionService from '../../services/deviceSession.service';
import sessionService from '../../services/session.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import sessionDeviceRouter from '../sessionDevice';

let server: http.Server;

type AppKind = Partial<typeof applications.$inferInsert>;

/** An ordinary self-service third-party application. */
const THIRD_PARTY: AppKind = { type: 'third_party' };
/** An official Oxy application, per the registry predicate. */
const OFFICIAL: AppKind = { type: 'first_party', isOfficial: true };

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

async function application(fields: AppKind): Promise<{ applicationId: string; clientId: string }> {
  const owner = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      redirectUris: ['https://example.test/cb'],
      ...fields,
      ownerAccountId: owner,
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  return { applicationId: app.id, clientId };
}

/**
 * Sign a person in on a device and return the bearer their apps would present.
 * `app` present ⇒ the session is that application's; absent ⇒ the ordinary
 * shared device session.
 */
async function signIn(
  deviceId: string,
  userId: string,
  app?: { applicationId: string; clientId: string }
): Promise<string> {
  const session = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    {
      deviceId,
      ...(app
        ? { application: { applicationId: app.applicationId, clientId: app.clientId, scopes: [] } }
        : {}),
    }
  );
  await deviceSessionService.addAccount(deviceId, {
    accountId: userId,
    sessionId: session.sessionId,
  });
  // The device-login lane binds the context after `addAccount`; do the same so
  // the bearer here is shaped exactly like a real one.
  await deviceSessionService.bindSessionToContext(deviceId, session.sessionId);
  const minted = await sessionService.getAccessToken(session.sessionId);
  if (!minted) throw new Error('no access token for the freshly created session');
  return minted.accessToken;
}

async function activeContextId(deviceId: string): Promise<string> {
  const [device] = await getDb()
    .select({ id: deviceSessions.id })
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId))
    .limit(1);
  const [context] = await getDb()
    .select({ id: deviceAccountContexts.id })
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id))
    .limit(1);
  return context.id;
}

async function call(
  method: string,
  path: string,
  bearer: string,
  payload?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/session/device', sessionDeviceRouter);
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

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
  delete process.env.ACCESS_TOKEN_V1_WINDOW;
});

describe('a third-party application bearer is refused the whole device lane', () => {
  it('cannot read the device directory', async () => {
    const device = `dev-${randomUUID()}`;
    const bearer = await signIn(device, await account(), await application(THIRD_PARTY));

    const res = await call('GET', '/session/device/directory', bearer);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
  });

  it('cannot activate the globally active context', async () => {
    const device = `dev-${randomUUID()}`;
    const user = await account();
    // The user's OWN device session exists and has a context; the third party's
    // bearer belongs to the same human on the same device. What it lacks is the
    // authority to move what every other app on that device follows.
    await signIn(device, user);
    const contextId = await activeContextId(device);
    const bearer = await signIn(device, user, await application(THIRD_PARTY));

    const res = await call('POST', '/session/device/activate', bearer, { contextId });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
  });

  it('cannot mint a device-wide background credential', async () => {
    const device = `dev-${randomUUID()}`;
    const bearer = await signIn(device, await account(), await application(THIRD_PARTY));

    const res = await call('POST', '/session/device/background-credential', bearer);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
  });

  it('cannot read the flat device state either', async () => {
    const device = `dev-${randomUUID()}`;
    const bearer = await signIn(device, await account(), await application(THIRD_PARTY));

    const res = await call('GET', '/session/device/state', bearer);

    expect(res.status).toBe(403);
  });
});

describe('the lane stays open to everything that is not a third party', () => {
  it('serves the directory to an ordinary, application-less device session', async () => {
    const device = `dev-${randomUUID()}`;
    const user = await account();
    const bearer = await signIn(device, user);

    const res = await call('GET', '/session/device/directory', bearer);

    expect(res.status).toBe(200);
    expect((res.body as { data: { deviceId: string } }).data.deviceId).toBe(device);
  });

  it('serves the directory to an OFFICIAL application bearer', async () => {
    const device = `dev-${randomUUID()}`;
    const user = await account();
    const bearer = await signIn(device, user, await application(OFFICIAL));

    const res = await call('GET', '/session/device/directory', bearer);

    expect(res.status).toBe(200);
  });
});

describe('the decision is the registry’s, re-read per request', () => {
  it('locks an application out the moment it stops being official', async () => {
    const device = `dev-${randomUUID()}`;
    const app = await application(OFFICIAL);
    const bearer = await signIn(device, await account(), app);
    expect((await call('GET', '/session/device/directory', bearer)).status).toBe(200);

    await getDb()
      .update(applications)
      .set({ type: 'third_party', isOfficial: false })
      .where(eq(applications.id, app.applicationId));

    // Same bearer, same session, same claims — only the registry moved. A
    // decision frozen into the token at mint time would still answer 200.
    expect((await call('GET', '/session/device/directory', bearer)).status).toBe(403);
  });

  it('fails CLOSED when the application is suspended', async () => {
    const device = `dev-${randomUUID()}`;
    const app = await application(OFFICIAL);
    const bearer = await signIn(device, await account(), app);

    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, app.applicationId));

    expect((await call('GET', '/session/device/directory', bearer)).status).toBe(403);
  });

  it('kills the session outright when the application row is DELETED', async () => {
    // `sessions.application_id` is `ON DELETE CASCADE`, not `SET NULL`, and the
    // difference is the whole point: `SET NULL` means "not an application's
    // session", so it would PROMOTE this bearer into a first-party one — 200 on
    // the device lane — exactly the laundering the binding exists to prevent.
    // The bearer must stop resolving to a session at all.
    const device = `dev-${randomUUID()}`;
    const app = await application(THIRD_PARTY);
    const bearer = await signIn(device, await account(), app);

    await getDb().delete(applications).where(eq(applications.id, app.applicationId));
    sessionCache.clear();

    expect((await call('GET', '/session/device/directory', bearer)).status).toBe(401);
  });
});

describe('a v1 bearer is governed by the row, not by what it claims', () => {
  it('refuses a legacy token for an application-bound session', async () => {
    // A v1 token asserted no `azp` at all, so the guard cannot be reading the
    // claim — it reads `sessions.application_id`, which is why a bearer minted
    // before this phase is still isolated.
    const device = `dev-${randomUUID()}`;
    const user = await account();
    const app = await application(THIRD_PARTY);
    const bearer = await signIn(device, user, app);

    const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
    const claims = jwt.verify(bearer, process.env.ACCESS_TOKEN_SECRET as string) as {
      userId: string;
      sessionId: string;
      deviceId: string;
    };
    const legacy = jwt.sign(
      {
        userId: claims.userId,
        sessionId: claims.sessionId,
        deviceId: claims.deviceId,
        type: 'access',
      },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' }
    );

    const res = await call('GET', '/session/device/directory', legacy);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
  });

  it('is refused outright by the auth lane once the v1 window closes', async () => {
    const device = `dev-${randomUUID()}`;
    const user = await account();
    const bearer = await signIn(device, user);

    const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
    const claims = jwt.verify(bearer, process.env.ACCESS_TOKEN_SECRET as string) as {
      userId: string;
      sessionId: string;
      deviceId: string;
    };
    const legacy = jwt.sign(
      {
        userId: claims.userId,
        sessionId: claims.sessionId,
        deviceId: claims.deviceId,
        type: 'access',
      },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' }
    );
    // Open window: the legacy bearer works.
    expect((await call('GET', '/session/device/directory', legacy)).status).toBe(200);

    process.env.ACCESS_TOKEN_V1_WINDOW = 'closed';
    sessionCache.clear();

    // Closed: 401 from the session lane, not 403 from the device guard — the
    // token never resolves to a session at all.
    expect((await call('GET', '/session/device/directory', legacy)).status).toBe(401);
    // ...and the v2 bearer for the same session is unaffected.
    expect((await call('GET', '/session/device/directory', bearer)).status).toBe(200);
  });
});
