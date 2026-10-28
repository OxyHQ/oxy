import { accountAcquisition } from '../../db/schema/accountAcquisition';
/**
 * Signing in — `POST /auth/signin/*` and `POST /auth/signup`
 * — through the real router, the real services, the real session mint and the
 * real browser-device lookup, against a REAL Postgres.
 *
 * Only the mail is mocked, at its boundary, so the test reads exactly what
 * would be sent (the code, the link's token) and to whom. Every attack the
 * plan names is here: an unknown account answered like a known one, wrong
 * codes until the cap, a code or link used twice, a link opened in another
 * browser, the authenticator skipped, a locked password, a third-party
 * origin, and secrets in responses or logs.
 */

import express from 'express';
import type http from 'http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { EMAIL_ACCOUNTS_MAX, EMAIL_SIGNIN_CHOICE_TTL_MS } from '@oxy.so/contracts';

process.env.ACCESS_TOKEN_SECRET = 'signin-test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'signin-test-refresh-secret';
process.env.DEVICE_ID_SALT = 'signin-test-device-id-salt-0123456789abcdef';

const mockSendSignIn = jest.fn();
const mockSendCode = jest.fn();

jest.mock('../../services/accountEmail.mail', () => ({
  sendSignInEmail: (...args: unknown[]) => mockSendSignIn(...args),
  sendVerificationCode: (...args: unknown[]) => mockSendCode(...args),
  sendReauthCode: jest.fn(),
  sendSecurityNotice: jest.fn(),
}));
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  resetOriginRegistryForTests,
  setOriginSnapshotForTests,
} from '../../config/dynamicOriginRegistry';
import { emailSignInRequests } from '../../db/schema/emailSignInRequests';
import { emailVerifications } from '../../db/schema/emailVerifications';
import { sessions } from '../../db/schema/sessions';
import { signInSecondFactorChallenges } from '../../db/schema/signInChallenges';
import { userPasswords } from '../../db/schema/userPasswords';
import { userTotp } from '../../db/schema/userTotp';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import deviceSessionService from '../../services/deviceSession.service';
import { _resetInMemoryStateForTests } from '../../services/loginLockout.service';
import { storePassword } from '../../services/password.service';
import {
  confirmTotp,
  enrollTotp,
  totpCodeAt,
  verifySecondFactor,
} from '../../services/totp.service';
import {
  SIGNIN_CODE_FAILURES_PER_DAY,
  chooseEmailSignInAccount,
  confirmEmailSignIn,
  startEmailSignIn,
} from '../../services/emailSignIn.service';
import { EMAIL_SENDS_PER_HOUR } from '../../services/accountEmail.service';
import { logger } from '../../utils/logger';
import signInRouter from '../signIn';
import { awayFromTotpStepEdge } from '../../../test-support/totpStep';

const AUTH_ORIGIN = 'https://auth.oxy.so';
const APP_ORIGIN = 'https://mention.earth';

let server: http.Server;

async function post(
  path: string,
  body: unknown,
  origin: string | null = APP_ORIGIN,
  clientIp?: string,
) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      // The app trusts the proxy header here, so a test can speak from two IPs.
      ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    raw: text,
  };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/auth', signInRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetInMemoryStateForTests();
  setOriginSnapshotForTests([APP_ORIGIN], ['https://third-party.example']);
  mockSendSignIn.mockResolvedValue(undefined);
  mockSendCode.mockResolvedValue(undefined);
});

afterEach(() => resetOriginRegistryForTests());

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** A personal account with an email and nothing else. */
async function account(
  options: { email?: string | null; publicKey?: string; kind?: 'personal' | 'bot' } = {},
) {
  const id = suffix();
  const email = options.email === undefined ? `si-${id}@example.test` : options.email;
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `si${id}`,
      email,
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    })
    .returning({ id: users.id, username: users.username });
  return { id: row.id, username: row.username as string, email };
}

/** The browser's shared device, and a second holder credential for it (the app's). */
async function browserDevice() {
  const auth = await deviceSessionService.registerDevice();
  const appSecret = await deviceSessionService.issueDeviceSecret(auth.deviceId);
  if (!appSecret) throw new Error('no app credential');
  return { auth, app: { deviceId: auth.deviceId, deviceSecret: appSecret } };
}

function mailFor(to: string): { code: string; linkToken: string; username: string | null } {
  const call = mockSendSignIn.mock.calls.find(([address]) => address === to);
  if (!call) throw new Error(`no sign-in email to ${to}`);
  return call[1] as { code: string; linkToken: string; username: string | null };
}

async function sessionCount(userId: string): Promise<number> {
  return (
    await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  ).length;
}

async function start(identifier: string, device?: { deviceId: string; deviceSecret: string }) {
  const res = await post('/signin/email/start', { identifier, ...(device ? { device } : {}) });
  expect(res.status).toBe(200);
  return res.body as { requestId: string; requestSecret: string; expiresAt: number };
}

async function enableTotp(userId: string) {
  const { secret } = await enrollTotp(userId, 'label');
  const codes = await confirmTotp(userId, totpCodeAt(secret, new Date(Date.now() - 30_000)));
  return { secret, backupCodes: codes };
}

describe('email sign-in — start', () => {
  it('answers every identifier the same way, and mails only an account that can sign in', async () => {
    const real = await account();
    const commons = await account({ publicKey: `04${'a'.repeat(128)}` });
    const managed = await account({ kind: 'bot' });
    const noEmail = await account({ email: null });

    const answers = [];
    for (const identifier of [
      real.username,
      real.email as string,
      'nobody-here',
      'nobody@example.test',
      commons.username,
      managed.username,
      noEmail.username,
    ]) {
      const res = await post('/signin/email/start', { identifier });
      expect(res.status).toBe(200);
      answers.push(res.body);
    }
    for (const body of answers) {
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'requestId', 'requestSecret']);
    }
    // Two real sends (by username and by email), nothing for anyone else.
    expect(mockSendSignIn).toHaveBeenCalledTimes(2);
    expect(mockSendSignIn.mock.calls.every(([to]) => to === real.email)).toBe(true);
    expect(mailFor(real.email as string).username).toBe(real.username);
  });

  it('stores neither the address, the code, the secret nor the link token', async () => {
    const real = await account();
    const { requestId, requestSecret } = await start(real.username);
    const mail = mailFor(real.email as string);
    const [request] = await getDb()
      .select()
      .from(emailSignInRequests)
      .where(eq(emailSignInRequests.id, requestId));
    const [verification] = await getDb()
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, request.verificationId));
    const stored = JSON.stringify([request, verification]);
    for (const secret of [real.email as string, mail.code, requestSecret, mail.linkToken]) {
      expect(stored).not.toContain(secret);
    }
    expect(request.requestSecretHash).toBe(
      createHash('sha256').update(requestSecret).digest('hex'),
    );
  });
});

describe('email sign-in — the code is its own', () => {
  it('cannot be turned into a sign-up ticket', async () => {
    const { confirmEmailVerification } = await import('../../services/accountEmail.service');
    const real = await account();
    const { requestId, requestSecret } = await start(real.username);
    const { code } = mailFor(real.email as string);
    const [request] = await getDb()
      .select({ verificationId: emailSignInRequests.verificationId })
      .from(emailSignInRequests)
      .where(eq(emailSignInRequests.id, requestId));
    await expect(confirmEmailVerification(request.verificationId, code)).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
    // Untouched: it still signs in.
    expect((await post('/signin/email/confirm', { requestId, requestSecret, code })).status).toBe(
      200,
    );
  });
});

describe('email sign-in — the code', () => {
  it('signs in with the code, on the device the dialog proves, and never twice', async () => {
    const real = await account();
    const { app } = await browserDevice();
    const { requestId, requestSecret } = await start(real.username, app);
    const { code } = mailFor(real.email as string);

    const res = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code,
      device: app,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deviceId: app.deviceId,
      user: { id: real.id, username: real.username },
    });
    expect(typeof res.body.sessionId).toBe('string');
    expect(typeof res.body.deviceSecret).toBe('string');
    expect(await sessionCount(real.id)).toBe(1);

    const again = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code,
      device: app,
    });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('SIGNIN_REQUEST_INVALID');
    expect(await sessionCount(real.id)).toBe(1);
  });

  it('counts wrong codes and stops at five, even for the right code afterwards', async () => {
    const real = await account();
    const { requestId, requestSecret } = await start(real.username);
    const { code } = mailFor(real.email as string);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await post('/signin/email/confirm', { requestId, requestSecret, code: wrong });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('EMAIL_CODE_INVALID');
    }
    const fifth = await post('/signin/email/confirm', { requestId, requestSecret, code: wrong });
    expect(fifth.status).toBe(429);
    const late = await post('/signin/email/confirm', { requestId, requestSecret, code });
    expect(late.status).toBe(429);
    expect(await sessionCount(real.id)).toBe(0);
  });

  it('refuses the right code without the request secret, and does not spend it', async () => {
    const real = await account();
    const { requestId, requestSecret } = await start(real.username);
    const { code } = mailFor(real.email as string);

    const stolen = await post('/signin/email/confirm', {
      requestId,
      requestSecret: 'A'.repeat(43),
      code,
    });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error).toBe('SIGNIN_REQUEST_INVALID');
    expect((await post('/signin/email/confirm', { requestId, requestSecret, code })).status).toBe(
      200,
    );
  });

  it('refuses an expired code', async () => {
    const real = await account();
    const { requestId, requestSecret } = await start(real.username);
    const { code } = mailFor(real.email as string);
    const [request] = await getDb()
      .select({ verificationId: emailSignInRequests.verificationId })
      .from(emailSignInRequests)
      .where(eq(emailSignInRequests.id, requestId));
    await getDb()
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, request.verificationId));
    expect((await post('/signin/email/confirm', { requestId, requestSecret, code })).status).toBe(
      401,
    );
  });

  it('never signs a decoy in, whatever code is tried', async () => {
    const { requestId, requestSecret } = await start(`ghost-${suffix()}`);
    for (const code of ['000000', '123456', '999999']) {
      const res = await post('/signin/email/confirm', { requestId, requestSecret, code });
      expect(res.status).toBe(401);
    }
  });
});

describe('email sign-in — the link', () => {
  it('approves in the same browser; only the dialog with the secret collects the session', async () => {
    const real = await account();
    const { auth, app } = await browserDevice();
    const { requestId, requestSecret } = await start(real.username, app);
    const { linkToken } = mailFor(real.email as string);

    const pending = await post('/signin/email/collect', { requestId, requestSecret, device: app });
    expect(pending.body).toMatchObject({ status: 'pending' });

    const approved = await post(
      '/signin/email/link',
      { token: linkToken, device: auth },
      AUTH_ORIGIN,
    );
    expect(approved).toMatchObject({ status: 200, body: { approved: true } });
    // The page that opened the link receives no session of any kind.
    expect(Object.keys(approved.body)).toEqual(['approved']);
    expect(await sessionCount(real.id)).toBe(0);

    // A caller without the request secret learns nothing and takes nothing.
    expect(
      (
        await post('/signin/email/collect', {
          requestId,
          requestSecret: 'B'.repeat(43),
          device: app,
        })
      ).status,
    ).toBe(401);

    const collected = await post('/signin/email/collect', {
      requestId,
      requestSecret,
      device: app,
    });
    expect(collected.status).toBe(200);
    expect(collected.body).toMatchObject({ deviceId: app.deviceId, user: { id: real.id } });
    expect(await sessionCount(real.id)).toBe(1);

    // Spent: the link, the collection and the code are all dead now.
    expect(
      (await post('/signin/email/link', { token: linkToken, device: auth }, AUTH_ORIGIN)).status,
    ).toBe(401);
    expect(
      (await post('/signin/email/collect', { requestId, requestSecret, device: app })).status,
    ).toBe(401);
    const { code } = mailFor(real.email as string);
    expect((await post('/signin/email/confirm', { requestId, requestSecret, code })).status).toBe(
      401,
    );
    expect(await sessionCount(real.id)).toBe(1);
  });

  it('refuses a link opened in another browser, and it still works in the right one', async () => {
    const real = await account();
    const requester = await browserDevice();
    const elsewhere = await browserDevice();
    const { requestId, requestSecret } = await start(real.username, requester.app);
    const { linkToken } = mailFor(real.email as string);

    const refused = await post(
      '/signin/email/link',
      { token: linkToken, device: elsewhere.auth },
      AUTH_ORIGIN,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('SIGNIN_LINK_OTHER_DEVICE');
    expect(
      (await post('/signin/email/collect', { requestId, requestSecret, device: requester.app }))
        .body,
    ).toMatchObject({ status: 'pending' });

    expect(
      (await post('/signin/email/link', { token: linkToken, device: requester.auth }, AUTH_ORIGIN))
        .status,
    ).toBe(200);
  });

  it("cannot be used by an attacker who asked for a victim's link: the victim's click approves nothing for them", async () => {
    const victim = await account();
    const attacker = await browserDevice();
    const victimBrowser = await browserDevice();
    const { requestId, requestSecret } = await start(victim.username, attacker.app);
    const { linkToken } = mailFor(victim.email as string);

    // The victim opens the link on their own browser.
    const click = await post(
      '/signin/email/link',
      { token: linkToken, device: victimBrowser.auth },
      AUTH_ORIGIN,
    );
    expect(click.status).toBe(403);
    const poll = await post('/signin/email/collect', {
      requestId,
      requestSecret,
      device: attacker.app,
    });
    expect(poll.body).toMatchObject({ status: 'pending' });
    expect(await sessionCount(victim.id)).toBe(0);
  });

  it('never approves a request made without a device proof, nor with a forged proof', async () => {
    const real = await account();
    const { auth } = await browserDevice();
    await start(real.username);
    const { linkToken } = mailFor(real.email as string);
    expect(
      (await post('/signin/email/link', { token: linkToken, device: auth }, AUTH_ORIGIN)).body
        .error,
    ).toBe('SIGNIN_LINK_OTHER_DEVICE');
    expect(
      (
        await post(
          '/signin/email/link',
          { token: linkToken, device: { deviceId: auth.deviceId, deviceSecret: 'forged' } },
          AUTH_ORIGIN,
        )
      ).status,
    ).toBe(403);
  });

  it('refuses a collection with a device other than the one that asked', async () => {
    const real = await account();
    const requester = await browserDevice();
    const other = await browserDevice();
    const { requestId, requestSecret } = await start(real.username, requester.app);
    const { linkToken } = mailFor(real.email as string);
    await post('/signin/email/link', { token: linkToken, device: requester.auth }, AUTH_ORIGIN);

    expect(
      (await post('/signin/email/collect', { requestId, requestSecret, device: other.app })).status,
    ).toBe(401);
    expect((await post('/signin/email/collect', { requestId, requestSecret })).status).toBe(401);
    expect(await sessionCount(real.id)).toBe(0);
  });

  it('answers the link only on auth.oxy.so, and refuses an expired one', async () => {
    const real = await account();
    const { auth, app } = await browserDevice();
    const { requestId } = await start(real.username, app);
    const { linkToken } = mailFor(real.email as string);
    expect(
      (await post('/signin/email/link', { token: linkToken, device: auth }, APP_ORIGIN)).status,
    ).toBe(403);
    expect(
      (await post('/signin/email/link', { token: linkToken, device: auth }, null)).status,
    ).toBe(403);

    await getDb()
      .update(emailSignInRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailSignInRequests.id, requestId));
    const late = await post('/signin/email/link', { token: linkToken, device: auth }, AUTH_ORIGIN);
    expect(late.status).toBe(401);
    expect(late.body.error).toBe('SIGNIN_LINK_INVALID');
  });
});

describe('password sign-in', () => {
  it('signs in by username or email with the right password only', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const [stored] = await getDb()
      .select({ passwordHash: userPasswords.passwordHash })
      .from(userPasswords)
      .where(eq(userPasswords.userId, real.id));
    expect(stored.passwordHash).toMatch(/^\$scrypt\$v=1\$ln=15,r=8,p=3\$/);
    expect(stored.passwordHash).not.toContain('correct horse battery');

    const byName = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    expect(byName.status).toBe(200);
    expect(byName.body.user).toMatchObject({ id: real.id });
    const byEmail = await post('/signin/password', {
      identifier: (real.email as string).toUpperCase(),
      password: 'correct horse battery',
    });
    expect(byEmail.status).toBe(200);

    const wrong = await post('/signin/password', {
      identifier: real.username,
      password: 'wrong password!',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
  });

  it('answers an unknown account, and an account with no password, exactly like a wrong password', async () => {
    const noPassword = await account();
    const withPassword = await account();
    await storePassword(withPassword.id, 'correct horse battery');
    const answers = await Promise.all([
      post('/signin/password', { identifier: `ghost-${suffix()}`, password: 'whatever12345' }),
      post('/signin/password', { identifier: noPassword.username, password: 'whatever12345' }),
      post('/signin/password', { identifier: withPassword.username, password: 'whatever12345' }),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
      expect(answer.body.message).toBe(answers[0].body.message);
    }
  });

  it('locks an identifier after five wrong passwords — a known one exactly like an unknown one', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const ghost = `ghost-${suffix()}`;
    for (const identifier of [real.username, ghost]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await post('/signin/password', { identifier, password: 'nope-nope-nope' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
      }
      const sixth = await post('/signin/password', { identifier, password: 'nope-nope-nope' });
      expect(sixth.status).toBe(429);
      expect(sixth.body.error).toBe('SIGNIN_LOCKED');
    }
    // Locked: even the right password is refused, the same way.
    expect(
      (
        await post('/signin/password', {
          identifier: real.username,
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(429);
    expect(await sessionCount(real.id)).toBe(0);
    // The email is a bucket of its own (named separately).
    expect(
      (
        await post('/signin/password', {
          identifier: real.email as string,
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(200);
  });

  it('counts 50 parallel wrong passwords atomically: at most five are checked', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const answers = await Promise.all(
      Array.from({ length: 50 }, () =>
        post('/signin/password', { identifier: real.username, password: 'nope-nope-nope' }),
      ),
    );
    expect(answers.filter((answer) => answer.status === 401).length).toBeLessThanOrEqual(5);
    expect(answers.filter((answer) => answer.status === 429).length).toBeGreaterThanOrEqual(45);
  });

  it('answers a Commons account (a key) exactly like an unknown name, even with a password row', async () => {
    const keyed = await account({ publicKey: `04${'c'.repeat(128)}` });
    await storePassword(keyed.id, 'correct horse battery');
    const res = await post('/signin/password', {
      identifier: keyed.username,
      password: 'correct horse battery',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
    expect(await sessionCount(keyed.id)).toBe(0);
  });

  it('never signs a managed account in with a password', async () => {
    const managed = await account({ kind: 'bot' });
    await storePassword(managed.id, 'correct horse battery');
    expect(
      (
        await post('/signin/password', {
          identifier: managed.username,
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(401);
  });
});

describe('the authenticator', () => {
  beforeEach(awayFromTotpStepEdge, 15_000);

  it('stops every first factor at a challenge — no session exists until the code passes', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const { secret } = await enableTotp(real.id);
    const [row] = await getDb()
      .select({ secretCiphertext: userTotp.secretCiphertext })
      .from(userTotp)
      .where(eq(userTotp.userId, real.id));
    expect(row.secretCiphertext).toMatch(/^v1\./);
    expect(row.secretCiphertext).not.toContain(secret);

    const byPassword = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    expect(byPassword.status).toBe(200);
    expect(Object.keys(byPassword.body).sort()).toEqual([
      'challengeId',
      'expiresAt',
      'secondFactorRequired',
    ]);
    expect(byPassword.raw).not.toMatch(/accessToken|sessionId|deviceSecret/);

    const { requestId, requestSecret } = await start(real.username);
    const byCode = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code: mailFor(real.email as string).code,
    });
    expect(byCode.body.secondFactorRequired).toBe(true);
    expect(await sessionCount(real.id)).toBe(0);

    const done = await post('/signin/second-factor', {
      challengeId: byPassword.body.challengeId,
      code: totpCodeAt(secret, new Date()),
    });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ id: real.id });
    expect(await sessionCount(real.id)).toBe(1);
  });

  it('spends a challenge once, refuses a replayed code, a wrong code and a stale challenge', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const { secret } = await enableTotp(real.id);
    const first = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    const code = totpCodeAt(secret, new Date());

    const wrong = await post('/signin/second-factor', {
      challengeId: first.body.challengeId,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('SECOND_FACTOR_INVALID');

    expect(
      (await post('/signin/second-factor', { challengeId: first.body.challengeId, code })).status,
    ).toBe(200);
    expect(
      (await post('/signin/second-factor', { challengeId: first.body.challengeId, code })).status,
    ).toBe(401);

    // The same code on a fresh challenge: a replay.
    const second = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    expect(
      (await post('/signin/second-factor', { challengeId: second.body.challengeId, code })).status,
    ).toBe(401);

    await getDb()
      .update(signInSecondFactorChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        eq(
          signInSecondFactorChallenges.challengeHash,
          createHash('sha256')
            .update(second.body.challengeId as string)
            .digest('hex'),
        ),
      );
    const next = totpCodeAt(secret, new Date(Date.now() + 30_000));
    expect(
      (await post('/signin/second-factor', { challengeId: second.body.challengeId, code: next }))
        .status,
    ).toBe(401);
    expect(await sessionCount(real.id)).toBe(1);
  });

  it('binds the challenge to the device that passed the first factor', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const { secret } = await enableTotp(real.id);
    const mine = await browserDevice();
    const theirs = await browserDevice();
    const first = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
      device: mine.app,
    });

    const code = totpCodeAt(secret, new Date());
    expect(
      (
        await post('/signin/second-factor', {
          challengeId: first.body.challengeId,
          code,
          device: theirs.app,
        })
      ).status,
    ).toBe(401);
    expect(
      (await post('/signin/second-factor', { challengeId: first.body.challengeId, code })).status,
    ).toBe(401);
    const done = await post('/signin/second-factor', {
      challengeId: first.body.challengeId,
      code,
      device: mine.app,
    });
    expect(done.status).toBe(200);
    expect(done.body.deviceId).toBe(mine.app.deviceId);
  });

  it('takes each backup code once', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const { backupCodes } = await enableTotp(real.id);
    const [backup] = backupCodes;

    const first = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    expect(
      (
        await post('/signin/second-factor', {
          challengeId: first.body.challengeId,
          code: backup.toUpperCase().replace('-', ''),
        })
      ).status,
    ).toBe(200);
    const second = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    expect(
      (await post('/signin/second-factor', { challengeId: second.body.challengeId, code: backup }))
        .status,
    ).toBe(401);
  });

  it('gives a challenge five tries, then it is dead', async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const { secret } = await enableTotp(real.id);
    const first = await post('/signin/password', {
      identifier: real.username,
      password: 'correct horse battery',
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await post('/signin/second-factor', {
        challengeId: first.body.challengeId,
        code: 'zzzzz-zzzzz',
      });
      expect([401, 429]).toContain(res.status);
    }
    _resetInMemoryStateForTests();
    expect(
      (
        await post('/signin/second-factor', {
          challengeId: first.body.challengeId,
          code: totpCodeAt(secret, new Date()),
        })
      ).status,
    ).toBe(401);
    expect(await sessionCount(real.id)).toBe(0);
  });
});

describe('the second factor on every path', () => {
  beforeEach(awayFromTotpStepEdge, 15_000);

  it('stops a link collected by the dialog at the challenge too', async () => {
    const real = await account();
    await enableTotp(real.id);
    const { auth, app } = await browserDevice();
    const { requestId, requestSecret } = await start(real.username, app);
    await post(
      '/signin/email/link',
      { token: mailFor(real.email as string).linkToken, device: auth },
      AUTH_ORIGIN,
    );
    const collected = await post('/signin/email/collect', {
      requestId,
      requestSecret,
      device: app,
    });
    expect(collected.body.secondFactorRequired).toBe(true);
    expect(collected.raw).not.toMatch(/accessToken|sessionId|deviceSecret/);
    expect(await sessionCount(real.id)).toBe(0);
  });

  it('counts 50 parallel wrong authenticator codes atomically: at most five are checked', async () => {
    const real = await account();
    await enableTotp(real.id);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        verifySecondFactor(real.id, 'wrong-wrong').then(
          (ok) => (ok ? 'ok' : 'checked'),
          () => 'locked',
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'checked').length).toBeLessThanOrEqual(5);
    expect(outcomes.filter((outcome) => outcome === 'locked').length).toBeGreaterThanOrEqual(45);
  });
});

describe('email codes across requests', () => {
  it('refuses even the right code after ten wrong ones in a day, with the same error — the link still works', async () => {
    const real = await account();
    const { auth, app } = await browserDevice();
    let wrongSoFar = 0;
    while (wrongSoFar < SIGNIN_CODE_FAILURES_PER_DAY) {
      const { requestId, requestSecret } = await start(real.username, app);
      const right = mailFor(real.email as string).code;
      mockSendSignIn.mockClear();
      const wrong = right === '000000' ? '000001' : '000000';
      for (
        let attempt = 0;
        attempt < 4 && wrongSoFar < SIGNIN_CODE_FAILURES_PER_DAY;
        attempt += 1
      ) {
        const res = await post('/signin/email/confirm', { requestId, requestSecret, code: wrong });
        expect(res.status).toBe(401);
        wrongSoFar += 1;
      }
    }
    // A fresh request, the RIGHT code: refused like a wrong one.
    const fresh = await start(real.username, app);
    const mail = mailFor(real.email as string);
    const refused = await post('/signin/email/confirm', {
      requestId: fresh.requestId,
      requestSecret: fresh.requestSecret,
      code: mail.code,
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('EMAIL_CODE_INVALID');
    expect(await sessionCount(real.id)).toBe(0);
    // The link, which needs this browser, still signs in.
    expect(
      (await post('/signin/email/link', { token: mail.linkToken, device: auth }, AUTH_ORIGIN))
        .status,
    ).toBe(200);
    const collected = await post('/signin/email/collect', {
      requestId: fresh.requestId,
      requestSecret: fresh.requestSecret,
      device: app,
    });
    expect(collected.status).toBe(200);
    expect(await sessionCount(real.id)).toBe(1);
  });
});

describe('email codes are capped per requester', () => {
  it("an attacker's ten failures from one IP do not stop the owner's right code from another", async () => {
    const victim = await account();
    const attacker = '203.0.113.7';
    const owner = '198.51.100.9';
    for (let round = 0; round < 3; round += 1) {
      const { requestId, requestSecret } = (
        await post('/signin/email/start', { identifier: victim.username }, APP_ORIGIN, attacker)
      ).body as {
        requestId: string;
        requestSecret: string;
      };
      const right = mailFor(victim.email as string).code;
      mockSendSignIn.mockClear();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await post(
          '/signin/email/confirm',
          { requestId, requestSecret, code: right === '000000' ? '000001' : '000000' },
          APP_ORIGIN,
          attacker,
        );
      }
    }
    const mine = (
      await post('/signin/email/start', { identifier: victim.username }, APP_ORIGIN, owner)
    ).body as {
      requestId: string;
      requestSecret: string;
    };
    const res = await post(
      '/signin/email/confirm',
      {
        requestId: mine.requestId,
        requestSecret: mine.requestSecret,
        code: mailFor(victim.email as string).code,
      },
      APP_ORIGIN,
      owner,
    );
    expect(res.status).toBe(200);
    expect(await sessionCount(victim.id)).toBe(1);
  });
});

describe('the per-account code ceiling', () => {
  const wrongFor = (right: string) => (right === '000000' ? '000001' : '000000');

  /** Fifty wrong 6-digit attempts, spread over ten requesters so none hits its own cap. */
  async function burnCeiling(victim: { username: string; email: string | null }) {
    const burner = await startEmailSignIn({ identifier: victim.username }, 'burner');
    const burnerCode = mailFor(victim.email as string).code;
    for (let requester = 0; requester < 10; requester += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await confirmEmailSignIn({
          ...burner,
          code: wrongFor(burnerCode),
          requesterKey: `rotating-${requester}`,
        }).catch(() => undefined);
      }
    }
  }

  it('past it, nobody is exempt by IP: even the requester that started a 6-digit request is refused', async () => {
    const victim = await account();
    const early = await startEmailSignIn({ identifier: victim.username }, 'owner-ip');
    const earlyCode = mailFor(victim.email as string).code;
    mockSendSignIn.mockClear();
    await burnCeiling(victim);
    await expect(
      confirmEmailSignIn({ ...early, code: earlyCode, requesterKey: 'owner-ip' }),
    ).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
    expect(await sessionCount(victim.id)).toBe(0);
  });

  it('then every new email carries the long code: a 6-digit guess from a new IP is refused, the owner signs in with it', async () => {
    const victim = await account();
    await burnCeiling(victim);

    // An attacker from a fresh address starts its own request and guesses 6 digits.
    mockSendSignIn.mockClear();
    const attackers = await startEmailSignIn({ identifier: victim.username }, 'fresh-attacker-ip');
    const sent = mailFor(victim.email as string).code;
    expect(sent).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
    await expect(
      confirmEmailSignIn({ ...attackers, code: '123456', requesterKey: 'fresh-attacker-ip' }),
    ).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });

    // The owner, from anywhere, types the long code (any case, with or without its dash).
    mockSendSignIn.mockClear();
    const owners = await start(victim.username);
    const long = mailFor(victim.email as string).code;
    const res = await post(
      '/signin/email/confirm',
      {
        requestId: owners.requestId,
        requestSecret: owners.requestSecret,
        code: long.toLowerCase(),
      },
      APP_ORIGIN,
      '192.0.2.77',
    );
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: victim.id });
  });

  it('a device the account is already signed in on is still exempt for a 6-digit code', async () => {
    const victim = await account();
    const { app } = await browserDevice();
    const first = await start(victim.username, app);
    await post('/signin/email/confirm', {
      requestId: first.requestId,
      requestSecret: first.requestSecret,
      code: mailFor(victim.email as string).code,
      device: app,
    });
    mockSendSignIn.mockClear();
    const early = await startEmailSignIn({ identifier: victim.username, device: app }, 'owner-ip');
    const earlyCode = mailFor(victim.email as string).code;
    expect(earlyCode).toMatch(/^\d{6}$/);
    await burnCeiling(victim);
    await expect(
      confirmEmailSignIn({ ...early, code: earlyCode, requesterKey: 'another-ip', device: app }),
    ).resolves.toEqual({ userId: victim.id });
  });
});

describe('identifiers are normalised once', () => {
  it("'ALİCE' (a dotted capital I) names no account and has no bucket of the real account", async () => {
    const real = await account();
    await storePassword(real.id, 'correct horse battery');
    const lookalike = real.username.toUpperCase().replace('I', 'İ').replace(/^SI/, 'Sİ');
    expect(lookalike).not.toBe(real.username.toUpperCase());
    const res = await post('/signin/password', {
      identifier: lookalike,
      password: 'correct horse battery',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
    // Five failures under the look-alike never lock the real name.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await post('/signin/password', { identifier: lookalike, password: 'nope-nope-nope' });
    }
    expect(
      (
        await post('/signin/password', {
          identifier: real.username,
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(200);
    // …and a full-width spelling IS the same name (NFKC).
    const fullWidth = [...real.username]
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
      .join('');
    expect(
      (await post('/signin/password', { identifier: fullWidth, password: 'correct horse battery' }))
        .status,
    ).toBe(200);
  });

  it('never mails an address named with characters outside the charset', async () => {
    const real = await account();
    const lookalike = (real.email as string).replace('i', 'İ');
    expect((await post('/signin/email/start', { identifier: lookalike })).status).toBe(200);
    expect(mockSendSignIn).not.toHaveBeenCalled();
  });
});

describe('the send budget', () => {
  it('is never visible: over budget the answer is the same and nothing is sent', async () => {
    const real = await account();
    const answers = [];
    for (let send = 0; send < EMAIL_SENDS_PER_HOUR + 3; send += 1) {
      const res = await post('/signin/email/start', { identifier: real.username });
      expect(res.status).toBe(200);
      answers.push(Object.keys(res.body).sort().join(','));
    }
    expect(new Set(answers).size).toBe(1);
    expect(mockSendSignIn).toHaveBeenCalledTimes(EMAIL_SENDS_PER_HOUR);
  });

  it('keeps a slice for a device the account is already on, and tells only that device to retry later', async () => {
    const real = await account();
    const { app } = await browserDevice();
    // Sign in once on this device, so the account is on it.
    const first = await start(real.username, app);
    await post('/signin/email/confirm', {
      requestId: first.requestId,
      requestSecret: first.requestSecret,
      code: mailFor(real.email as string).code,
      device: app,
    });
    // Strangers use up the address's shared budget.
    for (const stranger of ['a', 'b', 'c']) {
      for (let send = 0; send < EMAIL_SENDS_PER_HOUR; send += 1) {
        await startEmailSignIn({ identifier: real.username }, `stranger-${stranger}`);
      }
    }
    mockSendSignIn.mockClear();
    const unknown = await startEmailSignIn({ identifier: real.username }, 'stranger-d');
    expect(mockSendSignIn).not.toHaveBeenCalled();
    expect(unknown.retryLater).toBeUndefined();

    // The owner's own browser still gets mail from the reserved slice…
    const mine = await startEmailSignIn({ identifier: real.username, device: app }, 'owner-ip');
    expect(mockSendSignIn).toHaveBeenCalledTimes(1);
    expect(mine.retryLater).toBeUndefined();
    // …and once that is used up too, only it is told to try later.
    let last = mine;
    for (let send = 0; send < 6; send += 1)
      last = await startEmailSignIn({ identifier: real.username, device: app }, `owner-ip-${send}`);
    expect(last.retryLater).toBe(true);
  });

  it("gives each requester its own slice, so one stranger cannot stop someone's mail", async () => {
    const real = await account();
    for (let send = 0; send < EMAIL_SENDS_PER_HOUR + 2; send += 1) {
      await startEmailSignIn({ identifier: real.username }, 'attacker');
    }
    mockSendSignIn.mockClear();
    await startEmailSignIn({ identifier: real.username }, 'the-owner');
    expect(mockSendSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('sign-up', () => {
  async function signupTicket(email: string): Promise<string> {
    const { confirmEmailVerification, startEmailVerification } = await import(
      '../../services/accountEmail.service'
    );
    const { verificationId } = await startEmailVerification(
      { purpose: 'signup', email },
      'test-requester',
    );
    const code = mockSendCode.mock.calls.find(([to]) => to === email)?.[1] as string;
    return (await confirmEmailVerification(verificationId, code)).ticket;
  }

  it('creates the account from a username and a confirmed email — no key — and signs in on the device', async () => {
    const email = `new-${suffix()}@example.test`;
    const username = `new${suffix()}`;
    const emailTicket = await signupTicket(email);
    const { app } = await browserDevice();

    const res = await post('/signup', { username, email, emailTicket, device: app });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deviceId: app.deviceId, user: { username } });
    const userId = (res.body.user as { id: string }).id;
    const [created] = await getDb()
      .select({ email: users.email, publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, userId));
    expect(created).toEqual({ email, publicKey: null });

    // The ticket is spent.
    expect(
      (await post('/signup', { username: `other${suffix()}`, email, emailTicket })).status,
    ).toBe(401);
  });

  it('stores the guest language and first-touch campaign once without exposing attribution in the session', async () => {
    const email = `campaign-${suffix()}@example.test`;
    const username = `campaign${suffix()}`;
    const emailTicket = await signupTicket(email);
    const campaignAttribution = { utmSource: 'meta', utmCampaign: 'spain', fbclid: 'click-id' };
    const response = await post('/signup', {
      username,
      email,
      emailTicket,
      languages: ['es-ES'],
      campaignAttribution,
    });
    expect(response.status).toBe(200);
    const [preferences] = await getDb()
      .select({ languages: users.languages })
      .from(users)
      .where(eq(users.id, response.body.user.id));
    expect(preferences?.languages).toEqual(['es-ES']);
    expect(response.body.user.campaignAttribution).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('click-id');
    const userId = response.body.user.id;
    const [stored] = await getDb()
      .select({
        utmSource: accountAcquisition.utmSource,
        utmCampaign: accountAcquisition.utmCampaign,
        fbclid: accountAcquisition.fbclid,
      })
      .from(accountAcquisition)
      .where(eq(accountAcquisition.userId, userId));
    expect(stored).toEqual(campaignAttribution);
    const retry = await post('/signup', {
      username: `retry${suffix()}`,
      email,
      emailTicket,
      campaignAttribution: { utmSource: 'other' },
    });
    expect(retry.status).toBe(401);
    expect(
      await getDb()
        .select({ source: accountAcquisition.utmSource })
        .from(accountAcquisition)
        .where(eq(accountAcquisition.userId, userId)),
    ).toEqual([{ source: 'meta' }]);
  });

  it('rejects malformed attribution before consuming the signup ticket', async () => {
    const email = `bounded-${suffix()}@example.test`;
    const emailTicket = await signupTicket(email);
    const input = { username: `bounded${suffix()}`, email, emailTicket };
    expect(
      (await post('/signup', { ...input, campaignAttribution: { fbclid: 'x'.repeat(1025) } }))
        .status,
    ).toBe(400);
    expect((await post('/signup', { ...input, languages: ['zz-ZZ'] })).status).toBe(400);
    expect((await post('/signup', { ...input, languages: ['es-ES'] })).status).toBe(200);
  });

  it('refuses a taken username without spending the ticket, and a ticket for another email', async () => {
    const taken = await account();
    const email = `new-${suffix()}@example.test`;
    const emailTicket = await signupTicket(email);

    const conflict = await post('/signup', {
      username: taken.username.toUpperCase(),
      email,
      emailTicket,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('USERNAME_TAKEN');
    expect(
      (
        await post('/signup', {
          username: `new${suffix()}`,
          email: `other-${suffix()}@example.test`,
          emailTicket,
        })
      ).status,
    ).toBe(401);
    expect((await post('/signup', { username: `new${suffix()}`, email, emailTicket })).status).toBe(
      200,
    );
  });

  it('refuses an invalid username', async () => {
    const email = `new-${suffix()}@example.test`;
    const emailTicket = await signupTicket(email);
    expect(
      (await post('/signup', { username: 'no spaces allowed', email, emailTicket })).status,
    ).toBe(400);
  });
});

describe('one email, several accounts', () => {
  /** Two (or more) personal accounts on one fresh address, oldest first. */
  async function sharedEmail(count = 2) {
    const email = `shared-${suffix()}@example.test`;
    const holders = [];
    for (let index = 0; index < count; index += 1) holders.push(await account({ email }));
    return { email, holders };
  }

  type Choice = { chooseAccount: true; accounts: { id: string; username?: string }[] };

  it('a sign-up for an email that already holds an account creates another one', async () => {
    const { confirmEmailVerification, startEmailVerification } = await import(
      '../../services/accountEmail.service'
    );
    const existing = await account();
    const email = existing.email as string;
    const { verificationId } = await startEmailVerification(
      { purpose: 'signup', email },
      'test-requester',
    );
    const code = mockSendCode.mock.calls.find(([to]) => to === email)?.[1] as string;
    const { ticket } = await confirmEmailVerification(verificationId, code);

    const username = `second${suffix()}`;
    const res = await post('/signup', { username, email, emailTicket: ticket });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { username } });
    const holders = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(holders).toHaveLength(2);
  });

  it(`refuses a sign-up past ${EMAIL_ACCOUNTS_MAX} accounts on one email`, async () => {
    const { confirmEmailVerification, startEmailVerification } = await import(
      '../../services/accountEmail.service'
    );
    const { email } = await sharedEmail(EMAIL_ACCOUNTS_MAX);
    const { verificationId } = await startEmailVerification(
      { purpose: 'signup', email },
      'test-requester',
    );
    const code = mockSendCode.mock.calls.find(([to]) => to === email)?.[1] as string;
    const { ticket } = await confirmEmailVerification(verificationId, code);

    const res = await post('/signup', { username: `full${suffix()}`, email, emailTicket: ticket });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EMAIL_ACCOUNTS_FULL');
  });

  it('the code proves the mailbox and lists its accounts; the chosen one signs in, once', async () => {
    const { email, holders } = await sharedEmail();
    const { requestId, requestSecret } = await start(email.toUpperCase());
    const mail = mailFor(email);
    // Which account is not said in the email: it is chosen after the code.
    expect(mail).toMatchObject({ username: null, severalAccounts: true });

    const proven = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code: mail.code,
    });
    expect(proven.status).toBe(200);
    expect(proven.body).toMatchObject({
      chooseAccount: true,
      accounts: holders.map((holder) => ({ id: holder.id, username: holder.username })),
    });
    expect(await sessionCount(holders[0].id)).toBe(0);
    expect(await sessionCount(holders[1].id)).toBe(0);

    // The choice again with the code: spent.
    expect(
      (await post('/signin/email/confirm', { requestId, requestSecret, code: mail.code })).status,
    ).toBe(401);

    const chosen = await post('/signin/email/choose', {
      requestId,
      requestSecret,
      userId: holders[1].id,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ user: { id: holders[1].id } });
    expect(await sessionCount(holders[1].id)).toBe(1);
    expect(await sessionCount(holders[0].id)).toBe(0);

    // Spent: no second account from the same proof.
    expect(
      (await post('/signin/email/choose', { requestId, requestSecret, userId: holders[0].id }))
        .status,
    ).toBe(401);
    expect(await sessionCount(holders[0].id)).toBe(0);
  });

  it('chooses only among the listed accounts, only with the secret, and only while the choice lasts', async () => {
    const { email, holders } = await sharedEmail();
    const stranger = await account();
    const { requestId, requestSecret } = await start(email);
    await post('/signin/email/confirm', { requestId, requestSecret, code: mailFor(email).code });

    const outsider = await post('/signin/email/choose', {
      requestId,
      requestSecret,
      userId: stranger.id,
    });
    expect(outsider.status).toBe(401);
    expect(outsider.body.error).toBe('SIGNIN_REQUEST_INVALID');
    expect(await sessionCount(stranger.id)).toBe(0);
    const noSecret = await post('/signin/email/choose', {
      requestId,
      requestSecret: 'B'.repeat(43),
      userId: holders[0].id,
    });
    expect(noSecret.status).toBe(401);
    await expect(
      chooseEmailSignInAccount(
        { requestId, requestSecret, userId: holders[0].id },
        new Date(Date.now() + EMAIL_SIGNIN_CHOICE_TTL_MS + 1000),
      ),
    ).rejects.toMatchObject({ code: 'SIGNIN_REQUEST_INVALID' });

    // None of those spent it.
    expect(
      (await post('/signin/email/choose', { requestId, requestSecret, userId: holders[0].id }))
        .status,
    ).toBe(200);
  });

  it('a request for an email that holds no account can never be chosen from', async () => {
    const someone = await account();
    const { requestId, requestSecret } = await start(`nobody-${suffix()}@example.test`);
    expect(
      (await post('/signin/email/choose', { requestId, requestSecret, userId: someone.id })).status,
    ).toBe(401);
    expect(
      (await post('/signin/email/confirm', { requestId, requestSecret, code: '123456' })).status,
    ).toBe(401);
  });

  it('a username names its one account, whatever else shares its email', async () => {
    const { email, holders } = await sharedEmail();
    const { requestId, requestSecret } = await start(holders[1].username);
    const mail = mailFor(email);
    expect(mail.username).toBe(holders[1].username);

    const res = await post('/signin/email/confirm', { requestId, requestSecret, code: mail.code });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { id: holders[1].id } });
    expect(res.body.chooseAccount).toBeUndefined();
    expect(await sessionCount(holders[0].id)).toBe(0);
  });

  it('an email that holds one account signs it in directly', async () => {
    const only = await account();
    const { requestId, requestSecret } = await start(only.email as string);
    const res = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code: mailFor(only.email as string).code,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { id: only.id } });
  });

  it('lists only the accounts that sign in by email: a Commons account is not offered', async () => {
    const email = `shared-${suffix()}@example.test`;
    const personal = await account({ email });
    const keyed = await account({ email, publicKey: `0x${suffix()}${suffix()}` });
    const { requestId, requestSecret } = await start(email);
    const res = await post('/signin/email/confirm', {
      requestId,
      requestSecret,
      code: mailFor(email).code,
    });
    expect(res.status).toBe(200);
    // One account left to offer: it signs in, no choice.
    expect(res.body).toMatchObject({ user: { id: personal.id } });
    expect(await sessionCount(keyed.id)).toBe(0);
  });

  it('the link in the same browser proves the mailbox too: collect answers the choice', async () => {
    const { email, holders } = await sharedEmail();
    const { auth, app } = await browserDevice();
    const { requestId, requestSecret } = await start(email, app);
    const { linkToken } = mailFor(email);
    expect(
      (await post('/signin/email/link', { token: linkToken, device: auth }, AUTH_ORIGIN)).status,
    ).toBe(200);

    // Only with the device the request was made with.
    expect((await post('/signin/email/collect', { requestId, requestSecret })).status).toBe(401);
    const collected = await post('/signin/email/collect', {
      requestId,
      requestSecret,
      device: app,
    });
    expect(collected.status).toBe(200);
    expect((collected.body as unknown as Choice).accounts.map((option) => option.id)).toEqual(
      holders.map((holder) => holder.id),
    );
    // A repeated poll answers the same choice.
    expect(
      (await post('/signin/email/collect', { requestId, requestSecret, device: app })).body,
    ).toMatchObject({ chooseAccount: true });

    const chosen = await post('/signin/email/choose', {
      requestId,
      requestSecret,
      userId: holders[0].id,
      device: app,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ deviceId: app.deviceId, user: { id: holders[0].id } });
    expect(
      (await post('/signin/email/collect', { requestId, requestSecret, device: app })).status,
    ).toBe(401);
  });

  it('the chosen account still asks for its authenticator', async () => {
    const { email, holders } = await sharedEmail();
    await enableTotp(holders[0].id);
    const { requestId, requestSecret } = await start(email);
    await post('/signin/email/confirm', { requestId, requestSecret, code: mailFor(email).code });

    const chosen = await post('/signin/email/choose', {
      requestId,
      requestSecret,
      userId: holders[0].id,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.secondFactorRequired).toBe(true);
    expect(await sessionCount(holders[0].id)).toBe(0);
  });

  it('a password with a shared email is refused like a wrong one; with the username it signs in', async () => {
    const { email, holders } = await sharedEmail();
    await storePassword(holders[0].id, 'correct horse battery');

    const byEmail = await post('/signin/password', {
      identifier: email,
      password: 'correct horse battery',
    });
    expect(byEmail.status).toBe(401);
    expect(byEmail.body.error).toBe('SIGNIN_INVALID_CREDENTIALS');
    const byUsername = await post('/signin/password', {
      identifier: holders[0].username,
      password: 'correct horse battery',
    });
    expect(byUsername.status).toBe(200);
    expect(byUsername.body).toMatchObject({ user: { id: holders[0].id } });
  });

  it('codes guessed through a username count against the whole mailbox', async () => {
    const { email, holders } = await sharedEmail();
    const burner = await startEmailSignIn({ identifier: holders[0].username }, 'burner');
    const burnerCode = mailFor(email).code;
    const wrong = burnerCode === '000000' ? '000001' : '000000';
    for (let requester = 0; requester < 10; requester += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await confirmEmailSignIn({
          ...burner,
          code: wrong,
          requesterKey: `rotating-${requester}`,
        }).catch(() => undefined);
      }
    }
    mockSendSignIn.mockClear();
    await startEmailSignIn({ identifier: email }, 'fresh-ip');
    expect(mailFor(email).code).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
  });
});

describe('who may call', () => {
  it('refuses a third-party site and a cross-site browser request on every route', async () => {
    for (const origin of ['https://third-party.example', 'https://evil.example']) {
      for (const [path, body] of [
        ['/signin/email/start', { identifier: 'someone' }],
        ['/signin/password', { identifier: 'someone', password: 'whatever12345' }],
        ['/signin/second-factor', { challengeId: 'A'.repeat(43), code: '123456' }],
        ['/signin/email/collect', { requestId: 'x', requestSecret: 'A'.repeat(43) }],
        ['/signup', { username: 'someone', email: 'a@example.test', emailTicket: 'A'.repeat(43) }],
      ] as const) {
        const res = await post(path, body, origin);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('SIGNIN_ORIGIN_NOT_ALLOWED');
      }
    }
    const { port } = server.address() as AddressInfo;
    const crossSite = await fetch(`http://127.0.0.1:${port}/auth/signin/email/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ identifier: 'someone' }),
    });
    expect(crossSite.status).toBe(403);
    expect(mockSendSignIn).not.toHaveBeenCalled();
  });

  it('admits an official app, auth.oxy.so, loopback and a native client', async () => {
    for (const origin of [APP_ORIGIN, AUTH_ORIGIN, 'http://localhost:8081', null]) {
      expect(
        (await post('/signin/email/start', { identifier: `ghost-${suffix()}` }, origin)).status,
      ).toBe(200);
    }
  });
});

describe('secrets never leave', () => {
  it('logs no code, link token, request secret or password, and answers none of them', async () => {
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(logger, level),
    );
    const real = await account();
    const password = `pw-${suffix()}-secret`;
    await storePassword(real.id, password);
    const { requestId, requestSecret } = await start(real.username);
    const { code, linkToken } = mailFor(real.email as string);
    const wrongCode = code === '000000' ? '111111' : '000000';

    const responses = [
      await post('/signin/email/confirm', { requestId, requestSecret, code: wrongCode }),
      await post('/signin/password', { identifier: real.username, password: `${password}x` }),
      await post('/signin/password', { identifier: real.username, password }),
      await post('/signin/email/confirm', { requestId, requestSecret, code }),
    ];
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    const answered = responses.map((response) => response.raw).join('\n');
    for (const secret of [code, wrongCode, linkToken, requestSecret, password]) {
      expect(logged).not.toContain(secret);
    }
    for (const secret of [code, linkToken, requestSecret, password]) {
      expect(answered).not.toContain(secret);
    }
    spies.forEach((spy) => spy.mockRestore());
  });
});
