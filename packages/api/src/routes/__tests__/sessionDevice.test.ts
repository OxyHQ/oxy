/**
 * `/session/device/*` — the zero-cookie mint — against a REAL Postgres.
 *
 * The previous suite mocked `deviceSession.service` wholesale, so every
 * assertion about the mint was really an assertion about a `jest.fn()`: it
 * proved the ROUTE called the service it was told to call, and nothing at all
 * about whether a wrong secret is actually rejected, whether a mint actually
 * leaves every holder's credential intact, or whether a pinned mint actually
 * leaves `active_account_id` alone. Those are the properties this endpoint
 * exists to hold, and they live in stored rows.
 *
 * So the real `deviceSession.service` runs here against the throwaway database
 * and the assertions read Postgres directly. What stays mocked is deliberate
 * and narrow:
 *
 *  - `session.service` — a COLLABORATOR (token minting, session validation and
 *    deactivation), not the subject, and its own port is a separate file. It is
 *    mocked to the FLAT row shape the port produces: `operatedByUserId` is a
 *    plain `string | null`, never a `Types.ObjectId`.
 *  - `middleware/auth`, `middleware/authUtils`, `middleware/originGuard` — the
 *    bearer/JWT/CSRF layers, tested elsewhere; here they only have to name a
 *    caller.
 *  - `middleware/rateLimiter` (Redis), `utils/socket` (Socket.IO), `utils/logger`
 *    — out-of-process edges.
 *
 * Nothing about the DATA path is mocked. Every test mints its own device id and
 * its own `users` rows, so no assertion depends on a table being empty — the
 * suite shares one database with the rest of the run, and
 * `device_session_accounts` carries real foreign keys to `users`.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const mockAuthMiddleware = jest.fn();
const mockDecodeToken = jest.fn();
const mockGetSession = jest.fn();
const mockValidateSessionById = jest.fn();
const mockGetAccessToken = jest.fn();
const mockDeactivateSession = jest.fn();
const mockBroadcast = jest.fn();
const mockBroadcastAccounts = jest.fn();
const mockIsLockedOut = jest.fn();
const mockRecordFailure = jest.fn();
const mockClearFailures = jest.fn();

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
// The flat Drizzle contract: `getSession` returns a `sessions` ROW, so
// `operatedByUserId` is `string | null` — no ObjectId, no `.toString()`.
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    getSession: (...a: unknown[]) => mockGetSession(...a),
    validateSessionById: (...a: unknown[]) => mockValidateSessionById(...a),
    getAccessToken: (...a: unknown[]) => mockGetAccessToken(...a),
    deactivateSession: (...a: unknown[]) => mockDeactivateSession(...a),
  },
}));
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: (...a: unknown[]) => mockIsLockedOut(...a),
  recordFailure: (...a: unknown[]) => mockRecordFailure(...a),
  clearFailures: (...a: unknown[]) => mockClearFailures(...a),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...a: unknown[]) => mockBroadcast(...a),
  broadcastSessionAccountsChanged: (...a: unknown[]) => mockBroadcastAccounts(...a),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { deviceTokenMintResponseSchema } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { devicePrincipals } from '../../db/schema/devicePrincipals';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import deviceSessionService from '../../services/deviceSession.service';
import sessionDeviceRouter from '../sessionDevice';
import { errorHandler } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

/** A real `users` row — `device_session_accounts.account_id` has a real FK. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A device id unique to one test, so the shared database never cross-talks. */
function newDeviceId(): string {
  return `dev-${randomUUID()}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The stored device row, read straight from Postgres (not through the service). */
async function storedDevice(device: string) {
  const [row] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, device))
    .limit(1);
  return row;
}

/** The device's stored holder-credential hashes, sorted, read straight from Postgres. */
async function storedHashes(device: string): Promise<string[]> {
  const rows = await getDb()
    .select({ secretHash: deviceCredentials.secretHash })
    .from(deviceCredentials)
    .innerJoin(deviceSessions, eq(deviceCredentials.deviceSessionId, deviceSessions.id))
    .where(eq(deviceSessions.deviceId, device));
  return rows.map((row) => row.secretHash).sort();
}

/**
 * The stored account rows for a device, in the service's own read order.
 *
 * Read straight from Postgres, never through the service — which is the whole
 * point of this helper, and why it names `device_principals` and
 * `device_account_contexts` since issue #937 moved the storage there.
 *
 * `operatedByUserId` is DERIVED from the stored principal (a context whose
 * principal is somebody other than the account it names IS the delegated case),
 * so an assertion on it still proves the operator was persisted: the value comes
 * out of a `device_principals` row, not out of the service's projection.
 */
async function storedAccounts(device: string) {
  const row = await storedDevice(device);
  const contexts = await getDb()
    .select({
      accountId: deviceAccountContexts.accountId,
      sessionId: deviceAccountContexts.sessionId,
      authuser: devicePrincipals.authuser,
      principalUserId: devicePrincipals.userId,
    })
    .from(deviceAccountContexts)
    .innerJoin(devicePrincipals, eq(deviceAccountContexts.principalId, devicePrincipals.id))
    .where(eq(deviceAccountContexts.deviceSessionId, row.id))
    .orderBy(deviceAccountContexts.addedAt, devicePrincipals.authuser, deviceAccountContexts.id);
  return contexts.map((context) => ({
    ...context,
    operatedByUserId:
      context.principalUserId === context.accountId ? null : context.principalUserId,
  }));
}

/**
 * A device carrying one signed-in account and a live `deviceSecret`.
 *
 * Built through the real service, so the row under test is the one production
 * writes — the raw secret is returned exactly once, exactly as a client gets it.
 */
async function deviceWithSecret(): Promise<{ deviceId: string; accountId: string; secret: string }> {
  const deviceId = newDeviceId();
  const accountId = await account();
  await deviceSessionService.addAccount(deviceId, { accountId, sessionId: `s-${randomUUID()}` });
  const secret = await deviceSessionService.issueDeviceSecret(deviceId);
  if (!secret) throw new Error('failed to issue a device secret for the fixture');
  return { deviceId, accountId, secret };
}

async function requestJson(
  method: string,
  path: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
) {
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
          ...(extraHeaders ?? {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server: http.Server;
/** The account the mocked bearer layer names as the caller. Set per test. */
let callerAccountId = '';
/** The `sessionId` claim the mocked bearer layer carries. Set per test. */
let callerSessionId = 's1';
/** The `deviceId` claim the mocked bearer layer carries. Set per test. */
let callerDeviceId = 'd1';

beforeAll(async () => {
  await connectPostgres();
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
  // A live session by default: `resolveTokenForAccount` validates then mints.
  mockValidateSessionById.mockResolvedValue({ session: {} });
  mockGetAccessToken.mockResolvedValue({
    accessToken: 'jwt-active',
    expiresAt: new Date('2026-07-07T00:00:00.000Z'),
  });
  mockDeactivateSession.mockResolvedValue(true);
  // The FLAT row shape: a personal session's `operatedByUserId` is `null`.
  mockGetSession.mockResolvedValue({ operatedByUserId: null });
  mockIsLockedOut.mockResolvedValue({ locked: false, attempts: 0 });
  mockRecordFailure.mockResolvedValue({ locked: false, attempts: 1 });
  mockClearFailures.mockResolvedValue(undefined);
});

describe('POST /session/device/token — the public deviceSecret mint', () => {
  it('mints an access token, preserves the shared device secret, and returns the wire shape the SDK parses', async () => {
    const { deviceId, accountId, secret } = await deviceWithSecret();
    const hashesBefore = await storedHashes(deviceId);

    const res = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });

    expect(res.status).toBe(200);
    const data = res.body.data;
    // Wire parity is asserted against the SAME schema the SDK uses, not a
    // hand-written copy that could drift from it.
    expect(deviceTokenMintResponseSchema.safeParse(data).success).toBe(true);
    expect((data as { accessToken: string }).accessToken).toBe('jwt-active');
    expect((data as { state: { activeAccountId: string } }).state.activeAccountId).toBe(accountId);

    // The credential is stable: separate official app origins can mint
    // concurrently without invalidating one another.
    const nextSecret = (data as { nextDeviceSecret: string }).nextDeviceSecret;
    expect(nextSecret).toBe(secret);
    expect(hashesBefore).toEqual([sha256(secret)]);
    expect(await storedHashes(deviceId)).toEqual(hashesBefore);

    // The raw secret is never logged — only the lane and the device id.
    expect(logger.info).toHaveBeenCalledWith('device.token.mint', {
      mint_source: 'secret',
      deviceId,
    });
  });

  it('REJECTS a wrong secret for a device that has a live one — 401, no rotation, failure recorded', async () => {
    const { deviceId, secret } = await deviceWithSecret();

    const res = await requestJson('POST', '/session/device/token', {
      deviceId,
      deviceSecret: `${secret}-tampered`,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    // The stored secret is untouched: a guess must not consume the real one.
    expect(await storedHashes(deviceId)).toEqual([sha256(secret)]);
    expect(mockRecordFailure).toHaveBeenCalledWith({ scope: 'device-token', identifier: deviceId });
    expect(mockClearFailures).not.toHaveBeenCalled();
  });

  it("REJECTS another device's valid secret — possession of a deviceId proves nothing", async () => {
    const victim = await deviceWithSecret();
    const attacker = await deviceWithSecret();

    const res = await requestJson('POST', '/session/device/token', {
      deviceId: victim.deviceId,
      deviceSecret: attacker.secret,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    expect(await storedHashes(victim.deviceId)).toEqual([sha256(victim.secret)]);
  });

  it('the same credential mints again and again (several tabs of one holder)', async () => {
    const { deviceId, secret } = await deviceWithSecret();

    const first = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });
    expect(first.status).toBe(200);

    const second = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });
    expect(second.status).toBe(200);
    expect((second.body.data as { accessToken: string }).accessToken).toBe('jwt-active');
  });

  it('a second holder joining never locks the first out (ADR 0029 D2)', async () => {
    // auth.oxy.so holds the first credential; an official app then joins the
    // same browser device and gets its own. The single rotating secret this
    // replaced left the first holder a 60s grace, then 401.
    const { deviceId, secret: authSecret } = await deviceWithSecret();
    const appSecret = await deviceSessionService.issueDeviceSecret(deviceId);
    await getDb()
      .update(deviceCredentials)
      .set({ createdAt: new Date(Date.now() - 3_600_000), lastUsedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(deviceCredentials.secretHash, sha256(authSecret)));

    for (const deviceSecret of [authSecret, appSecret as string]) {
      const res = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret });
      expect(res.status).toBe(200);
      expect((res.body.data as { nextDeviceSecret: string }).nextDeviceSecret).toBe(deviceSecret);
    }
  });

  it('401 no_active_session WITHOUT rotating when the secret is valid but the session is dead', async () => {
    const { deviceId, secret } = await deviceWithSecret();
    // A session that cannot mint IS the dead session: `getAccessToken` re-reads
    // the row and re-checks the operator's act_as, and is the only authority
    // `resolveTokenForSession` consults.
    mockGetAccessToken.mockResolvedValue(null);

    const res = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_active_session');
    // The client keeps a still-valid secret and re-authenticates.
    expect(await storedHashes(deviceId)).toEqual([sha256(secret)]);
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'device-token', identifier: deviceId });
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('401s an unknown device without creating a row for it', async () => {
    const ghost = newDeviceId();

    const res = await requestJson('POST', '/session/device/token', {
      deviceId: ghost,
      deviceSecret: 'anything',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    // A mint must never bring a device row into existence.
    expect(await storedDevice(ghost)).toBeUndefined();
  });

  it('429 when the device is locked out — never touches the secret', async () => {
    const { deviceId, secret } = await deviceWithSecret();
    mockIsLockedOut.mockResolvedValueOnce({ locked: true, retryAfterSeconds: 42, attempts: 5 });

    const res = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });

    expect(res.status).toBe(429);
    expect(await storedHashes(deviceId)).toEqual([sha256(secret)]);
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('400 when the body shape is invalid (missing deviceSecret) — before any lockout read', async () => {
    const res = await requestJson('POST', '/session/device/token', { deviceId: 'd1' });
    expect(res.status).toBe(400);
    expect(mockIsLockedOut).not.toHaveBeenCalled();
  });

  it('400 when accountId is present but empty (schema requires min(1))', async () => {
    const res = await requestJson('POST', '/session/device/token', {
      deviceId: 'd1',
      deviceSecret: 'raw',
      accountId: '',
    });
    expect(res.status).toBe(400);
    expect(mockIsLockedOut).not.toHaveBeenCalled();
  });

  it('signout-all revokes the deviceSecret: a retained secret no longer mints', async () => {
    const { deviceId, secret } = await deviceWithSecret();

    await deviceSessionService.signout(deviceId, { all: true });
    expect(await storedHashes(deviceId)).toEqual([]);

    const res = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret: secret });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
  });
});

describe('POST /session/device/token — pinned mint (identity-bound clients)', () => {
  /** A device with TWO accounts: `active` is what other apps selected, `pinned` is the identity's own. */
  async function twoAccountDevice() {
    const deviceId = newDeviceId();
    const pinned = await account();
    const active = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: pinned, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, { accountId: active, sessionId: `s-${randomUUID()}` });
    const secret = await deviceSessionService.issueDeviceSecret(deviceId);
    if (!secret) throw new Error('failed to issue a device secret for the fixture');
    return { deviceId, pinned, active, secret };
  }

  it('mints the PINNED account and leaves active_account_id / revision untouched in Postgres', async () => {
    const { deviceId, pinned, active, secret } = await twoAccountDevice();
    const before = await storedDevice(deviceId);
    expect(before.activeAccountId).toBe(active);
    // Name the token after the session it was minted for, so "which account did
    // this mint serve?" is answerable from the response rather than assumed.
    mockGetAccessToken.mockImplementation((sessionId: string) =>
      Promise.resolve({
        accessToken: `jwt-${sessionId}`,
        expiresAt: new Date('2026-07-07T00:00:00.000Z'),
      }),
    );

    const res = await requestJson('POST', '/session/device/token', {
      deviceId,
      deviceSecret: secret,
      accountId: pinned,
    });

    expect(res.status).toBe(200);
    // The token belongs to the PINNED account's session, not the active one.
    const pinnedSessionId = (await storedAccounts(deviceId)).find((a) => a.accountId === pinned)?.sessionId;
    expect((res.body.data as { accessToken: string }).accessToken).toBe(`jwt-${pinnedSessionId}`);

    // Read-only with respect to everything the other apps on this device see.
    const after = await storedDevice(deviceId);
    expect(after.activeAccountId).toBe(active);
    expect(after.revision).toBe(before.revision);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
    // The response reports the device's TRUE active account, not the pin.
    expect((res.body.data as { state: { activeAccountId: string } }).state.activeAccountId).toBe(active);
    expect(logger.info).toHaveBeenCalledWith('device.token.mint', {
      mint_source: 'secret',
      deviceId,
      pinned: true,
    });
  });

  it('401 account_not_on_device for an account that is not registered — no rotation, no lockout failure', async () => {
    const { deviceId, secret } = await twoAccountDevice();
    const stranger = await account();

    const res = await requestJson('POST', '/session/device/token', {
      deviceId,
      deviceSecret: secret,
      accountId: stranger,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
    expect(await storedHashes(deviceId)).toEqual([sha256(secret)]);
    // The secret was proven — a bad pin must never count as secret guessing.
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'device-token', identifier: deviceId });
  });

  it('answers the SAME error when the pinned member exists but its session is dead (no existence oracle)', async () => {
    const { deviceId, pinned, secret } = await twoAccountDevice();
    // A session that cannot mint IS the dead session: `getAccessToken` re-reads
    // the row and re-checks the operator's act_as, and is the only authority
    // `resolveTokenForSession` consults.
    mockGetAccessToken.mockResolvedValue(null);

    const res = await requestJson('POST', '/session/device/token', {
      deviceId,
      deviceSecret: secret,
      accountId: pinned,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
  });

  it('a bad pin on an INVALID secret is still the plain invalid_device_secret lane', async () => {
    const { deviceId, pinned } = await twoAccountDevice();

    const res = await requestJson('POST', '/session/device/token', {
      deviceId,
      deviceSecret: 'not-the-secret',
      accountId: pinned,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    expect(mockRecordFailure).toHaveBeenCalledWith({ scope: 'device-token', identifier: deviceId });
  });
});

describe('POST /session/device/add', () => {
  it('stores operated_by_user_id as NULL for an ordinary personal session', async () => {
    const deviceId = newDeviceId();
    callerDeviceId = deviceId;
    callerAccountId = await account();
    callerSessionId = `s-${randomUUID()}`;
    mockGetSession.mockResolvedValueOnce({ operatedByUserId: null });

    const res = await requestJson('POST', '/session/device/add', {});

    expect(res.status).toBe(200);
    const [row] = await storedAccounts(deviceId);
    expect(row.accountId).toBe(callerAccountId);
    // NULL is the whole distinction between a personal and a delegated entry —
    // never `''`, which would read as "delegated, operated by nobody".
    expect(row.operatedByUserId).toBeNull();
    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(callerAccountId, expect.any(Number), 'add');
  });

  it('stores the operator id for a DELEGATED (act_as) session, read from the session ROW', async () => {
    const deviceId = newDeviceId();
    callerDeviceId = deviceId;
    callerAccountId = await account();
    callerSessionId = `s-${randomUUID()}`;
    const operator = await account();
    // The flat contract: a plain string id, not an ObjectId.
    mockGetSession.mockResolvedValueOnce({ operatedByUserId: operator });

    const res = await requestJson('POST', '/session/device/add', {});

    expect(res.status).toBe(200);
    const [row] = await storedAccounts(deviceId);
    expect(row.operatedByUserId).toBe(operator);
  });

  it('401s and writes nothing when the session record is expired/revoked', async () => {
    const deviceId = newDeviceId();
    callerDeviceId = deviceId;
    callerAccountId = await account();
    callerSessionId = `s-${randomUUID()}`;
    mockGetSession.mockResolvedValueOnce(null);

    const res = await requestJson('POST', '/session/device/add', {});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid session');
    // No device row is created for a rejected add.
    expect(await storedDevice(deviceId)).toBeUndefined();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('does NOT broadcast on an idempotent re-register (the cold-boot reload handoff)', async () => {
    const deviceId = newDeviceId();
    callerDeviceId = deviceId;
    callerAccountId = await account();
    callerSessionId = `s-${randomUUID()}`;

    const first = await requestJson('POST', '/session/device/add', {});
    expect(first.status).toBe(200);
    const revisionAfterFirst = (await storedDevice(deviceId)).revision;
    mockBroadcast.mockClear();
    mockBroadcastAccounts.mockClear();

    const second = await requestJson('POST', '/session/device/add', {});

    expect(second.status).toBe(200);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
    expect((await storedDevice(deviceId)).revision).toBe(revisionAfterFirst);
  });
});

describe('GET /session/device/state', () => {
  it('returns the device subset without minting an active-account token', async () => {
    const { deviceId, accountId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    callerAccountId = accountId;

    const res = await requestJson('GET', '/session/device/state');

    expect(res.status).toBe(200);
    const data = res.body.data as {
      state: { deviceId: string; activeAccountId: string; accounts: unknown[] };
      activeToken: null;
    };
    expect(data.state.deviceId).toBe(deviceId);
    expect(data.state.activeAccountId).toBe(accountId);
    expect(data.state.accounts).toHaveLength(1);
    expect(data.activeToken).toBeNull();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });
});

describe('POST /session/device/switch', () => {
  it('switches the active account, bumps the stored revision, and broadcasts', async () => {
    const deviceId = newDeviceId();
    const first = await account();
    const second = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: first, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, { accountId: second, sessionId: `s-${randomUUID()}` });
    callerDeviceId = deviceId;
    const before = await storedDevice(deviceId);

    const res = await requestJson('POST', '/session/device/switch', { accountId: first });

    expect(res.status).toBe(200);
    expect(res.body.data.activeToken).toBeNull();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    const after = await storedDevice(deviceId);
    expect(after.activeAccountId).toBe(first);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(first, after.revision, 'switch');
  });

  it('404 for an account that is not on the device — nothing is written', async () => {
    const { deviceId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    const stranger = await account();
    const before = await storedDevice(deviceId);

    const res = await requestJson('POST', '/session/device/switch', { accountId: stranger });

    expect(res.status).toBe(404);
    const after = await storedDevice(deviceId);
    expect(after.activeAccountId).toBe(before.activeAccountId);
    expect(after.revision).toBe(before.revision);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('403 and HEALS the device set when the target session is revoked (act_as membership pulled)', async () => {
    const deviceId = newDeviceId();
    const operator = await account();
    const org = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: operator, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, {
      accountId: org,
      sessionId: `s-${randomUUID()}`,
      operatedByUserId: operator,
    });
    // Make the org account the non-active one so the switch is a real switch.
    await deviceSessionService.switchActive(deviceId, operator);
    callerDeviceId = deviceId;
    mockValidateSessionById.mockResolvedValue(null);

    const res = await requestJson('POST', '/session/device/switch', { accountId: org });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Account not authorized');
    // The revoked account is gone from the stored set, not merely rejected.
    const remaining = (await storedAccounts(deviceId)).map((a) => a.accountId);
    expect(remaining).not.toContain(org);
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(org, expect.any(Number), 'revoke');
  });

  it('400 when accountId is missing', async () => {
    const { deviceId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    const res = await requestJson('POST', '/session/device/switch', {});
    expect(res.status).toBe(400);
  });
});

describe('POST /session/device/signout', () => {
  it('removes one account, elects the next active, and signals only the removed user', async () => {
    const deviceId = newDeviceId();
    const first = await account();
    const second = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: first, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, { accountId: second, sessionId: `s-${randomUUID()}` });
    callerDeviceId = deviceId;

    const res = await requestJson('POST', '/session/device/signout', { accountId: second });

    expect(res.status).toBe(200);
    const remaining = (await storedAccounts(deviceId)).map((a) => a.accountId);
    expect(remaining).toEqual([first]);
    expect((await storedDevice(deviceId)).activeAccountId).toBe(first);
    expect(mockBroadcastAccounts).toHaveBeenCalledWith([second], expect.any(Number), 'signout');
  });

  it('signs out ALL and signals every removed user, including a cascaded managed account', async () => {
    const deviceId = newDeviceId();
    const operator = await account();
    const org = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: operator, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, {
      accountId: org,
      sessionId: `s-${randomUUID()}`,
      operatedByUserId: operator,
    });
    callerDeviceId = deviceId;

    const res = await requestJson('POST', '/session/device/signout', { all: true });

    expect(res.status).toBe(200);
    expect(await storedAccounts(deviceId)).toEqual([]);
    expect((await storedDevice(deviceId)).activeAccountId).toBeNull();
    const [signalled] = mockBroadcastAccounts.mock.calls.at(-1) as [string[], number, string];
    expect([...signalled].sort()).toEqual([operator, org].sort());
  });

  it('is SHARED: one app signing an account out leaves every holder minting for the rest (ADR 0029 D2)', async () => {
    const deviceId = newDeviceId();
    const alice = await account();
    const bob = await account();
    await deviceSessionService.addAccount(deviceId, { accountId: alice, sessionId: `s-${randomUUID()}` });
    await deviceSessionService.addAccount(deviceId, { accountId: bob, sessionId: `s-${randomUUID()}` });
    const authSecret = await deviceSessionService.issueDeviceSecret(deviceId);
    const mentionSecret = await deviceSessionService.issueDeviceSecret(deviceId);
    const aliaSecret = await deviceSessionService.issueDeviceSecret(deviceId);
    callerDeviceId = deviceId;

    // Signed out from one app…
    const res = await requestJson('POST', '/session/device/signout', { accountId: alice });
    expect(res.status).toBe(200);
    // …announced to the device room every holder's socket sits in…
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ deviceId, activeAccountId: bob }));

    // …and every holder, the signing-out one included, now mints Bob.
    for (const deviceSecret of [authSecret, mentionSecret, aliaSecret] as string[]) {
      const mint = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret });
      expect(mint.status).toBe(200);
      const state = (mint.body.data as { state: { accounts: { accountId: string }[]; activeAccountId: string } }).state;
      expect(state.accounts.map((a) => a.accountId)).toEqual([bob]);
      expect(state.activeAccountId).toBe(bob);
    }
  });

  it('signing out the LAST account signs every holder out', async () => {
    const { deviceId, accountId, secret: authSecret } = await deviceWithSecret();
    const appSecret = await deviceSessionService.issueDeviceSecret(deviceId);
    callerDeviceId = deviceId;

    const res = await requestJson('POST', '/session/device/signout', { accountId });
    expect(res.status).toBe(200);

    expect(await storedHashes(deviceId)).toEqual([]);
    for (const deviceSecret of [authSecret, appSecret as string]) {
      const mint = await requestJson('POST', '/session/device/token', { deviceId, deviceSecret });
      expect(mint.status).toBe(401);
      expect(mint.body.error).toBe('invalid_device_secret');
    }
  });

  it('removing the last CONTEXT signs every holder out too', async () => {
    const { deviceId, accountId } = await deviceWithSecret();
    await deviceSessionService.issueDeviceSecret(deviceId);
    const [context] = await getDb()
      .select({ id: deviceAccountContexts.id })
      .from(deviceAccountContexts)
      .where(eq(deviceAccountContexts.accountId, accountId));
    callerDeviceId = deviceId;

    const res = await requestJson('POST', '/session/device/signout', { contextId: context.id });
    expect(res.status).toBe(200);

    expect(await storedHashes(deviceId)).toEqual([]);
  });

  it('400 when neither accountId nor all is supplied', async () => {
    const { deviceId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    const res = await requestJson('POST', '/session/device/signout', {});
    expect(res.status).toBe(400);
  });
});

describe('POST /session/device/background-credential', () => {
  it('provisions a credential whose hash — never the raw secret — is what Postgres stores', async () => {
    const { deviceId, accountId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    callerAccountId = accountId;

    const res = await requestJson('POST', '/session/device/background-credential');

    expect(res.status).toBe(200);
    const credential = res.body.data as { secret: string; accountId: string; deviceId: string };
    expect(credential.accountId).toBe(accountId);
    const row = await storedDevice(deviceId);
    expect(row.backgroundSecretHash).toBe(sha256(credential.secret));
    expect(row.backgroundSecretAccountId).toBe(accountId);
    expect(row.backgroundSecretExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('401 account_not_on_device when the caller is not a live member of the device', async () => {
    const { deviceId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    callerAccountId = await account();

    const res = await requestJson('POST', '/session/device/background-credential');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
    expect((await storedDevice(deviceId)).backgroundSecretHash).toBeNull();
  });

  it('403 browser_not_allowed when Origin is present (native-only endpoint)', async () => {
    const { deviceId, accountId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    callerAccountId = accountId;

    const res = await requestJson('POST', '/session/device/background-credential', undefined, {
      Origin: 'https://accounts.oxy.so',
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('browser_not_allowed');
    expect((await storedDevice(deviceId)).backgroundSecretHash).toBeNull();
  });

  it('403 browser_not_allowed when Sec-Fetch-Site is present without Origin', async () => {
    const { deviceId, accountId } = await deviceWithSecret();
    callerDeviceId = deviceId;
    callerAccountId = accountId;

    const res = await requestJson('POST', '/session/device/background-credential', undefined, {
      'sec-fetch-site': 'same-origin',
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('browser_not_allowed');
    expect((await storedDevice(deviceId)).backgroundSecretHash).toBeNull();
  });
});

describe('POST /session/device/background-token', () => {
  /** A device holding a provisioned, non-rotating background credential. */
  async function deviceWithBackgroundCredential() {
    const { deviceId, accountId } = await deviceWithSecret();
    const credential = await deviceSessionService.issueBackgroundCredential(deviceId, accountId);
    if (!credential) throw new Error('failed to provision a background credential for the fixture');
    return { deviceId, accountId, secret: credential.secret };
  }

  it('mints a token and does NOT rotate the background secret', async () => {
    const { deviceId, accountId, secret } = await deviceWithBackgroundCredential();
    const before = await storedDevice(deviceId);

    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId, secret },
      { Authorization: '' },
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      accessToken: 'jwt-active',
      expiresAt: '2026-07-07T00:00:00.000Z',
      accountId,
    });
    // Unlike the rotating deviceSecret, this one is stable across mints.
    expect((await storedDevice(deviceId)).backgroundSecretHash).toBe(before.backgroundSecretHash);
    expect(logger.info).toHaveBeenCalledWith('device.token.mint', {
      mint_source: 'background',
      deviceId,
    });
  });

  it('401 background_credential_invalid on a wrong secret, and records a failure', async () => {
    const { deviceId, secret } = await deviceWithBackgroundCredential();

    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId, secret: `${secret}-tampered` },
      { Authorization: '' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('background_credential_invalid');
    expect(mockRecordFailure).toHaveBeenCalledWith({ scope: 'background-token', identifier: deviceId });
  });

  it('401 background_credential_invalid once the credential has expired', async () => {
    const { deviceId, secret } = await deviceWithBackgroundCredential();
    await getDb()
      .update(deviceSessions)
      .set({ backgroundSecretExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(deviceSessions.deviceId, deviceId));

    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId, secret },
      { Authorization: '' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('background_credential_invalid');
  });

  it('401 account_not_on_device — proven credential, dead account — without a lockout failure', async () => {
    const { deviceId, accountId, secret } = await deviceWithBackgroundCredential();
    // Remove the bound account's entry directly so the credential survives the
    // removal (signout would clear it), isolating the "account gone" branch.
    const row = await storedDevice(deviceId);
    await getDb()
      .delete(deviceAccountContexts)
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, row.id),
          eq(deviceAccountContexts.accountId, accountId),
        ),
      );

    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId, secret },
      { Authorization: '' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'background-token', identifier: deviceId });
  });

  it('signing out the bound account CLEARS the background credential', async () => {
    const { deviceId, accountId, secret } = await deviceWithBackgroundCredential();

    await deviceSessionService.signout(deviceId, { accountId });
    expect((await storedDevice(deviceId)).backgroundSecretHash).toBeNull();

    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId, secret },
      { Authorization: '' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('background_credential_invalid');
  });

  it('400 when the body shape is invalid', async () => {
    const res = await requestJson(
      'POST',
      '/session/device/background-token',
      { deviceId: 'd1' },
      { Authorization: '' },
    );
    expect(res.status).toBe(400);
    expect(mockIsLockedOut).not.toHaveBeenCalled();
  });
});
