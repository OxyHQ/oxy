/**
 * `GET /session/device/directory` and `POST /session/device/activate` — the two
 * ADR 0002 endpoints, over real HTTP against a real Postgres.
 *
 * The sibling suite (`sessionDevice.test.ts`) mocks `session.service` because
 * the mint is its subject and the session minter is its collaborator. Here the
 * opposite is true: activation IS a session mint plus an authorization decision,
 * so both run for real and only the edges are mocked — the bearer/CSRF layers
 * (tested elsewhere; here they only have to name a caller), the Redis limiter,
 * and Socket.IO, which is mocked precisely so the BROADCASTS can be asserted.
 *
 * `jsonwebtoken` is restored to the real signer for the same reason the session
 * suite restores it: `sessions.access_token` is genuinely UNIQUE here and the
 * global constant-token mock makes the second mint of the suite collide.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

const mockAuthMiddleware = jest.fn();
const mockDecodeToken = jest.fn();
const mockBroadcast = jest.fn();
const mockBroadcastAccounts = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...a: unknown[]) => mockAuthMiddleware(...a),
}));
jest.mock('../../middleware/originGuard', () => ({
  requireSameSiteOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/authUtils', () => ({
  decodeToken: (...a: unknown[]) => mockDecodeToken(...a),
  extractTokenFromRequest: () => 'tkn',
}));
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: jest.fn().mockResolvedValue({ locked: false, attempts: 0 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...a: unknown[]) => mockBroadcast(...a),
  broadcastSessionAccountsChanged: (...a: unknown[]) => mockBroadcastAccounts(...a),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { deviceActivateResponseSchema, deviceDirectorySchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { devicePrincipals } from '../../db/schema/devicePrincipals';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import deviceSessionService from '../../services/deviceSession.service';
import sessionService from '../../services/session.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import sessionDeviceRouter from '../sessionDevice';
import { errorHandler } from '../../middleware/errorHandler';

let server: http.Server;
let callerAccountId = '';
let callerSessionId = 's1';
let callerDeviceId = 'd1';

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

async function organization(operatorId: string): Promise<string> {
  const orgId = await account({ kind: 'organization', username: `org-${randomUUID().slice(0, 8)}` });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: orgId, memberUserId: operatorId, role: 'admin', status: 'active' });
  return orgId;
}

/** Sign a person in on a device and make the mocked bearer name them. */
async function signIn(deviceId: string, userId: string): Promise<string> {
  const session = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    { deviceId }
  );
  await deviceSessionService.addAccount(deviceId, { accountId: userId, sessionId: session.sessionId });
  return session.sessionId;
}

function callerIs(deviceId: string, accountId: string, sessionId: string): void {
  callerDeviceId = deviceId;
  callerAccountId = accountId;
  callerSessionId = sessionId;
}

async function requestJson(method: string, path: string, payload?: unknown) {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          Authorization: 'Bearer t',
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

async function storedContextIds(deviceId: string): Promise<string[]> {
  const [device] = await getDb()
    .select({ id: deviceSessions.id })
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId))
    .limit(1);
  const rows = await getDb()
    .select({ id: deviceAccountContexts.id })
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
  return rows.map((row) => row.id);
}

/** The directory as the endpoint itself reports it. */
async function directory(): Promise<ReturnType<typeof deviceDirectorySchema.parse>> {
  const res = await requestJson('GET', '/session/device/directory');
  return deviceDirectorySchema.parse((res.body as { data: unknown }).data);
}

function contextFor(
  tree: ReturnType<typeof deviceDirectorySchema.parse>,
  principalUserId: string,
  accountId: string
) {
  return tree.principals
    .find((principal) => principal.userId === principalUserId)
    ?.contexts.find((context) => context.accountId === accountId);
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  mockAuthMiddleware.mockImplementation((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: { toString: () => callerAccountId }, id: callerAccountId };
    next();
  });
  mockDecodeToken.mockImplementation(() => ({ sessionId: callerSessionId, deviceId: callerDeviceId }));
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
  jest.clearAllMocks();
  sessionCache.clear();
  userCache.clear();
});

describe('GET /session/device/directory', () => {
  it('serves the contract shape for the caller’s own device', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const org = await organization(nate);
    callerIs(device, nate, await signIn(device, nate));

    const res = await requestJson('GET', '/session/device/directory');

    expect(res.status).toBe(200);
    const parsed = deviceDirectorySchema.safeParse((res.body as { data: unknown }).data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.deviceId).toBe(device);
    expect(contextFor(parsed.data, nate, org)).toBeDefined();
  });

  it('refuses a bearer that names no device', async () => {
    callerIs('', await account(), 's');
    mockDecodeToken.mockReturnValueOnce({ sessionId: 's' });

    const res = await requestJson('GET', '/session/device/directory');

    expect(res.status).toBe(401);
  });

  it('reads only the device the bearer names — never one from the request', async () => {
    const mine = `dev-${randomUUID()}`;
    const theirs = `dev-${randomUUID()}`;
    const nate = await account();
    const alice = await account();
    callerIs(theirs, alice, await signIn(theirs, alice));
    callerIs(mine, nate, await signIn(mine, nate));

    const tree = await directory();

    expect(tree.deviceId).toBe(mine);
    expect(tree.principals.map((principal) => principal.userId)).toEqual([nate]);
  });
});

describe('POST /session/device/activate', () => {
  it('activates a context, returns the directory plus a bearer, and broadcasts once', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const org = await organization(nate);
    callerIs(device, nate, await signIn(device, nate));
    const contextId = contextFor(await directory(), nate, org)?.id ?? '';
    jest.clearAllMocks();

    const res = await requestJson('POST', '/session/device/activate', { contextId });

    expect(res.status).toBe(200);
    const parsed = deviceActivateResponseSchema.safeParse((res.body as { data: unknown }).data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.directory.activeContextId).toBe(contextId);
    expect(parsed.data.activeToken?.accessToken).toEqual(expect.any(String));
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(org, expect.any(Number), 'switch');
  });

  it('broadcasts NOTHING when the target is already the active context', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const org = await organization(nate);
    callerIs(device, nate, await signIn(device, nate));
    const contextId = contextFor(await directory(), nate, org)?.id ?? '';
    await requestJson('POST', '/session/device/activate', { contextId });
    jest.clearAllMocks();

    const res = await requestJson('POST', '/session/device/activate', { contextId });

    expect(res.status).toBe(200);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
  });

  it('refuses an accountId in the body instead of falling back to switch semantics', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const bare = await requestJson('POST', '/session/device/activate', { accountId: nate });
    const smuggled = await requestJson('POST', '/session/device/activate', {
      contextId: contextFor(await directory(), nate, nate)?.id,
      accountId: nate,
    });

    expect(bare.status).toBe(400);
    expect(bare.body).toEqual({ error: 'accountId_not_accepted' });
    // Even beside a valid contextId: an account id cannot name a context, and
    // accepting it here would be a silent second identifier on the wire.
    expect(smuggled.status).toBe(400);
    expect(smuggled.body).toEqual({ error: 'accountId_not_accepted' });
  });

  it('400s a body with no contextId at all', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const res = await requestJson('POST', '/session/device/activate', {});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'contextId required' });
  });

  it('404s a context that is not on this device', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const res = await requestJson('POST', '/session/device/activate', { contextId: randomUUID() });

    expect(res.status).toBe(404);
  });

  it('403s a revoked target and broadcasts the HEALED device state', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const org = await organization(nate);
    callerIs(device, nate, await signIn(device, nate));
    const contextId = contextFor(await directory(), nate, org)?.id ?? '';
    await requestJson('POST', '/session/device/activate', { contextId });
    await getDb().delete(accountMembers).where(eq(accountMembers.accountId, org));
    sessionCache.clear();
    jest.clearAllMocks();

    const res = await requestJson('POST', '/session/device/activate', { contextId });

    expect(res.status).toBe(403);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(org, expect.any(Number), 'revoke');
    expect(await storedContextIds(device)).not.toContain(contextId);
  });
});

describe('POST /session/device/signout — the removal meanings', () => {
  it('removes ONE context and leaves the other person’s route to the same account', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const alice = await account();
    const org = await organization(nate);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org, memberUserId: alice, role: 'admin', status: 'active' });
    callerIs(device, alice, await signIn(device, alice));
    callerIs(device, nate, await signIn(device, nate));
    const tree = await directory();
    const viaNate = contextFor(tree, nate, org)?.id ?? '';
    const viaAlice = contextFor(tree, alice, org)?.id ?? '';
    jest.clearAllMocks();

    const res = await requestJson('POST', '/session/device/signout', { contextId: viaNate });

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const remaining = await storedContextIds(device);
    expect(remaining).not.toContain(viaNate);
    expect(remaining).toContain(viaAlice);
  });

  it('removes ONE principal and nobody else', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    const alice = await account();
    callerIs(device, alice, await signIn(device, alice));
    callerIs(device, nate, await signIn(device, nate));
    const natePrincipal = (await directory()).principals.find(
      (principal) => principal.userId === nate
    );

    const res = await requestJson('POST', '/session/device/signout', {
      principalId: natePrincipal?.id,
    });

    expect(res.status).toBe(200);
    const principals = await getDb()
      .select({ userId: devicePrincipals.userId })
      .from(devicePrincipals)
      .innerJoin(deviceSessions, eq(devicePrincipals.deviceSessionId, deviceSessions.id))
      .where(eq(deviceSessions.deviceId, device));
    expect(principals.map((row) => row.userId)).toEqual([alice]);
  });

  it('refuses a body that asks for both, because they are different operations', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const res = await requestJson('POST', '/session/device/signout', {
      contextId: 'a',
      principalId: 'b',
    });

    expect(res.status).toBe(400);
  });

  it('404s a context that is not on this device', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const res = await requestJson('POST', '/session/device/signout', { contextId: randomUUID() });

    expect(res.status).toBe(404);
  });

  it('leaves the FLAT accountId and all meanings untouched', async () => {
    const device = `dev-${randomUUID()}`;
    const nate = await account();
    callerIs(device, nate, await signIn(device, nate));

    const byAccount = await requestJson('POST', '/session/device/signout', { accountId: nate });
    expect(byAccount.status).toBe(200);
    expect((byAccount.body as { data: { state: { accounts: unknown[] } } }).data.state.accounts).toEqual(
      []
    );

    const nothing = await requestJson('POST', '/session/device/signout', {});
    expect(nothing.status).toBe(400);

    const all = await requestJson('POST', '/session/device/signout', { all: true });
    expect(all.status).toBe(200);
  });
});
