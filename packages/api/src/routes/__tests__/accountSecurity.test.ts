/**
 * The signed-in account's password and authenticator (`/users/me/*`), through
 * the real router, the real re-verification, password and TOTP services and a
 * REAL Postgres. The bearer is stubbed (who is signed in, and through which
 * application); the mail is mocked at its boundary so the test reads the codes
 * and notices that would be sent.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

process.env.ACCESS_TOKEN_SECRET = 'account-security-test-access';
process.env.REFRESH_TOKEN_SECRET = 'account-security-test-refresh';
process.env.DEVICE_ID_SALT = 'account-security-test-device-id-salt-0123456789';

let currentUserId = '';
let currentSessionId: string | undefined;
let currentApplicationId: string | undefined;
const mockSendReauthCode = jest.fn();
const mockSendSecurityNotice = jest.fn();

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { id: string }; sessionId?: string; oxyToken?: { applicationId?: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { id: currentUserId };
    req.sessionId = currentSessionId;
    if (currentApplicationId) req.oxyToken = { applicationId: currentApplicationId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/accountEmail.mail', () => ({
  sendReauthCode: (...args: unknown[]) => mockSendReauthCode(...args),
  sendSecurityNotice: (...args: unknown[]) => mockSendSecurityNotice(...args),
}));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { userPasswords } from '../../db/schema/userPasswords';
import { userTotp, userTotpBackupCodes } from '../../db/schema/userTotp';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { _resetInMemoryStateForTests } from '../../services/loginLockout.service';
import { verifyPassword } from '../../services/password.service';
import sessionService from '../../services/session.service';
import { totpCodeAt } from '../../services/totp.service';
import accountSecurityRouter from '../accountSecurity';

let server: http.Server;

async function call(method: string, path: string, body?: unknown, origin: string | null = 'http://localhost:8081') {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/users/me${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown>, raw: text };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users/me', accountSecurityRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetInMemoryStateForTests();
  currentSessionId = undefined;
  currentApplicationId = undefined;
  mockSendReauthCode.mockResolvedValue(undefined);
  mockSendSecurityNotice.mockResolvedValue(undefined);
});

async function signedIn() {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `sec-${id}@example.test`;
  const [row] = await getDb().insert(users).values({ username: `sec${id}`, email }).returning({ id: users.id, username: users.username });
  currentUserId = row.id;
  return { id: row.id, username: row.username as string, email };
}

async function emailCode(action = 'change_password') {
  mockSendReauthCode.mockClear();
  const res = await call('POST', '/reauth/email', { action });
  expect(res.status).toBe(200);
  const code = mockSendReauthCode.mock.calls[0][1] as string;
  return { verificationId: res.body.verificationId as string, code };
}

async function setPassword(password: string, reauth: unknown) {
  return call('PUT', '/password', { newPassword: password, reauth });
}

describe('re-verification by email', () => {
  it("sends a code to the account's own email", async () => {
    const me = await signedIn();
    await emailCode();
    expect(mockSendReauthCode).toHaveBeenCalledWith(me.email, expect.stringMatching(/^\d{6}$/), me.username, 'change_password');
  });

  it('binds the code to the one change it was asked for', async () => {
    await signedIn();
    expect((await call('POST', '/reauth/email', {})).status).toBe(400);
    const forDeletion = await emailCode('delete_account');
    const refused = await setPassword('a long password', { emailCode: forDeletion });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('EMAIL_CODE_INVALID');
    expect((await setPassword('a long password', { emailCode: await emailCode('change_password') })).status).toBe(200);
  });

  it('refuses an account without an email', async () => {
    const [row] = await getDb().insert(users).values({ username: `noemail${randomUUID().slice(0, 8)}` }).returning({ id: users.id });
    currentUserId = row.id;
    expect((await call('POST', '/reauth/email', { action: 'change_password' })).status).toBe(400);
  });
});

describe('the password', () => {
  it('is set with a fresh email code, changed with the current password, and each change is told', async () => {
    const me = await signedIn();
    expect((await call('GET', '/sign-in-methods')).body).toEqual({ hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 });

    const set = await setPassword('first password 1', { emailCode: await emailCode() });
    expect(set).toMatchObject({ status: 200, body: { success: true } });
    expect(mockSendSecurityNotice).toHaveBeenLastCalledWith(me.email, 'password_set', me.username);
    expect((await call('GET', '/sign-in-methods')).body.hasPassword).toBe(true);

    const changed = await setPassword('second password 2', { password: 'first password 1' });
    expect(changed.status).toBe(200);
    expect(mockSendSecurityNotice).toHaveBeenLastCalledWith(me.email, 'password_changed', me.username);
    const [row] = await getDb().select({ passwordHash: userPasswords.passwordHash }).from(userPasswords).where(eq(userPasswords.userId, me.id));
    expect(await verifyPassword('second password 2', row.passwordHash)).toBe(true);
  });

  it('refuses without a proof, with a wrong or reused code, and with a wrong password', async () => {
    await signedIn();
    expect((await call('PUT', '/password', { newPassword: 'a long password' })).status).toBe(400);
    const code = await emailCode();
    const wrong = code.code === '000000' ? '111111' : '000000';
    const refused = await setPassword('a long password', { emailCode: { ...code, code: wrong } });
    expect(refused.status).toBe(401);
    expect((await setPassword('a long password', { emailCode: code })).status).toBe(200);
    expect((await setPassword('another password', { emailCode: code })).status).toBe(401);
    const badPassword = await setPassword('another password', { password: 'not the password' });
    expect(badPassword.status).toBe(401);
    expect(badPassword.body.error).toBe('REAUTH_INVALID');
  });

  it('refuses a short password', async () => {
    await signedIn();
    expect((await setPassword('short', { emailCode: await emailCode() })).status).toBe(400);
  });

  it('counts parallel wrong passwords atomically: 50 at once, at most five are checked', async () => {
    await signedIn();
    await setPassword('right password 1', { emailCode: await emailCode() });
    const answers = await Promise.all(
      Array.from({ length: 50 }, () => setPassword('new password 22', { password: 'wrong password' })),
    );
    const checked = answers.filter((answer) => answer.status === 401).length;
    expect(checked).toBeLessThanOrEqual(5);
    expect(answers.filter((answer) => answer.status === 429).length).toBeGreaterThanOrEqual(45);
  });

  it('locks the password proof after five wrong tries (the sixth is refused unchecked)', async () => {
    await signedIn();
    await setPassword('right password 1', { emailCode: await emailCode() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await setPassword('new password 22', { password: 'wrong password' })).status).toBe(401);
    }
    const sixth = await setPassword('new password 22', { password: 'wrong password' });
    expect(sixth.status).toBe(429);
    expect((await setPassword('new password 22', { password: 'right password 1' })).status).toBe(429);
  });

  it('signs every other session out when asked', async () => {
    const me = await signedIn();
    const fakeReq = { headers: {}, ip: '127.0.0.1', get: () => undefined } as never;
    const mine = await sessionService.createSession(me.id, fakeReq, {});
    const other = await sessionService.createSession(me.id, fakeReq, {});
    currentSessionId = mine.sessionId;
    const res = await call('PUT', '/password', { newPassword: 'fresh password 1', reauth: { emailCode: await emailCode() }, revokeOtherSessions: true });
    expect(res.status).toBe(200);
    const rows = await getDb().select({ sessionId: sessions.sessionId, isActive: sessions.isActive }).from(sessions).where(eq(sessions.userId, me.id));
    expect(rows.find((row) => row.sessionId === mine.sessionId)?.isActive).toBe(true);
    expect(rows.find((row) => row.sessionId === other.sessionId)?.isActive).toBe(false);
  });
});

describe('the authenticator', () => {
  async function turnOn(password = 'my password 123') {
    await setPassword(password, { emailCode: await emailCode() });
    const enrolled = await call('POST', '/totp/enroll');
    expect(enrolled.status).toBe(200);
    const secret = enrolled.body.secret as string;
    expect(enrolled.body.otpauthUri).toMatch(new RegExp(`^otpauth://totp/Oxy%3A.+\\?secret=${secret}&issuer=Oxy&algorithm=SHA1&digits=6&period=30$`));
    const confirmed = await call('POST', '/totp/confirm', { code: totpCodeAt(secret, new Date(Date.now() - 30_000)), reauth: { password } });
    expect(confirmed.status).toBe(200);
    return { secret, backupCodes: confirmed.body.backupCodes as string[], password };
  }

  it('turns on with a first code and a fresh proof, stores the secret sealed, and hands out ten backup codes once', async () => {
    const me = await signedIn();
    const { secret, backupCodes } = await turnOn();
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    expect(mockSendSecurityNotice).toHaveBeenLastCalledWith(me.email, 'totp_enabled', me.username);

    const [row] = await getDb().select().from(userTotp).where(eq(userTotp.userId, me.id));
    expect(row.enabledAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row)).not.toContain(secret);
    const codes = await getDb().select().from(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, me.id));
    expect(JSON.stringify(codes)).not.toContain(backupCodes[0]);
    expect((await call('GET', '/sign-in-methods')).body).toMatchObject({ totpEnabled: true, backupCodesRemaining: 10 });
    // Already on: no second enrolment, and nothing shows the secret again.
    expect((await call('POST', '/totp/enroll')).status).toBe(409);
  });

  it('refuses a wrong first code', async () => {
    await signedIn();
    await setPassword('my password 123', { emailCode: await emailCode() });
    const enrolled = await call('POST', '/totp/enroll');
    const code = totpCodeAt(enrolled.body.secret as string, new Date());
    const res = await call('POST', '/totp/confirm', { code: code === '000000' ? '111111' : '000000', reauth: { password: 'my password 123' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TOTP_CODE_INVALID');
  });

  it('once on, every change also needs its code', async () => {
    await signedIn();
    const { secret, password } = await turnOn();
    const noCode = await setPassword('another password 9', { password });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error).toBe('TOTP_REQUIRED');
    const withCode = await setPassword('another password 9', { password, totpCode: totpCodeAt(secret, new Date()) });
    expect(withCode.status).toBe(200);
  });

  it('regenerates backup codes (the old set dies) and turns off, signing other sessions out', async () => {
    const me = await signedIn();
    const { secret, backupCodes, password } = await turnOn();
    const regenerated = await call('POST', '/totp/backup-codes', { reauth: { password, totpCode: backupCodes[0] } });
    expect(regenerated.status).toBe(200);
    const fresh = regenerated.body.backupCodes as string[];
    expect(fresh).not.toContain(backupCodes[1]);
    // The old set is gone.
    expect((await call('POST', '/totp/disable', { reauth: { password, totpCode: backupCodes[1] } })).status).toBe(401);

    const fakeReq = { headers: {}, ip: '127.0.0.1', get: () => undefined } as never;
    const other = await sessionService.createSession(me.id, fakeReq, {});
    const off = await call('POST', '/totp/disable', { reauth: { password, totpCode: totpCodeAt(secret, new Date(Date.now() + 30_000)) } });
    expect(off.status).toBe(200);
    expect(mockSendSecurityNotice).toHaveBeenLastCalledWith(me.email, 'totp_disabled', me.username);
    expect(await getDb().select().from(userTotp).where(eq(userTotp.userId, me.id))).toHaveLength(0);
    expect(await getDb().select().from(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, me.id))).toHaveLength(0);
    const [row] = await getDb().select({ isActive: sessions.isActive }).from(sessions).where(and(eq(sessions.sessionId, other.sessionId)));
    expect(row.isActive).toBe(false);
  });
});

describe('an account with a Commons key', () => {
  it('cannot add a password or an authenticator: it signs in with Commons', async () => {
    const me = await signedIn();
    await getDb().update(users).set({ publicKey: `04${'b'.repeat(128)}` }).where(eq(users.id, me.id));
    expect((await call('POST', '/totp/enroll')).status).toBe(403);
    expect((await setPassword('a long password', { emailCode: await emailCode() })).status).toBe(403);
    expect(await getDb().select().from(userPasswords).where(eq(userPasswords.userId, me.id))).toHaveLength(0);
  });
});

describe('who may call', () => {
  it('refuses a third-party site and a third-party bearer', async () => {
    await signedIn();
    expect((await call('GET', '/sign-in-methods', undefined, 'https://third-party.example')).status).toBe(403);

    const [app] = await getDb()
      .insert(applications)
      .values({ name: 'Third party', type: 'third_party', ownerAccountId: currentUserId, createdByUserId: currentUserId })
      .returning({ id: applications.id });
    currentApplicationId = app.id;
    const res = await call('POST', '/reauth/email', { action: 'delete_account' });
    expect(res.status).toBe(403);
    expect(mockSendReauthCode).not.toHaveBeenCalled();
  });

  it('refuses a managed (non-personal) account', async () => {
    const [bot] = await getDb().insert(users).values({ username: `bot${randomUUID().slice(0, 8)}`, kind: 'bot', email: `bot-${randomUUID()}@example.test` }).returning({ id: users.id });
    currentUserId = bot.id;
    expect((await call('POST', '/totp/enroll')).status).toBe(403);
  });
});
