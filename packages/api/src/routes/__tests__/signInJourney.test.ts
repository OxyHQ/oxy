/**
 * One person, end to end, through the real routers, the REAL bearer check,
 * the real session mint and a REAL Postgres — nothing between the HTTP call
 * and the database is stubbed except the mail (read at its boundary) and the
 * destructive side systems a deletion fans out to:
 *
 *   sign up with an email code → sign in with the emailed code → set a
 *   password → sign in with it → turn the authenticator on → signing in now
 *   needs its code → a backup code works once → link Commons (a real
 *   secp256k1 key signs the proof) and the email is gone → delete the account.
 *
 * A second person deletes their account with an email code.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

process.env.ACCESS_TOKEN_SECRET = 'journey-test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'journey-test-refresh-secret';
process.env.DEVICE_ID_SALT = 'journey-test-device-id-salt-0123456789abcdef';

const mockSendCode = jest.fn();
const mockSendSignIn = jest.fn();
const mockSendReauth = jest.fn();
const mockSendNotice = jest.fn();

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/accountEmail.mail', () => ({
  sendVerificationCode: (...args: unknown[]) => mockSendCode(...args),
  sendAccountExistsNotice: jest.fn(),
  sendSignInEmail: (...args: unknown[]) => mockSendSignIn(...args),
  sendReauthCode: (...args: unknown[]) => mockSendReauth(...args),
  sendSecurityNotice: (...args: unknown[]) => mockSendNotice(...args),
}));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => {
  const actual = jest.requireActual('../../services/user.service');
  actual.userService.purgeUserSocialGraph = jest.fn().mockResolvedValue(undefined);
  return actual;
});
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

import { signIdentityProof } from '@oxy.so/core';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import deviceSessionService from '../../services/deviceSession.service';
import SignatureService from '../../services/signature.service';
import { totpCodeAt } from '../../services/totp.service';
import accountEmailRouter from '../accountEmail';
import accountSecurityRouter from '../accountSecurity';
import identityLinkRouter from '../identityLink';
import signInRouter from '../signIn';
import usersRouter from '../users';

jest.setTimeout(60_000);

let server: http.Server;

async function call(method: string, path: string, body?: unknown, bearer?: string) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth/email', accountEmailRouter);
  app.use('/auth', signInRouter);
  app.use('/users/me', accountSecurityRouter);
  app.use('/identity/link', identityLinkRouter);
  app.use('/users', usersRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

beforeEach(() => {
  for (const mock of [mockSendCode, mockSendSignIn, mockSendReauth, mockSendNotice]) mock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

function lastCall(mock: jest.Mock, to: string): unknown[] {
  const calls = mock.mock.calls.filter(([address]) => address === to);
  const found = calls[calls.length - 1];
  if (!found) throw new Error(`nothing was sent to ${to}`);
  return found;
}

async function signUp(): Promise<{ email: string; username: string; token: string; userId: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `journey-${suffix}@example.test`;
  const username = `journey${suffix}`;
  const started = await call('POST', '/auth/email/verify/start', { purpose: 'signup', email });
  expect(started.status).toBe(200);
  const code = lastCall(mockSendCode, email)[1] as string;
  const confirmed = await call('POST', '/auth/email/verify/confirm', { verificationId: started.body.verificationId, code });
  expect(confirmed.status).toBe(200);
  const created = await call('POST', '/auth/signup', { username, email, emailTicket: confirmed.body.ticket });
  expect(created.status).toBe(200);
  return { email, username, token: created.body.accessToken as string, userId: (created.body.user as { id: string }).id };
}

async function reauthCode(token: string, email: string, action: string) {
  const res = await call('POST', '/users/me/reauth/email', { action }, token);
  expect(res.status).toBe(200);
  return { verificationId: res.body.verificationId as string, code: lastCall(mockSendReauth, email)[1] as string };
}

describe('one person, end to end', () => {
  it('signs up, signs in every way, secures the account, links Commons and leaves', async () => {
    // Sign up: a username, an email proven by its code.
    const person = await signUp();
    const me = await call('GET', '/users/me/sign-in-methods', undefined, person.token);
    expect(me.body).toEqual({ hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 });

    // Sign in with the emailed code.
    const started = await call('POST', '/auth/signin/email/start', { identifier: person.username });
    const { code } = lastCall(mockSendSignIn, person.email)[1] as { code: string };
    const byCode = await call('POST', '/auth/signin/email/confirm', {
      requestId: started.body.requestId,
      requestSecret: started.body.requestSecret,
      code,
    });
    expect(byCode.status).toBe(200);
    const token = byCode.body.accessToken as string;
    expect((await call('GET', '/users/me/sign-in-methods', undefined, token)).status).toBe(200);

    // Set a password with a fresh email code, then sign in with it.
    const password = 'journey password 1';
    const set = await call('PUT', '/users/me/password', { newPassword: password, reauth: { emailCode: await reauthCode(token, person.email, 'change_password') } }, token);
    expect(set.status).toBe(200);
    const byPassword = await call('POST', '/auth/signin/password', { identifier: person.email, password });
    expect(byPassword.status).toBe(200);
    expect(typeof byPassword.body.accessToken).toBe('string');

    // Turn the authenticator on.
    const enrolled = await call('POST', '/users/me/totp/enroll', undefined, token);
    const secret = enrolled.body.secret as string;
    const confirmed = await call(
      'POST',
      '/users/me/totp/confirm',
      { code: totpCodeAt(secret, new Date(Date.now() - 30_000)), reauth: { password } },
      token,
    );
    expect(confirmed.status).toBe(200);
    const backupCodes = confirmed.body.backupCodes as string[];

    // Signing in now stops at the authenticator.
    // (In another browser: its own device, proven, so it is its own session.)
    const browser = await deviceSessionService.registerDevice();
    const challenged = await call('POST', '/auth/signin/password', { identifier: person.username, password, device: browser });
    expect(challenged.body).toMatchObject({ secondFactorRequired: true });
    expect(challenged.body.accessToken).toBeUndefined();
    const withTotp = await call('POST', '/auth/signin/second-factor', {
      challengeId: challenged.body.challengeId,
      code: totpCodeAt(secret, new Date()),
      device: browser,
    });
    expect(withTotp.status).toBe(200);
    expect(withTotp.body.deviceId).toBe(browser.deviceId);
    const current = withTotp.body.accessToken as string;

    // A backup code works once.
    const first = await call('POST', '/auth/signin/password', { identifier: person.username, password });
    expect((await call('POST', '/auth/signin/second-factor', { challengeId: first.body.challengeId, code: backupCodes[0] })).status).toBe(200);
    const second = await call('POST', '/auth/signin/password', { identifier: person.username, password });
    expect((await call('POST', '/auth/signin/second-factor', { challengeId: second.body.challengeId, code: backupCodes[0] })).status).toBe(401);

    // Link Commons: a real key signs the root proof; the email code and the
    // authenticator confirm it; the email is gone.
    const opened = await call('POST', '/identity/link', undefined, current);
    expect(opened.status).toBe(200);
    const linkId = opened.body.linkId as string;
    const state = (await call('GET', `/identity/link/${linkId}`)).body as { userId: string; audience: string; expiresAt: number };
    const pair = generateSecp256k1KeyPair();
    const key = { privateKey: pair.privateKey, publicKey: pair.publicKey.toLowerCase() };
    const proof = await signIdentityProof(key, {
      action: 'link_identity',
      subject: state.userId,
      actor: state.userId,
      rootPublicKey: key.publicKey,
      payloadDigest: null,
      expectedRevision: null,
      audience: state.audience,
      challenge: opened.body.challenge as string,
      expiresAt: state.expiresAt,
    });
    expect((await call('POST', `/identity/link/${linkId}/proof`, { publicKey: key.publicKey, proof })).status).toBe(200);
    const linkCode = await reauthCode(current, person.email, 'link_commons');
    const linked = await call(
      'POST',
      `/identity/link/${linkId}/complete`,
      { reauth: { emailCode: linkCode, totpCode: totpCodeAt(secret, new Date(Date.now() + 30_000)) } },
      current,
    );
    expect(linked.status).toBe(200);
    const [after] = await getDb().select({ email: users.email, publicKey: users.publicKey }).from(users).where(eq(users.id, person.userId));
    expect(after).toEqual({ email: null, publicKey: key.publicKey });
    expect(mockSendNotice).toHaveBeenCalledWith(person.email, 'commons_linked', person.username);
    // The other sessions were signed out; the one that linked stays.
    expect((await call('GET', '/users/me/sign-in-methods', undefined, token)).status).toBe(401);
    expect((await call('GET', '/users/me/sign-in-methods', undefined, current)).body).toMatchObject({ hasEmail: false });

    // Neither does the password: linking removed it (and the authenticator).
    const afterLink = await call('POST', '/auth/signin/password', { identifier: person.username, password });
    expect(afterLink.status).toBe(401);
    expect(afterLink.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');

    // The address no longer signs anyone in.
    mockSendSignIn.mockClear();
    expect((await call('POST', '/auth/signin/email/start', { identifier: person.email })).status).toBe(200);
    expect(mockSendSignIn).not.toHaveBeenCalled();

    // Leave, signed with the Commons key.
    const timestamp = Date.now();
    const signature = SignatureService.signMessage(`delete:${key.publicKey}:${timestamp}`, key.privateKey);
    const deleted = await call('DELETE', '/users/me', { confirmText: person.username, signature, timestamp }, current);
    expect(deleted.status).toBe(200);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, person.userId))).toHaveLength(0);
  });

  it('deletes an account without a key with an email code', async () => {
    const person = await signUp();
    const refused = await call('DELETE', '/users/me', { confirmText: person.username }, person.token);
    expect(refused.status).toBe(400);
    const wrong = await reauthCode(person.token, person.email, 'delete_account');
    const bad = await call(
      'DELETE',
      '/users/me',
      { confirmText: person.username, reauth: { emailCode: { ...wrong, code: wrong.code === '000000' ? '111111' : '000000' } } },
      person.token,
    );
    expect(bad.status).toBe(401);

    const deleted = await call('DELETE', '/users/me', { confirmText: person.username, reauth: { emailCode: wrong } }, person.token);
    expect(deleted.status).toBe(200);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, person.userId))).toHaveLength(0);
  });
});
