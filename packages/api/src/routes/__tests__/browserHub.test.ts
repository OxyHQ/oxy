/**
 * `/session/browser-hub/*` — the browser DeviceSession hub's server half,
 * against a REAL Postgres (issue #937 Phase 5, ADR 0003).
 *
 * The properties this endpoint exists to hold live in stored rows — that the
 * RAW handle is never one of them, that a revoked handle stops resolving, that
 * a rotation keeps the previous one alive for exactly one grace window and no
 * longer, that signing the device out takes the hub with it — so the real
 * `deviceSession.service` runs here and the assertions read the columns
 * directly rather than the service's own projection.
 *
 * What stays mocked is narrow and deliberate, matching `sessionDevice.test.ts`:
 *
 *  - `session.service` — a collaborator (token minting and validation), not the
 *    subject.
 *  - `middleware/auth`, `middleware/authUtils`, `middleware/originGuard` — the
 *    bearer/JWT/CSRF layers, tested elsewhere; here they only name a caller.
 *  - `middleware/rateLimiter` (Redis), `utils/logger` — out-of-process edges.
 *
 * The third-party refusal is NOT mocked: `requireFirstPartyDeviceAccess` runs
 * for real against a real `applications` row, because "a third-party bearer
 * cannot mint a browser hub handle" is one of the things this suite is for.
 *
 * Every test mints its own device id and its own `users` rows, so no assertion
 * depends on a table being empty.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockAuthMiddleware = jest.fn();
const mockDecodeToken = jest.fn();
const mockValidateSessionById = jest.fn();
const mockGetAccessToken = jest.fn();
const mockDeactivateSession = jest.fn();

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
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    validateSessionById: (...a: unknown[]) => mockValidateSessionById(...a),
    getAccessToken: (...a: unknown[]) => mockGetAccessToken(...a),
    deactivateSession: (...a: unknown[]) => mockDeactivateSession(...a),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { BROWSER_HUB_HANDLE_TTL_MS } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import deviceSessionService from '../../services/deviceSession.service';
import browserHubRouter from '../browserHub';
import { errorHandler } from '../../middleware/errorHandler';

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

function newDeviceId(): string {
  return `dev-${randomUUID()}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The stored device row, read straight from Postgres (never via the service). */
async function storedDevice(deviceId: string) {
  const [row] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId))
    .limit(1);
  return row;
}

/** A device carrying one signed-in account, built through the real service. */
async function deviceWithAccount(): Promise<{ deviceId: string; accountId: string }> {
  const deviceId = newDeviceId();
  const accountId = await account();
  await deviceSessionService.addAccount(deviceId, { accountId, sessionId: `s-${randomUUID()}` });
  return { deviceId, accountId };
}

/** A device with an established hub handle, and the raw handle. */
async function deviceWithHub(): Promise<{ deviceId: string; accountId: string; handle: string }> {
  const { deviceId, accountId } = await deviceWithAccount();
  callerDeviceId = deviceId;
  callerAccountId = accountId;
  const established = await requestJson('POST', '/session/browser-hub/establish');
  const data = established.body.data as { handle: string };
  return { deviceId, accountId, handle: data.handle };
}

async function requestJson(
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; setCookie: string[] }> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
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
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          const cookies = res.headers['set-cookie'] ?? [];
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length ? JSON.parse(raw) : {},
            setCookie: Array.isArray(cookies) ? cookies : [cookies],
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server: http.Server;
let callerAccountId = '';
let callerDeviceId = 'd1';
/** The `applicationId` the mocked bearer layer claims. Empty = shared session. */
let callerApplicationId: string | null = null;

beforeAll(async () => {
  await connectPostgres();
  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown; oxyToken?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: { toString: () => callerAccountId }, id: callerAccountId };
      req.oxyToken = callerApplicationId ? { applicationId: callerApplicationId } : {};
      next();
    },
  );
  mockDecodeToken.mockImplementation(() => ({ sessionId: 's1', deviceId: callerDeviceId }));
  const app = express();
  app.use(express.json());
  app.use('/session/browser-hub', browserHubRouter);
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
  callerApplicationId = null;
  mockValidateSessionById.mockResolvedValue({ session: {} });
  mockGetAccessToken.mockImplementation(async (sessionId: string) => ({
    accessToken: `at-${sessionId}`,
    expiresAt: new Date(Date.now() + 900_000),
  }));
  mockDeactivateSession.mockResolvedValue(undefined);
});

describe('POST /session/browser-hub/establish', () => {
  it('stores only the HASH — the raw handle is in no column', async () => {
    const { deviceId, handle } = await deviceWithHub();
    const row = await storedDevice(deviceId);

    expect(row.hubSecretHash).toBe(sha256(handle));
    // The raw value appears nowhere on the row. Read as a whole-row scan rather
    // than one named column, so a future column that starts carrying it fails.
    expect(JSON.stringify(row)).not.toContain(handle);
  });

  it('returns an opaque handle carrying no device, account or session id', async () => {
    const { deviceId, accountId, handle } = await deviceWithHub();

    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes, base64url — 43 characters, no padding.
    expect(handle).toHaveLength(43);
    expect(handle).not.toContain(deviceId);
    expect(handle).not.toContain(accountId);
    // And it decodes to bytes, not to a readable structure.
    expect(Buffer.from(handle, 'base64url')).toHaveLength(32);
  });

  it('sets the credential expiry from the shared TTL constant', async () => {
    const before = Date.now();
    const { deviceId } = await deviceWithHub();
    const row = await storedDevice(deviceId);

    const expiresAt = row.hubSecretExpiresAt?.getTime() ?? 0;
    // The cookie's Max-Age is derived from the same constant, so the credential
    // and the thing addressing it expire together.
    expect(expiresAt).toBeGreaterThanOrEqual(before + BROWSER_HUB_HANDLE_TTL_MS - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + BROWSER_HUB_HANDLE_TTL_MS + 5_000);
  });

  it('refuses a caller whose bearer names no device', async () => {
    callerAccountId = await account();
    mockDecodeToken.mockImplementationOnce(() => ({ sessionId: 's1' }));
    const response = await requestJson('POST', '/session/browser-hub/establish');
    expect(response.status).toBe(401);
  });

  it('refuses a device that does not exist', async () => {
    callerAccountId = await account();
    callerDeviceId = newDeviceId();
    const response = await requestJson('POST', '/session/browser-hub/establish');
    expect(response.status).toBe(401);
  });

  it('refuses a THIRD-PARTY bearer', async () => {
    const { deviceId, accountId } = await deviceWithAccount();
    const ownerAccountId = await account();
    const [app] = await getDb()
      .insert(applications)
      .values({
        name: `Third party ${randomUUID()}`,
        type: 'third_party',
        scopes: [],
        redirectUris: ['https://third.example/cb'],
        ownerAccountId,
      })
      .returning({ id: applications.id });

    callerDeviceId = deviceId;
    callerAccountId = accountId;
    callerApplicationId = app.id;
    const response = await requestJson('POST', '/session/browser-hub/establish');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'third_party_device_access_denied' });
    // And nothing was written: a refused caller must not leave a credential.
    expect((await storedDevice(deviceId)).hubSecretHash).toBeNull();
  });

  it('refuses a bearer naming an application row that has gone away', async () => {
    // Fail CLOSED: an unresolvable application must not read as "unbound,
    // therefore first-party".
    const { deviceId, accountId } = await deviceWithAccount();
    callerDeviceId = deviceId;
    callerAccountId = accountId;
    callerApplicationId = `app-${randomUUID()}`;
    const response = await requestJson('POST', '/session/browser-hub/establish');
    expect(response.status).toBe(403);
  });

  it('one handle addresses one browser', async () => {
    const first = await deviceWithHub();
    const second = await deviceWithHub();
    expect(second.handle).not.toBe(first.handle);

    const resolved = await requestJson('POST', '/session/browser-hub/resolve', {
      handle: first.handle,
    });
    const directory = (resolved.body.data as { directory: { deviceId: string } }).directory;
    expect(directory.deviceId).toBe(first.deviceId);
    expect(directory.deviceId).not.toBe(second.deviceId);
  });
});

describe('POST /session/browser-hub/resolve', () => {
  it('resolves the device session from the handle alone', async () => {
    const { deviceId, accountId, handle } = await deviceWithHub();
    const response = await requestJson('POST', '/session/browser-hub/resolve', { handle });

    expect(response.status).toBe(200);
    const data = response.body.data as {
      accessToken: string;
      directory: { deviceId: string; principals: { userId: string }[] };
    };
    expect(data.directory.deviceId).toBe(deviceId);
    expect(data.directory.principals.map((p) => p.userId)).toContain(accountId);
    expect(data.accessToken).toMatch(/^at-/);
  });

  it('rejects an unknown handle', async () => {
    await deviceWithHub();
    const response = await requestJson('POST', '/session/browser-hub/resolve', {
      handle: Buffer.from(randomUUID() + randomUUID()).toString('base64url'),
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid_handle' });
  });

  it('rejects a handle whose credential has expired, leaving the row intact', async () => {
    const { deviceId, handle } = await deviceWithHub();
    await getDb()
      .update(deviceSessions)
      .set({ hubSecretExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(deviceSessions.deviceId, deviceId));

    const response = await requestJson('POST', '/session/browser-hub/resolve', { handle });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid_handle' });
    // Expiry is a READ-side verdict: a clock that was wrong for an hour must not
    // permanently destroy a live browser session.
    expect((await storedDevice(deviceId)).hubSecretHash).toBe(sha256(handle));
  });

  it('distinguishes a dead device from a dead handle, and keeps the credential', async () => {
    const { deviceId, handle } = await deviceWithHub();
    // The handle is fine; the device has nothing live to mint for. Expressed
    // through `getAccessToken`, which re-reads the row and re-checks the
    // operator's act_as, and is the only authority the resolve path consults.
    mockGetAccessToken.mockResolvedValue(null);

    const response = await requestJson('POST', '/session/browser-hub/resolve', { handle });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'no_active_session' });
    // NOT revoked — the edge keeps the cookie on this answer.
    expect((await storedDevice(deviceId)).hubSecretHash).toBe(sha256(handle));
  });

  it('rejects a missing handle before touching the database', async () => {
    const response = await requestJson('POST', '/session/browser-hub/resolve', {});
    expect(response.status).toBe(400);
  });
});

describe('POST /session/browser-hub/rotate', () => {
  it('issues a new handle and moves the old hash into the grace slot', async () => {
    const { deviceId, handle } = await deviceWithHub();
    const rotated = await requestJson('POST', '/session/browser-hub/rotate', { handle });
    const next = (rotated.body.data as { handle: string }).handle;

    expect(next).not.toBe(handle);
    const row = await storedDevice(deviceId);
    expect(row.hubSecretHash).toBe(sha256(next));
    expect(row.hubPrevSecretHash).toBe(sha256(handle));
    expect(row.hubPrevSecretExpiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it('honours the previous handle inside the grace window', async () => {
    // A browser's tabs share one cookie jar, so a request already in flight from
    // a sibling tab still carries the old value.
    const { handle } = await deviceWithHub();
    const rotated = await requestJson('POST', '/session/browser-hub/rotate', { handle });
    const next = (rotated.body.data as { handle: string }).handle;

    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle })).status).toBe(200);
    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle: next })).status).toBe(
      200,
    );
  });

  it('stops honouring the previous handle once the grace window closes', async () => {
    const { deviceId, handle } = await deviceWithHub();
    await requestJson('POST', '/session/browser-hub/rotate', { handle });
    await getDb()
      .update(deviceSessions)
      .set({ hubPrevSecretExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(deviceSessions.deviceId, deviceId));

    const response = await requestJson('POST', '/session/browser-hub/resolve', { handle });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid_handle' });
  });

  it('rejects a rotation requested with an unknown handle', async () => {
    await deviceWithHub();
    const response = await requestJson('POST', '/session/browser-hub/rotate', {
      handle: Buffer.from(randomUUID() + randomUUID()).toString('base64url'),
    });
    expect(response.status).toBe(401);
  });

  it('a rotation does not reach into another browser', async () => {
    const first = await deviceWithHub();
    const second = await deviceWithHub();
    await requestJson('POST', '/session/browser-hub/rotate', { handle: first.handle });

    const other = await storedDevice(second.deviceId);
    expect(other.hubSecretHash).toBe(sha256(second.handle));
    expect(other.hubPrevSecretHash).toBeNull();
  });
});

describe('POST /session/browser-hub/revoke', () => {
  it('clears the whole quadruple and stops the handle resolving', async () => {
    const { deviceId, handle } = await deviceWithHub();
    const response = await requestJson('POST', '/session/browser-hub/revoke', { handle });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { revoked: true } });
    const row = await storedDevice(deviceId);
    expect(row.hubSecretHash).toBeNull();
    expect(row.hubPrevSecretHash).toBeNull();
    expect(row.hubPrevSecretExpiresAt).toBeNull();
    expect(row.hubSecretExpiresAt).toBeNull();
    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle })).status).toBe(401);
  });

  it('revokes the grace handle too', async () => {
    const { deviceId, handle } = await deviceWithHub();
    const rotated = await requestJson('POST', '/session/browser-hub/rotate', { handle });
    const next = (rotated.body.data as { handle: string }).handle;
    await requestJson('POST', '/session/browser-hub/revoke', { handle: next });

    expect((await storedDevice(deviceId)).hubPrevSecretHash).toBeNull();
    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle })).status).toBe(401);
  });

  it('leaves the device session and its accounts alone', async () => {
    // This is "sign out of auth.oxy.so", not "sign out this device".
    const { deviceId, accountId, handle } = await deviceWithHub();
    const revisionBefore = (await storedDevice(deviceId)).revision;
    await requestJson('POST', '/session/browser-hub/revoke', { handle });

    const state = await deviceSessionService.getState(deviceId);
    expect(state.accounts.map((a) => a.accountId)).toEqual([accountId]);
    expect(state.activeAccountId).toBe(accountId);
    // No account changed hands, so nothing for the device's other apps to
    // converge on.
    expect((await storedDevice(deviceId)).revision).toBe(revisionBefore);
  });

  it('is idempotent and never an existence oracle', async () => {
    const { handle } = await deviceWithHub();
    await requestJson('POST', '/session/browser-hub/revoke', { handle });

    const second = await requestJson('POST', '/session/browser-hub/revoke', { handle });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ data: { revoked: false } });

    const neverExisted = await requestJson('POST', '/session/browser-hub/revoke', {
      handle: Buffer.from(randomUUID() + randomUUID()).toString('base64url'),
    });
    // Identical answer for "revoked a moment ago" and "never existed".
    expect(neverExisted.status).toBe(second.status);
    expect(neverExisted.body).toEqual(second.body);
  });
});

describe('the API sets no cookie, on any hub route', () => {
  it('leaves every Set-Cookie unwritten', async () => {
    // `api.oxy.so` cannot set `__Host-oxy-device` and must not try: a `__Host-`
    // cookie is bound to the host that sends it, and the browser's is
    // `auth.oxy.so`. The edge writes it; this API only ever hands the edge a
    // handle in a JSON body. A cookie appearing here would be one bound to the
    // API's own host, invisible to the IdP and sent on every API request.
    const { deviceId, handle } = await deviceWithHub();
    const rotated = await requestJson('POST', '/session/browser-hub/rotate', { handle });
    const next = (rotated.body.data as { handle: string }).handle;

    callerDeviceId = deviceId;
    const responses = [
      await requestJson('POST', '/session/browser-hub/establish'),
      await requestJson('POST', '/session/browser-hub/resolve', { handle: next }),
      rotated,
      await requestJson('POST', '/session/browser-hub/revoke', { handle: next }),
    ];
    for (const response of responses) {
      expect(response.setCookie).toEqual([]);
    }
  });
});

describe('the hub is revoked WITH the device session', () => {
  it('signout-all clears the hub credential', async () => {
    const { deviceId, handle } = await deviceWithHub();
    await deviceSessionService.signout(deviceId, { all: true });

    const row = await storedDevice(deviceId);
    expect(row.hubSecretHash).toBeNull();
    expect(row.hubSecretExpiresAt).toBeNull();
    // Otherwise a retained cookie keeps resolving a device whose accounts were
    // all just signed out — and the next official origin silently rejoins.
    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle })).status).toBe(401);
  });

  it('signing ONE account out leaves the hub alone', async () => {
    // The browser's other accounts still legitimately use it.
    const { deviceId, handle } = await deviceWithHub();
    const secondAccount = await account();
    await deviceSessionService.addAccount(deviceId, {
      accountId: secondAccount,
      sessionId: `s-${randomUUID()}`,
    });

    await deviceSessionService.signout(deviceId, { accountId: secondAccount });

    expect((await storedDevice(deviceId)).hubSecretHash).toBe(sha256(handle));
    expect((await requestJson('POST', '/session/browser-hub/resolve', { handle })).status).toBe(200);
  });
});
