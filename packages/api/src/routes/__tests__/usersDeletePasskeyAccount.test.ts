/**
 * Deleting a PASSKEY account (ADR 0029 D3): it has no key to sign the deletion
 * with, so the person asserts one of its passkeys, on auth.oxy.so, over a
 * challenge `POST /users/me/delete/options` minted for the account — through
 * the real router, the real assertion service and a REAL Postgres.
 *
 * Stubbed, as in `usersDeleteAccountEvent.test.ts`: the session, the
 * destructive side systems and caches. `@simplewebauthn/server` is mocked at
 * the module boundary so the test drives the verification RESULT; the origin,
 * the challenge and the credential ownership are checked for real.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

let currentUserId: string | undefined;
let currentServiceAppId: string | undefined;
const signatureValid = true;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
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
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    verifySignature: () => signatureValid,
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
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));


const mockVerifyAuthentication = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: async (options: { allowCredentials: unknown[] }) => ({
    challenge: jest.requireActual<typeof import('node:crypto')>('node:crypto').randomBytes(32).toString('base64url'),
    allowCredentials: options.allowCredentials,
  }),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthentication(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { webauthnChallenges } from '../../db/schema/webauthnChallenges';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import { errorHandler } from '../../middleware/errorHandler';
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
  mockVerifyAuthentication.mockReset();
  mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1, userVerified: true } });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function passkeyAccount(extra: { publicKey?: string } = {}) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const [person] = await getDb()
    .insert(users)
    .values({ username: `leaving${suffix}`, email: `leaving-${suffix}@example.test`, ...extra })
    .returning({ id: users.id, username: users.username });
  const credentialId = `cred${suffix}`;
  await getDb().insert(webauthnCredentials).values({
    userId: person.id,
    credentialID: credentialId,
    credentialPublicKey: Buffer.from([1, 2, 3]),
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    userVerified: true,
    name: 'Laptop',
  });
  currentUserId = person.id;
  return { id: person.id, username: person.username as string, credentialId };
}

function assertion(credentialId: string, challenge: string, origin = 'https://auth.oxy.so') {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON, authenticatorData: 'AAAA', signature: 'AAAA' },
    clientExtensionResults: {},
  };
}

async function options(): Promise<{ challenge: string; allowCredentials: { id: string }[] }> {
  const res = await call('POST', '/users/me/delete/options');
  expect(res.status).toBe(200);
  return res.body as unknown as { challenge: string; allowCredentials: { id: string }[] };
}

async function accountExists(id: string): Promise<boolean> {
  return (await getDb().select({ id: users.id }).from(users).where(eq(users.id, id))).length > 0;
}

describe('deleting a passkey account', () => {
  it('asks for the account\'s own passkeys, with a challenge bound to it', async () => {
    const person = await passkeyAccount();
    const { challenge, allowCredentials } = await options();

    expect(allowCredentials.map((credential) => credential.id)).toEqual([person.credentialId]);
    const [row] = await getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.challenge, challenge));
    expect(row).toMatchObject({ type: 'authentication', userId: person.id, used: false });
  });

  it('deletes the account with a fresh assertion made on auth.oxy.so', async () => {
    const person = await passkeyAccount();
    const { challenge } = await options();

    const res = await call('DELETE', '/users/me', { confirmText: person.username, assertion: assertion(person.credentialId, challenge) });

    expect(res.status).toBe(200);
    expect(await accountExists(person.id)).toBe(false);
  });

  it('refuses without an assertion', async () => {
    const person = await passkeyAccount();
    const res = await call('DELETE', '/users/me', { confirmText: person.username });
    expect(res.status).toBe(400);
    expect(await accountExists(person.id)).toBe(true);
  });

  it('refuses an assertion made on another origin', async () => {
    const person = await passkeyAccount();
    const { challenge } = await options();

    const elsewhere = await call('DELETE', '/users/me', {
      confirmText: person.username,
      assertion: assertion(person.credentialId, challenge, 'https://mention.oxy.so'),
    });
    expect(elsewhere.status).toBe(401);
    expect(await accountExists(person.id)).toBe(true);
  });

  it('refuses a challenge minted for another account', async () => {
    const other = await passkeyAccount();
    const { challenge } = await options();
    const person = await passkeyAccount();

    const res = await call('DELETE', '/users/me', { confirmText: person.username, assertion: assertion(person.credentialId, challenge) });

    expect(res.status).toBe(401);
    expect(await accountExists(person.id)).toBe(true);
    expect(await accountExists(other.id)).toBe(true);
  });

  it('checks the confirmation before spending the challenge', async () => {
    const person = await passkeyAccount();
    const { challenge } = await options();

    const typo = await call('DELETE', '/users/me', { confirmText: 'someone-else', assertion: assertion(person.credentialId, challenge) });
    expect(typo.status).toBe(400);
    const [row] = await getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.challenge, challenge));
    expect(row.used).toBe(false);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it('sends a Commons account to its key instead', async () => {
    await passkeyAccount({ publicKey: `04${'d'.repeat(128)}` });
    const res = await call('POST', '/users/me/delete/options');
    expect(res.status).toBe(400);
  });
});
