/**
 * POST/DELETE /notifications/push-token — device- and app-scoped registration,
 * against a REAL Postgres.
 *
 * The install's owning application is resolved SERVER-side from the caller's
 * `clientId` (an `ApplicationCredential.publicKey`) through the shared
 * usable-credential predicate. A `clientId` that does not resolve to an active
 * application is REJECTED — never silently stored as an unscoped token, because
 * an unscoped token is invisible to every capability-scoped delivery decision.
 *
 * The pre-existing unscoped registration (no `deviceId`, no `clientId`) must keep
 * working byte-for-byte: the email push registry predates the scoping.
 *
 * ## What changed with the harness, and why it matters
 *
 * The previous version mocked `models/PushToken`, `models/Application` and
 * `models/ApplicationCredential`, then asserted the SHAPE of the
 * `findOneAndUpdate` arguments. Two of the properties that shape was standing in
 * for could not actually be observed that way:
 *
 *  - **"Fields the caller did not send are left untouched."** With a stubbed
 *    model there is no stored row to leave untouched. Here a re-registration
 *    that omits `clientId` is checked against the row it did NOT clear.
 *  - **"An application id can never be forged from the body."** A stub records
 *    whatever it is handed; a real `push_tokens.application_id` carries a
 *    foreign key, and the value that ends up in it is read back out.
 *
 * The credential ids are also whatever `generatedId()` mints — a uuid v7 — so a
 * reinstated 24-hex guard anywhere on the resolution path fails these cases
 * instead of passing them vacuously.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

/** Identity the mocked bearer middleware resolves. */
const mockBearerUser = { current: '' };

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: mockBearerUser.current };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../controllers/notification.controller', () => ({
  getNotifications: jest.fn(),
  createNotification: jest.fn(),
  markAsRead: jest.fn(),
  markAllAsRead: jest.fn(),
  deleteNotification: jest.fn(),
  getUnreadCount: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import notificationsRouter from '../notifications.routes';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  method: 'POST' | 'DELETE',
  path: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;
let USER_ID: string;
let APP_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertApplication(
  fields: Partial<typeof applications.$inferInsert> = {},
): Promise<string> {
  const ownerAccountId = fields.ownerAccountId ?? (await insertUser());
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ...fields, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

/** A credential whose `publicKey` is the `clientId` a caller presents. */
async function insertCredential(
  applicationId: string,
  fields: Partial<typeof applicationCredentials.$inferInsert> = {},
): Promise<string> {
  const publicKey = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'app',
      type: 'public',
      environment: 'production',
      publicKey,
      ...fields,
    });
  return publicKey;
}

/** The stored install, or undefined — the only evidence a write is judged by. */
async function storedInstall(userId: string, token: string) {
  const [row] = await getDb()
    .select({
      userId: pushTokens.userId,
      token: pushTokens.token,
      platform: pushTokens.platform,
      deviceId: pushTokens.deviceId,
      applicationId: pushTokens.applicationId,
    })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)))
    .limit(1);
  return row;
}

async function installCount(userId: string): Promise<number> {
  return (
    await getDb().select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId))
  ).length;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/notifications', notificationsRouter);
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
  jest.clearAllMocks();
  USER_ID = await insertUser();
  mockBearerUser.current = USER_ID;
  APP_ID = await insertApplication();
});

describe('POST /notifications/push-token — application scope', () => {
  it('resolves clientId to its application and stores the scope', async () => {
    const clientId = await insertCredential(APP_ID);

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      deviceId: 'device-abc',
      clientId,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ registered: true });

    expect(await storedInstall(USER_ID, 'ExponentPushToken[vault]')).toEqual({
      userId: USER_ID,
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      deviceId: 'device-abc',
      applicationId: APP_ID,
    });
  });

  it('resolves an application whose id the deleted 24-hex guard would have rejected', async () => {
    // The premise the case above rests on: nothing here is an ObjectId, so a
    // reinstated `isValid` check anywhere on the resolution path fails rather
    // than passing vacuously.
    expect(APP_ID).not.toMatch(/^[0-9a-f]{24}$/i);
    expect(USER_ID).not.toMatch(/^[0-9a-f]{24}$/i);

    const clientId = await insertCredential(APP_ID);
    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });

    expect(res.status).toBe(200);
    expect((await storedInstall(USER_ID, 'ExponentPushToken[vault]')).applicationId).toBe(APP_ID);
  });

  it('rejects a clientId whose credential is revoked, storing nothing', async () => {
    const clientId = await insertCredential(APP_ID, { status: 'revoked' });

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'clientId does not resolve to an active application',
    });
    expect(await installCount(USER_ID)).toBe(0);
  });

  it('rejects a clientId whose rotation grace has elapsed', async () => {
    const clientId = await insertCredential(APP_ID, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });

    expect(res.status).toBe(400);
    expect(await installCount(USER_ID)).toBe(0);
  });

  it('ACCEPTS a deprecated clientId still inside its rotation grace', async () => {
    // The mirror of the case above — without it, "rejects when the grace
    // elapsed" would also pass if deprecation alone were fatal, which would
    // break every install during a 7-day credential rotation.
    const clientId = await insertCredential(APP_ID, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });

    expect(res.status).toBe(200);
    expect((await storedInstall(USER_ID, 'ExponentPushToken[vault]')).applicationId).toBe(APP_ID);
  });

  it('rejects an unknown clientId, storing nothing', async () => {
    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'android',
      clientId: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
    });

    expect(res.status).toBe(400);
    expect(await installCount(USER_ID)).toBe(0);
  });

  it('rejects a clientId whose application is no longer active', async () => {
    const suspended = await insertApplication({ status: 'suspended' });
    const clientId = await insertCredential(suspended);

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });

    expect(res.status).toBe(400);
    expect(await installCount(USER_ID)).toBe(0);
  });
});

describe('POST /notifications/push-token — re-registration', () => {
  it('upserts in place rather than creating a second row', async () => {
    const clientId = await insertCredential(APP_ID);
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      clientId,
    });
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'android',
      clientId,
    });

    expect(await installCount(USER_ID)).toBe(1);
    expect((await storedInstall(USER_ID, 'ExponentPushToken[vault]')).platform).toBe('android');
  });

  it('leaves a scope the caller did not resend UNTOUCHED', async () => {
    // The property Mongo's explicit `$set` of the whitelist gave and a stubbed
    // model could not show: re-registering without `clientId`/`deviceId` must
    // not retire an install from the capability-scoped delivery set.
    const clientId = await insertCredential(APP_ID);
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      deviceId: 'device-abc',
      clientId,
    });

    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
    });

    expect(await storedInstall(USER_ID, 'ExponentPushToken[vault]')).toEqual({
      userId: USER_ID,
      token: 'ExponentPushToken[vault]',
      platform: 'ios',
      deviceId: 'device-abc',
      applicationId: APP_ID,
    });
  });

  it('keeps two identities\' installs of the same token string apart', async () => {
    const otherUser = await insertUser();
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[shared]',
      platform: 'ios',
    });

    mockBearerUser.current = otherUser;
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[shared]',
      platform: 'web',
    });

    expect((await storedInstall(USER_ID, 'ExponentPushToken[shared]')).platform).toBe('ios');
    expect((await storedInstall(otherUser, 'ExponentPushToken[shared]')).platform).toBe('web');
  });
});

describe('POST /notifications/push-token — unscoped registration still works', () => {
  it('registers without deviceId/clientId exactly as before', async () => {
    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[email]',
      platform: 'web',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ registered: true });

    expect(await storedInstall(USER_ID, 'ExponentPushToken[email]')).toEqual({
      userId: USER_ID,
      token: 'ExponentPushToken[email]',
      platform: 'web',
      deviceId: null,
      applicationId: null,
    });
  });

  it('never writes an unwhitelisted field from the body', async () => {
    const forgedApp = await insertApplication();
    const victim = await insertUser();

    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[email]',
      platform: 'web',
      userId: victim,
      applicationId: forgedApp,
    });

    expect(res.status).toBe(200);
    // Both forged values name REAL rows, so a mass-assignment would have been
    // accepted by the foreign keys — the whitelist is what rejects it.
    expect(await storedInstall(USER_ID, 'ExponentPushToken[email]')).toEqual({
      userId: USER_ID,
      token: 'ExponentPushToken[email]',
      platform: 'web',
      deviceId: null,
      applicationId: null,
    });
    expect(await installCount(victim)).toBe(0);
  });

  it('trims the token, so one install cannot become two rows', async () => {
    // Mongoose declared `PushToken.token` with `trim: true`, which applied to
    // both the write and the filter it cast. Postgres has no counterpart, so the
    // normalization is re-applied at this call site — otherwise a trailing space
    // creates a SECOND row and `push_tokens_user_id_token_key`, which sees two
    // different strings, does not object.
    await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[email]',
      platform: 'web',
    });
    await request('POST', '/notifications/push-token', {
      token: '  ExponentPushToken[email]  ',
      platform: 'ios',
    });

    expect(await installCount(USER_ID)).toBe(1);
    expect((await storedInstall(USER_ID, 'ExponentPushToken[email]')).platform).toBe('ios');
  });

  it('rejects an unsupported platform', async () => {
    const res = await request('POST', '/notifications/push-token', {
      token: 'ExponentPushToken[email]',
      platform: 'blackberry',
    });

    expect(res.status).toBe(400);
    expect(await installCount(USER_ID)).toBe(0);
  });

  it('rejects a missing token', async () => {
    const res = await request('POST', '/notifications/push-token', { platform: 'ios' });

    expect(res.status).toBe(400);
    expect(await installCount(USER_ID)).toBe(0);
  });
});

describe('DELETE /notifications/push-token', () => {
  it("unregisters only the caller's own token", async () => {
    const otherUser = await insertUser();
    await getDb()
      .insert(pushTokens)
      .values([
        { userId: USER_ID, token: 'ExponentPushToken[vault]', platform: 'ios' },
        { userId: USER_ID, token: 'ExponentPushToken[other]', platform: 'ios' },
        { userId: otherUser, token: 'ExponentPushToken[vault]', platform: 'ios' },
      ]);

    const res = await request('DELETE', '/notifications/push-token', {
      token: 'ExponentPushToken[vault]',
      userId: otherUser,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ unregistered: true });
    // The caller's own row is gone; their other install and the other identity's
    // install of the SAME token string both survive.
    expect(await storedInstall(USER_ID, 'ExponentPushToken[vault]')).toBeUndefined();
    expect(await storedInstall(USER_ID, 'ExponentPushToken[other]')).toBeDefined();
    expect(await storedInstall(otherUser, 'ExponentPushToken[vault]')).toBeDefined();
  });

  it('succeeds for a token that was never registered', async () => {
    const res = await request('DELETE', '/notifications/push-token', {
      token: 'ExponentPushToken[never]',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ unregistered: true });
  });

  it('rejects a missing token', async () => {
    const res = await request('DELETE', '/notifications/push-token', {});

    expect(res.status).toBe(400);
  });
});
