/**
 * ADR 0029 D2 — every official web app shares the browser's ONE DeviceSession,
 * end to end: `POST /auth/oauth/token` joins it, `POST /session/device/token`
 * mints from it, against a REAL Postgres.
 *
 * `auth.oxy.so` signs in first and holds a credential. Each official app that
 * then exchanges a code carrying that browser's `deviceId` joins the same
 * device and receives its OWN holder credential. The single rotating secret
 * this replaced handed every earlier holder a 60-second grace and then
 * `invalid_device_secret`, so the second app to sign in signed the first one
 * (and `auth.oxy.so`) out a minute later.
 *
 * Real: the token route, `deviceLogin.service`, `deviceSession.service`, the
 * mint route and every row they write. Mocked: `session.service` (a
 * collaborator with its own suite — it hands out sessions on the requested
 * device and names each token after its session), `exchangeAuthCode`
 * (`auth_codes` is its own port), and the out-of-process edges.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockExchangeAuthCode = jest.fn();
const mockCreateSession = jest.fn();
const mockGetAccessToken = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => null,
  extractOAuthUserinfoToken: () => null,
  decodeToken: () => null,
  validateSessionToken: jest.fn(),
}));
jest.mock('../../services/oauthCode.service', () => {
  const actual = jest.requireActual<typeof import('../../services/oauthCode.service')>(
    '../../services/oauthCode.service',
  );
  return {
    ...actual,
    issueAuthCode: jest.fn(),
    exchangeAuthCode: (...args: unknown[]) => mockExchangeAuthCode(...args),
  };
});
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
    validateSessionById: jest.fn().mockResolvedValue({ session: {} }),
    deactivateSession: jest.fn().mockResolvedValue(true),
    getSession: jest.fn().mockResolvedValue({ operatedByUserId: null }),
  },
}));
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: jest.fn().mockResolvedValue({ locked: false, attempts: 0 }),
  reserveAttempt: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...args: unknown[]) => mockBroadcast(...args),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import deviceSessionService from '../../services/deviceSession.service';
import authRouter from '../auth';
import sessionDeviceRouter from '../sessionDevice';

const REDIRECT_URI = 'https://app.example/oauth/callback';
const CODE_VERIFIER = 'a'.repeat(64);

let server: http.Server;

function post(path: string, body: string, contentType: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function user(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A registered OFFICIAL app — the lane that joins the browser's device. */
async function officialApp(): Promise<string> {
  const owner = await user();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `Official ${randomUUID()}`,
      type: 'first_party',
      isOfficial: true,
      redirectUris: [REDIRECT_URI],
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
  return clientId;
}

/** One official app's popup sign-in: redeem a code minted on this browser's device. */
async function join(clientId: string, deviceId: string, userId: string) {
  mockExchangeAuthCode.mockResolvedValueOnce({
    ok: true,
    code: { userId, deviceId, operatedByUserId: null, scopes: [] },
  });
  const res = await post(
    '/auth/oauth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: `code-${randomUUID()}`,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    }).toString(),
    'application/x-www-form-urlencoded',
  );
  expect(res.status).toBe(200);
  expect(res.body.deviceId).toBe(deviceId);
  return res.body.deviceSecret as string;
}

function mint(deviceId: string, deviceSecret: string) {
  return post('/session/device/token', JSON.stringify({ deviceId, deviceSecret }), 'application/json');
}

/** A browser where auth.oxy.so has signed `accountIds` in and holds its own credential. */
async function browser(accountIds: string[]): Promise<{ deviceId: string; authSecret: string }> {
  const deviceId = `browser-${randomUUID()}`;
  for (const accountId of accountIds) {
    await deviceSessionService.addAccount(deviceId, { accountId, sessionId: `s-${randomUUID()}` });
  }
  const authSecret = await deviceSessionService.issueDeviceSecret(deviceId);
  if (!authSecret) throw new Error('fixture: no credential for auth.oxy.so');
  return { deviceId, authSecret };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/auth', authRouter);
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
  jest.clearAllMocks();
  // A session on exactly the device the route asked for, as the real service does.
  mockCreateSession.mockImplementation((_userId: string, _req: unknown, options: { deviceId?: string }) =>
    Promise.resolve({ sessionId: `s-${randomUUID()}`, deviceId: options.deviceId ?? `own-${randomUUID()}` }),
  );
  mockGetAccessToken.mockImplementation((sessionId: string) =>
    Promise.resolve({ accessToken: `jwt-${sessionId}`, expiresAt: new Date('2030-01-01T00:00:00.000Z') }),
  );
});

describe('official apps joining one browser DeviceSession (ADR 0029 D2)', () => {
  it('two joins keep auth.oxy.so and both apps minting', async () => {
    const alice = await user();
    const { deviceId, authSecret } = await browser([alice]);

    const mentionSecret = await join(await officialApp(), deviceId, alice);
    const aliaSecret = await join(await officialApp(), deviceId, alice);

    expect(new Set([authSecret, mentionSecret, aliaSecret]).size).toBe(3);
    for (const secret of [authSecret, mentionSecret, aliaSecret]) {
      const res = await mint(deviceId, secret);
      expect(res.status).toBe(200);
      const data = res.body.data as { nextDeviceSecret: string; state: { activeAccountId: string } };
      expect(data.nextDeviceSecret).toBe(secret);
      expect(data.state.activeAccountId).toBe(alice);
    }
  });

  it('a single-account sign-out keeps every holder minting for the remaining account', async () => {
    const alice = await user();
    const bob = await user();
    const { deviceId, authSecret } = await browser([alice, bob]);
    const mentionSecret = await join(await officialApp(), deviceId, alice);
    const aliaSecret = await join(await officialApp(), deviceId, alice);

    await deviceSessionService.signout(deviceId, { accountId: alice });

    for (const secret of [authSecret, mentionSecret, aliaSecret]) {
      const res = await mint(deviceId, secret);
      expect(res.status).toBe(200);
      const state = (res.body.data as { state: { accounts: { accountId: string }[]; activeAccountId: string } }).state;
      expect(state.accounts.map((a) => a.accountId)).toEqual([bob]);
      expect(state.activeAccountId).toBe(bob);
    }
  });

  it('signing out the last account revokes every holder', async () => {
    const alice = await user();
    const { deviceId, authSecret } = await browser([alice]);
    const mentionSecret = await join(await officialApp(), deviceId, alice);

    await deviceSessionService.signout(deviceId, { accountId: alice });

    for (const secret of [authSecret, mentionSecret]) {
      const res = await mint(deviceId, secret);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_device_secret');
    }
  });
});
