/**
 * POST /accounts/:id/switch — true account switch (mints a REAL session whose
 * user IS the target managed account), replacing the old X-Acting-As delegation.
 *
 * Mounts the real accounts router over HTTP. Collaborators are mocked so we drive
 * the authorization gate + response shape without a database:
 *  - account.service.verifyActingAs → controls act_as authorization,
 *  - the target account is a REAL row (the route resolves it from Postgres),
 *  - sessionService.createSession → session minting.
 *
 * Asserts: non-members are rejected (403); a personal account is never a switch
 * target (403); an authorized member mints a session whose user is the target and
 * records the operator; the response mirrors the login/claimSession shape.
 *
 * ROOT-CAUSE GUARD (slot-clobber regression): the switch route MUST NOT write any
 * per-slot refresh cookie (deleted transport). Those cookies were `Path=/auth` scoped, so
 * the browser never sends them to this `/accounts/*` route; issuing one blind here
 * always picks slot 0 and OVERWRITES the operator's own primary session. The SDK
 * establishes the device cookie via `POST /auth/session` (under `/auth`) instead.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

const OPERATOR_ID = '6a0000000000000000000001';
const ORG_ID = '6a0000000000000000000010';

const mockVerifyActingAs = jest.fn();
const mockListAccessibleAccounts = jest.fn();
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: {
    verifyActingAs: (...args: unknown[]) => mockVerifyActingAs(...args),
    listAccessibleAccounts: (...args: unknown[]) => mockListAccessibleAccounts(...args),
  },
}));

const mockCreateSession = jest.fn();
const mockGetSession = jest.fn();
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    // Used by the route's `resolveOperatorId` to read `operatedByUserId` off the
    // session doc (the JWT does not carry it).
    getSession: (...args: unknown[]) => mockGetSession(...args),
  },
}));

// The switch registers the managed session into the operator's device set.
// Only the target ACCOUNT is a real row here; the device-set write + socket
// broadcast belong to other services and stay mocked.
const mockAddAccount = jest.fn(async () => ({
  state: { deviceId: 'op-device', accounts: [], activeAccountId: null, revision: 1, updatedAt: Date.now() },
  changed: false,
}));
const mockGetDeviceState = jest.fn();
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: {
    addAccount: (...args: unknown[]) => mockAddAccount(...args),
    getState: (...args: unknown[]) => mockGetDeviceState(...args),
  },
}));
const mockBroadcastDeviceState = jest.fn();
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...args: unknown[]) => mockBroadcastDeviceState(...args),
}));

const mockAuthMiddleware = jest.fn();
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  // The router also registers the service-scoped provisioning routes, which take
  // this as a handler. A whole-module mock that omits it makes Express reject
  // the route at import time, failing the suite before any test runs.
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockDecodeToken = jest.fn();
jest.mock('../../middleware/authUtils', () => ({
  decodeToken: (...args: unknown[]) => mockDecodeToken(...args),
  extractTokenFromRequest: () => 'tkn',
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({ isStaffUser: () => false }));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import accountsRouter from '../accounts';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';

/**
 * Insert the switch TARGET as a real row at a known id. The route resolves it
 * from Postgres, so the account's `kind` and `accountStatus` — the two things
 * the 403/404 gates read — have to be real stored values.
 */
async function seedTargetAccount(values: {
  username: string;
  kind: 'personal' | 'organization' | 'project' | 'bot' | 'channel';
  accountStatus?: 'active' | 'suspended' | 'archived';
}): Promise<void> {
  await getDb()
    .insert(users)
    .values({
      id: ORG_ID,
      color: 'teal',
      username: values.username,
      kind: values.kind,
      accountStatus: values.accountStatus ?? 'active',
    });
}

interface JsonResponse {
  status: number;
  setCookie: string[];
  body: Record<string, unknown> & {
    user?: { id?: string; username?: string };
    sessionId?: string;
    accessToken?: string;
    authuser?: number;
    error?: string;
    message?: string;
  };
}

function post(srv: http.Server, path: string): Promise<JsonResponse> {
  const address = srv.address() as AddressInfo;
  const body = JSON.stringify({});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), Authorization: 'Bearer t' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const setCookie = res.headers['set-cookie'] ?? [];
            resolve({
              status: res.statusCode ?? 0,
              setCookie: Array.isArray(setCookie) ? setCookie : [setCookie],
              body: raw.length > 0 ? JSON.parse(raw) : {},
            });
          } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(srv: http.Server, path: string): Promise<JsonResponse> {
  const address = srv.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { Authorization: 'Bearer t' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const setCookie = res.headers['set-cookie'] ?? [];
            resolve({
              status: res.statusCode ?? 0,
              setCookie: Array.isArray(setCookie) ? setCookie : [setCookie],
              body: raw.length > 0 ? JSON.parse(raw) : {},
            });
          } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  mockAuthMiddleware.mockImplementation((req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user?: unknown }).user = { _id: { toString: () => OPERATOR_ID } };
    next();
  });
  const app = express();
  app.use(express.json());
  app.use('/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  // Every case seeds its own target at the same id, so clear it first.
  await getDb().delete(users).where(eq(users.id, ORG_ID));
  mockVerifyActingAs.mockReset();
  mockCreateSession.mockReset();
  // Default: the operator's bearer decodes to a device id — the switch must
  // inherit it so the org session lands on the SAME device doc as the operator.
  mockDecodeToken.mockReset();
  mockDecodeToken.mockReturnValue({ sessionId: 'op-sess', deviceId: 'dev-op' });
  // Default: an ordinary (non-operated) session → the operator IS the active
  // account. Operated-session cases override with an `operatedByUserId`.
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue({ operatedByUserId: null });
  mockListAccessibleAccounts.mockReset();
  mockListAccessibleAccounts.mockResolvedValue([]);
  mockGetDeviceState.mockReset();
  mockGetDeviceState.mockResolvedValue({ accounts: [] });
});

describe('POST /accounts/:id/switch', () => {
  it('rejects a caller without act_as on the target (403)', async () => {
    mockVerifyActingAs.mockResolvedValue(null);

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(403);
    expect(mockVerifyActingAs).toHaveBeenCalledWith(OPERATOR_ID, ORG_ID);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('refuses to switch INTO a personal account (403) even with act_as', async () => {
    mockVerifyActingAs.mockResolvedValue('owner');
    await seedTargetAccount({ username: 'someone', kind: 'personal' });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(403);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  /**
   * The structural half of "a channel can never be logged into". A channel is
   * minted with no auth methods, but that alone only makes direct login
   * impossible — every auth-method write (`routes/authLinking.ts`,
   * `routes/webauthn.ts`) resolves its target from `req.user`, i.e. from the
   * AUTHENTICATED subject, never from a parameter. So the only way to add a
   * credential to a channel would be to hold a bearer whose subject IS the
   * channel, and this route is the one place such a bearer could be minted.
   * Refusing here is what closes the loop.
   */
  it('refuses to switch INTO a channel account (403) even with act_as', async () => {
    mockVerifyActingAs.mockResolvedValue('owner');
    await seedTargetAccount({ username: 'daily-news', kind: 'channel' });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(403);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('mints a real session AS the managed account for an authorized member', async () => {
    mockVerifyActingAs.mockResolvedValue('admin');
    await seedTargetAccount({ username: 'acme-org', kind: 'organization' });
    mockCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      accessToken: 'acc-1',
    });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(200);
    // The session's user IS the target account (a true switch, not delegation).
    expect(res.body.user?.id).toBe(ORG_ID);
    expect(res.body.user?.username).toBe('acme-org');
    expect(res.body.sessionId).toBe('sess-1');
    expect(res.body.accessToken).toBe('acc-1');
    // Operator recorded on the minted session, AND the operator's deviceId is
    // inherited so the org session joins the operator's existing device doc
    // (not a fresh device the browser never restores from on reload).
    expect(mockCreateSession).toHaveBeenCalledWith(ORG_ID, expect.anything(), {
      operatedByUserId: OPERATOR_ID,
      deviceId: 'dev-op',
    });
    // The managed session is registered into the operator's device set
    // server-side (a switch is a deliberate activation → activate: 'always').
    expect(mockAddAccount).toHaveBeenCalledWith(
      'dev-1',
      { accountId: ORG_ID, sessionId: 'sess-1', operatedByUserId: OPERATOR_ID },
      { activate: 'always' },
    );
  });

  it('anchors on the OPERATOR when acting-as a sub-account (sibling switch works, operator never nests)', async () => {
    // The active session is an OPERATED sub-account: the human operator is the
    // recorded `operatedByUserId`, NOT the active account (OPERATOR_ID here plays
    // the acted-as sub-account). A switch out of it must authorise + record the
    // HUMAN, so the operator can reach their sibling accounts.
    const HUMAN_ID = '6a0000000000000000000099';
    mockGetSession.mockResolvedValue({ operatedByUserId: { toString: () => HUMAN_ID } });
    mockGetDeviceState.mockResolvedValue({ accounts: [{ accountId: ORG_ID }] });
    mockVerifyActingAs.mockResolvedValue('owner');
    await seedTargetAccount({ username: 'sibling-org', kind: 'organization' });
    mockCreateSession.mockResolvedValue({
      sessionId: 'sess-2',
      deviceId: 'dev-op',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      accessToken: 'acc-2',
    });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(200);
    // Authorised as the human operator — NOT the acted-as sub-account.
    expect(mockVerifyActingAs).toHaveBeenCalledWith(HUMAN_ID, ORG_ID);
    // The minted session records the human operator (flat chain, never the sub-account).
    expect(mockCreateSession).toHaveBeenCalledWith(ORG_ID, expect.anything(), {
      operatedByUserId: HUMAN_ID,
      deviceId: 'dev-op',
    });
    expect(mockAddAccount).toHaveBeenCalledWith(
      'dev-op',
      { accountId: ORG_ID, sessionId: 'sess-2', operatedByUserId: HUMAN_ID },
      { activate: 'always' },
    );
  });

  it('rejects a sibling switch from an operated bearer unless the target is already on its device', async () => {
    const HUMAN_ID = '6a0000000000000000000099';
    mockGetSession.mockResolvedValue({ operatedByUserId: { toString: () => HUMAN_ID } });
    mockVerifyActingAs.mockResolvedValue('owner');
    await seedTargetAccount({ username: 'unregistered-sibling', kind: 'organization' });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(403);
    expect(mockGetDeviceState).toHaveBeenCalledWith('dev-op');
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('falls back to a fresh device when the bearer has no resolvable deviceId', async () => {
    // No decodable deviceId on the caller's bearer → keep today's behavior
    // (let createSession derive/allocate a device) rather than passing undefined.
    mockDecodeToken.mockReturnValue(null);
    mockVerifyActingAs.mockResolvedValue('admin');
    await seedTargetAccount({ username: 'acme-org', kind: 'organization' });
    mockCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      deviceId: 'dev-fresh',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      accessToken: 'acc-1',
    });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(200);
    // No deviceId key threaded — the switch still mints a session.
    expect(mockCreateSession).toHaveBeenCalledWith(ORG_ID, expect.anything(), { operatedByUserId: OPERATOR_ID });
  });

  it('does NOT write a refresh cookie (slot-clobber guard) — establishment is deferred to /auth/session', async () => {
    mockVerifyActingAs.mockResolvedValue('admin');
    await seedTargetAccount({ username: 'acme-org', kind: 'organization' });
    mockCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      accessToken: 'acc-1',
    });

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(200);
    // The route lives at /accounts/* — outside the deleted slot-cookie's Path=/auth
    // scope — so it can never see the device's existing slots. Issuing a cookie
    // here would blindly take slot 0 and destroy the operator's own session.
    // It MUST leave the cookie untouched; the SDK establishes it via /auth/session.
    expect(res.setCookie.some((c) => /(^|\s)oxy_rt_\d+=/.test(c) && !/Max-Age=0/.test(c))).toBe(false);
    // No authuser is resolved by this route — the SDK gets it from /auth/session.
    expect(res.body.authuser).toBeUndefined();
  });

  it('returns 404 for a missing/archived target', async () => {
    mockVerifyActingAs.mockResolvedValue('admin');
    // No row seeded — the account genuinely does not exist.

    const res = await post(server, `/accounts/${ORG_ID}/switch`);

    expect(res.status).toBe(404);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

describe('GET /accounts (operator-anchored switchable graph)', () => {
  it('anchors an ordinary session on the authenticated account', async () => {
    // No operatedByUserId → the operator IS the active account.
    const res = await get(server, '/accounts');

    expect(res.status).toBe(200);
    expect(mockListAccessibleAccounts).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('anchors an OPERATED (sub-account) session on the human operator, not the active account', async () => {
    // Acting-as a leaf sub-account still projects with the human operator, then
    // constrains that projection to accounts already registered on this device.
    const HUMAN_ID = '6a0000000000000000000099';
    mockGetSession.mockResolvedValue({ operatedByUserId: { toString: () => HUMAN_ID } });
    mockGetDeviceState.mockResolvedValue({ accounts: [{ accountId: OPERATOR_ID }] });

    const res = await get(server, '/accounts');

    expect(res.status).toBe(200);
    expect(mockListAccessibleAccounts).toHaveBeenCalledWith(HUMAN_ID);
    expect(mockListAccessibleAccounts).not.toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('does not disclose unregistered siblings to an operated bearer', async () => {
    const HUMAN_ID = '6a0000000000000000000099';
    mockGetSession.mockResolvedValue({ operatedByUserId: { toString: () => HUMAN_ID } });
    mockListAccessibleAccounts.mockResolvedValue([
      { accountId: OPERATOR_ID },
      { accountId: ORG_ID },
    ]);
    mockGetDeviceState.mockResolvedValue({ accounts: [{ accountId: OPERATOR_ID }] });

    const res = await get(server, '/accounts');

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([expect.objectContaining({ accountId: OPERATOR_ID })]);
  });
});
