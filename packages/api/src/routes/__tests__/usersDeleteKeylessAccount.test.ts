/**
 * Deleting an account (security review of #1421), through the real router, the
 * real re-verification and a REAL Postgres:
 *
 * - an account without a key confirms with a code just sent to its email FOR
 *   THIS DELETION, plus its authenticator code when it has one;
 * - a passkey assertion no longer deletes anything (a stolen bearer could have
 *   planted the passkey);
 * - a key account signs with its key, plus its authenticator code if any;
 * - a third-party application's token never deletes an account.
 *
 * Stubbed, as in `usersDeleteAccountEvent.test.ts`: the session, the
 * destructive side systems and caches; the mail is read at its boundary.
 */

process.env.DEVICE_ID_SALT = 'users-delete-test-device-id-salt-0123456789ab';

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

let currentUserId: string | undefined;
let currentApplicationId: string | undefined;
let currentServiceAppId: string | undefined;
const mockSendReauthCode = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string }; oxyToken?: { applicationId?: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    if (currentApplicationId) req.oxyToken = { applicationId: currentApplicationId };
    next();
  },
  serviceAuthMiddleware: (req: { serviceApp?: { appId: string } }, _res: unknown, next: () => void) => {
    if (currentServiceAppId) req.serviceApp = { appId: currentServiceAppId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/accountEmail.mail', () => ({
  sendReauthCode: (...args: unknown[]) => mockSendReauthCode(...args),
}));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    verifySignature: () => true,
    isTimestampFresh: () => true,
  },
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { purgeAccountFromAllDevices: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => ({
  userService: { purgeUserSocialGraph: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import { errorHandler } from '../../middleware/errorHandler';
import { startReauthEmail } from '../../services/reauth.service';
import { _resetInMemoryStateForTests } from '../../services/loginLockout.service';
import { confirmTotp, enrollTotp, totpCodeAt } from '../../services/totp.service';
import usersRouter from '../users';

jest.setTimeout(60_000);

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  currentApplicationId = undefined;
  mockSendReauthCode.mockReset().mockResolvedValue(undefined);
  _resetInMemoryStateForTests();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A route that no longer exists answers Express's HTML 404.
  }
  return { status: response.status, body: parsed };
}

async function person(extra: { publicKey?: string } = {}) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `leaving${suffix}`, email: `leaving-${suffix}@example.test`, ...extra })
    .returning({ id: users.id, username: users.username });
  currentUserId = row.id;
  return { id: row.id, username: row.username as string };
}

async function emailCode(userId: string, action: 'delete_account' | 'change_password' = 'delete_account') {
  const { verificationId } = await startReauthEmail(userId, action);
  const code = mockSendReauthCode.mock.calls[mockSendReauthCode.mock.calls.length - 1][1] as string;
  return { verificationId, code };
}

async function accountExists(id: string): Promise<boolean> {
  return (await getDb().select({ id: users.id }).from(users).where(eq(users.id, id))).length > 0;
}

describe('deleting an account without a key', () => {
  it('deletes with a code sent to its email for this deletion', async () => {
    const me = await person();
    const res = await call('DELETE', '/users/me', { confirmText: me.username, reauth: { emailCode: await emailCode(me.id) } });
    expect(res.status).toBe(200);
    expect(await accountExists(me.id)).toBe(false);
  });

  it('refuses a passkey assertion — even from an account that has a passkey', async () => {
    const me = await person();
    await getDb().insert(webauthnCredentials).values({
      userId: me.id,
      credentialID: `cred${randomUUID().replace(/-/g, '')}`,
      credentialPublicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      userVerified: true,
      name: 'Planted',
    });
    const assertion = { id: 'c'.repeat(20), rawId: 'c', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } };
    const res = await call('DELETE', '/users/me', { confirmText: me.username, assertion });
    expect(res.status).toBe(400);
    expect(await accountExists(me.id)).toBe(true);
    expect((await call('POST', '/users/me/delete/options')).status).toBe(404);
  });

  it('refuses a code asked for another change, and a wrong code', async () => {
    const me = await person();
    const other = await emailCode(me.id, 'change_password');
    expect((await call('DELETE', '/users/me', { confirmText: me.username, reauth: { emailCode: other } })).status).toBe(401);
    const right = await emailCode(me.id);
    const wrong = { ...right, code: right.code === '000000' ? '111111' : '000000' };
    expect((await call('DELETE', '/users/me', { confirmText: me.username, reauth: { emailCode: wrong } })).status).toBe(401);
    expect(await accountExists(me.id)).toBe(true);
  });

  it('asks for the authenticator code too when the account has one', async () => {
    const me = await person();
    const { secret } = await enrollTotp(me.id, 'x');
    await confirmTotp(me.id, totpCodeAt(secret, new Date(Date.now() - 30_000)));
    const without = await call('DELETE', '/users/me', { confirmText: me.username, reauth: { emailCode: await emailCode(me.id) } });
    expect(without.status).toBe(401);
    expect(without.body.error).toBe('TOTP_REQUIRED');
    const done = await call('DELETE', '/users/me', {
      confirmText: me.username,
      reauth: { emailCode: await emailCode(me.id), totpCode: totpCodeAt(secret, new Date()) },
    });
    expect(done.status).toBe(200);
  });

  it('checks the confirmation text first', async () => {
    const me = await person();
    const res = await call('DELETE', '/users/me', { confirmText: 'someone-else', reauth: { emailCode: await emailCode(me.id) } });
    expect(res.status).toBe(400);
    expect(await accountExists(me.id)).toBe(true);
  });
});

describe('deleting an account with a key', () => {
  it('asks for the authenticator code on top of the key signature when there is one', async () => {
    const me = await person({ publicKey: `04${'d'.repeat(128)}` });
    const { secret } = await enrollTotp(me.id, 'x');
    await confirmTotp(me.id, totpCodeAt(secret, new Date(Date.now() - 30_000)));
    const body = { confirmText: me.username, signature: 'ab', timestamp: Date.now() };
    const without = await call('DELETE', '/users/me', body);
    expect(without.status).toBe(401);
    expect(without.body.error).toBe('TOTP_REQUIRED');
    expect((await call('DELETE', '/users/me', { ...body, totpCode: totpCodeAt(secret, new Date()) })).status).toBe(200);
  });
});

describe('a third-party token', () => {
  it('never deletes the account, whatever it carries', async () => {
    const me = await person();
    const [app] = await getDb()
      .insert(applications)
      .values({ name: 'Third party', type: 'third_party', ownerAccountId: me.id, createdByUserId: me.id })
      .returning({ id: applications.id });
    currentApplicationId = app.id;
    const res = await call('DELETE', '/users/me', { confirmText: me.username, reauth: { emailCode: await emailCode(me.id) } });
    expect(res.status).toBe(403);
    expect(await accountExists(me.id)).toBe(true);
  });
});
