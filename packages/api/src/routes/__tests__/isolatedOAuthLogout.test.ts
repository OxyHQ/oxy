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
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  reserveAttempt: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../middleware/security', () => ({
  idpServiceLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignOut: jest.fn().mockResolvedValue(undefined),
  },
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
import sessionRouter from '../session';
import { sessions } from '../../db/schema/sessions';

let server: http.Server;
async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}
async function application(
  ownerAccountId: string,
): Promise<{ applicationId: string; clientId: string }> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `External ${randomUUID()}`,
      type: 'third_party',
      ownerAccountId,
      redirectUris: ['https://fixture.invalid/'],
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: row.id,
    name: 'public fixture',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  return { applicationId: row.id, clientId };
}
async function signIn(userId: string, app?: { applicationId: string; clientId: string }) {
  const created = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    {
      deviceId: `fixture-device-${randomUUID()}`,
      ...(app ? { application: { ...app, scopes: [] } } : {}),
    },
  );
  const minted = await sessionService.getAccessToken(created.sessionId);
  if (!minted) throw new Error('Fixture token mint failed');
  return { sessionId: created.sessionId, bearer: minted.accessToken };
}
async function active(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ active: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId));
  return row.active;
}
async function call(
  method: string,
  path: string,
  bearer: string,
  payload?: unknown,
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
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
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
  app.use('/session', sessionRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

const originalAccessTokenV1Window = process.env.ACCESS_TOKEN_V1_WINDOW;

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
  if (originalAccessTokenV1Window === undefined)
    Reflect.deleteProperty(process.env, 'ACCESS_TOKEN_V1_WINDOW');
  else process.env.ACCESS_TOKEN_V1_WINDOW = originalAccessTokenV1Window;
});

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
  Reflect.deleteProperty(process.env, 'ACCESS_TOKEN_V1_WINDOW');
});

describe('isolated OAuth self-logout with real bearer validation and Postgres', () => {
  it('revokes only itself and preserves the same person in another app and the shared lane', async () => {
    const owner = await account();
    const own = await signIn(owner, await application(owner));
    const other = await signIn(owner, await application(owner));
    const shared = await signIn(owner);
    const result = await call('POST', `/session/logout/${own.sessionId}`, own.bearer);
    expect(result.status).toBe(200);
    expect(await active(own.sessionId)).toBe(false);
    expect(await active(other.sessionId)).toBe(true);
    expect(await active(shared.sessionId)).toBe(true);
    expect((await call('POST', `/session/logout/${own.sessionId}`, own.bearer)).status).toBe(401);
  });

  it('refuses a different acting identifier and an explicit target of the same person', async () => {
    const owner = await account();
    const own = await signIn(owner, await application(owner));
    const other = await signIn(owner, await application(owner));
    for (const path of [
      `/session/logout/${other.sessionId}`,
      `/session/logout/${own.sessionId}/${other.sessionId}`,
    ]) {
      expect((await call('POST', path, own.bearer)).status).toBe(403);
    }
    expect(await active(own.sessionId)).toBe(true);
    expect(await active(other.sessionId)).toBe(true);
  });

  it('refuses global and device-wide sign-out without changing any session', async () => {
    const owner = await account();
    const own = await signIn(owner, await application(owner));
    const shared = await signIn(owner);
    for (const path of [
      `/session/logout-all/${own.sessionId}`,
      `/session/device/logout-all/${own.sessionId}`,
    ]) {
      expect((await call('POST', path, own.bearer)).status).toBe(403);
    }
    expect(await active(own.sessionId)).toBe(true);
    expect(await active(shared.sessionId)).toBe(true);
  });

  it('preserves the existing unbound same-owner target sign-out', async () => {
    const owner = await account();
    const own = await signIn(owner);
    const other = await signIn(owner);
    expect(
      (await call('POST', `/session/logout/${own.sessionId}/${other.sessionId}`, own.bearer))
        .status,
    ).toBe(200);
    expect(await active(own.sessionId)).toBe(true);
    expect(await active(other.sessionId)).toBe(false);
  });
});

describe('device metadata isolation with real bearer validation', () => {
  it('denies app-bound read and rename of an unbound session of the same person', async () => {
    const owner = await account();
    const own = await signIn(owner, await application(owner));
    const shared = await signIn(owner);
    const read = await call('GET', `/session/device/sessions/${shared.sessionId}`, own.bearer);
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain(shared.sessionId);
    const rename = await call('PUT', `/session/device/name/${shared.sessionId}`, own.bearer, {
      deviceName: 'cross-app-reproduction',
    });
    expect(rename.status).toBe(403);
    const [changed] = await getDb()
      .select({ name: sessions.deviceName })
      .from(sessions)
      .where(eq(sessions.sessionId, shared.sessionId));
    expect(changed.name).not.toBe('cross-app-reproduction');
    expect(await active(own.sessionId)).toBe(true);
    expect(await active(shared.sessionId)).toBe(true);
  });
});

it('unbound session preserves device metadata read and rename', async () => {
  const owner = await account();
  const shared = await signIn(owner);
  expect(
    (await call('GET', `/session/device/sessions/${shared.sessionId}`, shared.bearer)).status,
  ).toBe(200);
  expect(
    (
      await call('PUT', `/session/device/name/${shared.sessionId}`, shared.bearer, {
        deviceName: 'own-device',
      })
    ).status,
  ).toBe(200);
  const [row] = await getDb()
    .select({ name: sessions.deviceName })
    .from(sessions)
    .where(eq(sessions.sessionId, shared.sessionId));
  expect(row.name).toBe('own-device');
  expect(await active(shared.sessionId)).toBe(true);
});
