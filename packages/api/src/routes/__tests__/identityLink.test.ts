/**
 * Linking Commons to a passkey account from two devices (ADR 0029 D3), through
 * the real `/identity/link` router, the real proof and challenge services and a
 * REAL Postgres.
 *
 * The root proof Commons posts is signed with a real secp256k1 key and verified
 * for real. `@simplewebauthn/server`'s assertion verifier is mocked at the
 * module boundary so the test drives its RESULT; the challenge, the origin and
 * which account owns the credential are checked for real.
 */

process.env.DEVICE_ID_SALT = 'identity-link-test-device-id-salt-0123456789';

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

let currentUserId = '';
let currentApplicationId: string | undefined;
const mockVerifyAuthentication = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string }; oxyToken?: { applicationId?: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: currentUserId, id: currentUserId };
    if (currentApplicationId) req.oxyToken = { applicationId: currentApplicationId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));
const mockSendReauthCode = jest.fn();
const mockSendSecurityNotice = jest.fn();
jest.mock('../../services/accountEmail.mail', () => ({
  sendReauthCode: (...args: unknown[]) => mockSendReauthCode(...args),
  sendSecurityNotice: (...args: unknown[]) => mockSendSecurityNotice(...args),
}));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthentication(...args),
}));

import { signIdentityProof } from '@oxy.so/core';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailVerifications } from '../../db/schema/emailVerifications';
import { identityLinkRequests } from '../../db/schema/identityLinkRequests';
import { applications } from '../../db/schema/applications';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import { errorHandler } from '../../middleware/errorHandler';
import identityLinkRouter from '../identityLink';
import { userTotp, userTotpBackupCodes } from '../../db/schema/userTotp';
import { userPasswords } from '../../db/schema/userPasswords';
import { storePassword } from '../../services/password.service';
import { confirmTotp, enrollTotp, totpCodeAt } from '../../services/totp.service';
import { startReauthEmail } from '../../services/reauth.service';

const AUTH_ORIGIN = 'https://auth.oxy.so';

let server: http.Server;

async function call(method: string, path: string, body?: unknown, origin: string | null = AUTH_ORIGIN) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/identity/link${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity/link', identityLinkRouter);
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
  mockSendReauthCode.mockReset().mockResolvedValue(undefined);
  mockSendSecurityNotice.mockReset().mockResolvedValue(undefined);
  mockVerifyAuthentication.mockReset();
  mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1, userVerified: true } });
});

/** A passkey account: a username, a recovery email with an outstanding code, one passkey. */
async function passkeyAccount() {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `link-${suffix}@example.test`;
  const [row] = await getDb().insert(users).values({ username: `link${suffix}`, email }).returning({ id: users.id, username: users.username });
  const credentialId = `cred${suffix}`;
  await getDb().insert(webauthnCredentials).values({
    userId: row.id,
    credentialID: credentialId,
    credentialPublicKey: Buffer.from([1, 2, 3]),
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    userVerified: true,
    name: 'Laptop',
  });
  await getDb().insert(userAuthMethods).values({ userId: row.id, type: 'webauthn', methodCredentialId: credentialId, methodName: 'Laptop' });
  await getDb().insert(emailVerifications).values({
    purpose: 'recovery',
    emailHash: 'ab'.repeat(32),
    userId: row.id,
    codeHash: 'cd'.repeat(32),
    expiresAt: new Date(Date.now() + 60_000),
  });
  currentUserId = row.id;
  return { id: row.id, username: row.username as string, email, credentialId };
}

function commonsKey() {
  const pair = generateSecp256k1KeyPair();
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.toLowerCase() };
}

/** What Commons does after scanning: read the request and sign its proof. */
async function commonsProof(linkId: string, challenge: string, key = commonsKey()) {
  const state = (await call('GET', `/${linkId}`, undefined, null)).body as { userId: string; audience: string; expiresAt: number };
  const proof = await signIdentityProof(key, {
    action: 'link_identity',
    subject: state.userId,
    actor: state.userId,
    rootPublicKey: key.publicKey,
    payloadDigest: null,
    expectedRevision: null,
    audience: state.audience,
    challenge,
    expiresAt: state.expiresAt,
  });
  return { key, body: { publicKey: key.publicKey, proof } };
}

function assertion(credentialId: string, challengeHex: string, origin = AUTH_ORIGIN) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challengeHex, 'hex').toString('base64url'), origin }),
  ).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON, authenticatorData: 'AAAA', signature: 'AAAA' },
    clientExtensionResults: {},
  };
}

async function open() {
  const res = await call('POST', '/');
  expect(res.status).toBe(200);
  return res.body as { linkId: string; challenge: string; qrPayload: string; expiresAt: number };
}

async function storedUser(id: string) {
  const [row] = await getDb().select({ publicKey: users.publicKey, email: users.email }).from(users).where(eq(users.id, id));
  return row;
}

async function reauthCode(userId: string, action: 'link_commons' | 'delete_account' = 'link_commons') {
  mockSendReauthCode.mockClear();
  const { verificationId } = await startReauthEmail(userId, action);
  const code = mockSendReauthCode.mock.calls[0][1] as string;
  return { verificationId, code };
}

describe('linking Commons from two devices', () => {
  it('links the key Commons signed with, once the email code confirms — and deletes the email', async () => {
    const account = await passkeyAccount();
    const link = await open();
    expect(link.qrPayload).toBe(`oxycommons://link?id=${link.linkId}&c=${link.challenge}`);

    const pending = await call('GET', `/${link.linkId}`, undefined, null);
    expect(pending.body).toMatchObject({ status: 'pending', userId: account.id, username: account.username, publicKey: null });

    const { key, body } = await commonsProof(link.linkId, link.challenge);
    expect((await call('POST', `/${link.linkId}/proof`, body, null)).status).toBe(200);
    expect((await call('GET', `/${link.linkId}`, undefined, null)).body).toMatchObject({ status: 'signed', publicKey: key.publicKey });
    // Signed is not linked: nothing changes before the account confirms.
    expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });

    const done = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: await reauthCode(account.id) } });
    expect(done).toEqual({ status: 200, body: { success: true } });

    expect(await storedUser(account.id)).toEqual({ publicKey: key.publicKey, email: null });
    const methods = await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, account.id));
    expect(methods.find((method) => method.type === 'identity')?.methodPublicKey).toBe(key.publicKey);
    expect(await getDb().select().from(emailVerifications).where(eq(emailVerifications.userId, account.id))).toHaveLength(0);
    expect((await call('GET', `/${link.linkId}`, undefined, null)).body.status).toBe('completed');
  });
  it('takes the first proof only: a second key cannot replace it', async () => {
    await passkeyAccount();
    const link = await open();
    expect((await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge)).body, null)).status).toBe(200);

    const second = await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge)).body, null);
    expect(second.status).toBe(404);
  });

  it('refuses a proof over another challenge, and a key another account holds', async () => {
    await passkeyAccount();
    const link = await open();
    const wrong = await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, 'ef'.repeat(32))).body, null);
    expect(wrong.status).toBe(401);

    const taken = commonsKey();
    await getDb().insert(users).values({ publicKey: taken.publicKey });
    const res = await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge, taken)).body, null);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('IDENTITY_ROOT_LINKED_ELSEWHERE');
  });

  it('links nothing on a passkey assertion, from any origin — a passkey no longer confirms a link', async () => {
    const account = await passkeyAccount();
    const link = await open();
    await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge)).body, null);

    const res = await call('POST', `/${link.linkId}/complete`, { assertion: assertion(account.credentialId, link.challenge) });

    expect(res.status).toBe(400);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
    expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });
    expect((await call('GET', `/${link.linkId}`, undefined, null)).body.status).toBe('signed');
  });
  it('answers only the account that opened the request', async () => {
    const owner = await passkeyAccount();
    const link = await open();
    await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge)).body, null);

    const intruder = await passkeyAccount();
    const res = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: await reauthCode(intruder.id) } });
    expect(res.status).toBe(404);
    expect(await storedUser(owner.id)).toEqual({ publicKey: null, email: owner.email });
  });
  it('withdraws a request, and forgets an expired one', async () => {
    await passkeyAccount();
    const link = await open();
    expect((await call('DELETE', `/${link.linkId}`)).status).toBe(200);
    expect((await call('GET', `/${link.linkId}`, undefined, null)).body.status).toBe('cancelled');
    expect((await call('POST', `/${link.linkId}/proof`, (await commonsProof(link.linkId, link.challenge)).body, null)).status).toBe(404);

    const later = await open();
    await getDb().update(identityLinkRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(identityLinkRequests.linkId, later.linkId));
    expect((await call('GET', `/${later.linkId}`, undefined, null)).status).toBe(404);
  });

  it('opens a request only from an official app, for an account without a root that can confirm it', async () => {
    const account = await passkeyAccount();
    expect((await call('POST', '/', undefined, 'https://third-party.example')).status).toBe(403);

    await getDb().update(users).set({ publicKey: commonsKey().publicKey }).where(eq(users.id, account.id));
    expect((await call('POST', '/')).status).toBe(409);

    // An email is enough to confirm with…
    const [emailOnly] = await getDb().insert(users).values({ email: `bare-${randomUUID()}@example.test` }).returning({ id: users.id });
    currentUserId = emailOnly.id;
    expect((await call('POST', '/')).status).toBe(200);

    // …but with neither an email nor a passkey there is nothing to confirm with.
    const [bare] = await getDb().insert(users).values({ username: `bare${randomUUID().slice(0, 8)}` }).returning({ id: users.id });
    currentUserId = bare.id;
    expect((await call('POST', '/')).status).toBe(401);
  });

  it('withdraws an earlier open request when a new one opens', async () => {
    await passkeyAccount();
    const first = await open();
    await open();
    expect((await call('GET', `/${first.linkId}`, undefined, null)).body.status).toBe('cancelled');
  });

  describe('confirmed with a code sent to the email', () => {
    async function signedLink() {
      const account = await passkeyAccount();
      const link = await open();
      const { key, body } = await commonsProof(link.linkId, link.challenge);
      expect((await call('POST', `/${link.linkId}/proof`, body, null)).status).toBe(200);
      return { account, link, key };
    }

    it('links from any official app with the email code, deletes the email and tells it so', async () => {
      const { account, link, key } = await signedLink();
      const emailCode = await reauthCode(account.id);

      const done = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode } }, 'http://localhost:8081');
      expect(done).toEqual({ status: 200, body: { success: true } });
      expect(await storedUser(account.id)).toEqual({ publicKey: key.publicKey, email: null });
      expect(mockSendSecurityNotice).toHaveBeenCalledWith(account.email, 'commons_linked', account.username);
    });

    it('links nothing on a wrong code, and a spent code does not work twice', async () => {
      const { account, link } = await signedLink();
      const emailCode = await reauthCode(account.id);
      const wrong = emailCode.code === '000000' ? '111111' : '000000';

      const refused = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: { ...emailCode, code: wrong } } });
      expect(refused.status).toBe(401);
      expect(refused.body.error).toBe('EMAIL_CODE_INVALID');
      expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });

      // The request stays signed; the right code links once.
      expect((await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode } })).status).toBe(200);
      const again = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode } });
      expect(again.status).toBe(404);
    });

    it('refuses a code asked for another change (deleting the account)', async () => {
      const { account, link } = await signedLink();
      const forDeletion = await reauthCode(account.id, 'delete_account');
      const res = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: forDeletion } });
      expect(res.status).toBe(401);
      expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });
    });

    it('deletes the password and the authenticator with the email, in the link', async () => {
      const { account, link, key } = await signedLink();
      await storePassword(account.id, 'a password to lose');
      const enrolled = await enrollTotp(account.id, 'x');
      await confirmTotp(account.id, totpCodeAt(enrolled.secret, new Date(Date.now() - 30_000)));
      const emailCode = await reauthCode(account.id);
      const done = await call('POST', `/${link.linkId}/complete`, {
        reauth: { emailCode, totpCode: totpCodeAt(enrolled.secret, new Date()) },
      });
      expect(done.status).toBe(200);
      expect(await storedUser(account.id)).toEqual({ publicKey: key.publicKey, email: null });
      expect(await getDb().select().from(userPasswords).where(eq(userPasswords.userId, account.id))).toHaveLength(0);
      expect(await getDb().select().from(userTotp).where(eq(userTotp.userId, account.id))).toHaveLength(0);
      expect(await getDb().select().from(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, account.id))).toHaveLength(0);
    });

    it('refuses a code sent to another account', async () => {
      const { account, link } = await signedLink();
      const other = await passkeyAccount();
      const othersCode = await reauthCode(other.id);
      currentUserId = account.id;
      const res = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: othersCode } });
      expect(res.status).toBe(401);
      expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });
    });

    it('asks for the authenticator code too when the account has one', async () => {
      const { account, link } = await signedLink();
      await getDb().insert(userTotp).values({ userId: account.id, secretCiphertext: 'v1.x.x.x', enabledAt: new Date() });
      const emailCode = await reauthCode(account.id);
      const res = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode } });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('TOTP_REQUIRED');
      expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });
    });

    it("refuses a third-party application's token, even with the right code", async () => {
      const { account, link } = await signedLink();
      const [app] = await getDb()
        .insert(applications)
        .values({ name: 'Third party', type: 'third_party', ownerAccountId: account.id, createdByUserId: account.id })
        .returning({ id: applications.id });
      currentApplicationId = app.id;
      try {
        const res = await call('POST', `/${link.linkId}/complete`, { reauth: { emailCode: await reauthCode(account.id) } });
        expect(res.status).toBe(403);
        expect(await storedUser(account.id)).toEqual({ publicKey: null, email: account.email });
      } finally {
        currentApplicationId = undefined;
      }
    });
  });
});
