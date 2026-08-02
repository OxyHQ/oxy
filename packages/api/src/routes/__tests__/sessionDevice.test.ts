import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockAuthMiddleware = jest.fn();
const mockGetState = jest.fn();
const mockAddAccount = jest.fn();
const mockSwitchActive = jest.fn();
const mockSignout = jest.fn();
const mockResolveActiveToken = jest.fn();
const mockResolveTokenForAccount = jest.fn();
const mockBroadcast = jest.fn();
const mockBroadcastAccounts = jest.fn();
const mockDecodeToken = jest.fn();
const mockGetSession = jest.fn();
const mockGetStateBySecret = jest.fn();
const mockIssueDeviceSecret = jest.fn();
const mockIsLockedOut = jest.fn();
const mockRecordFailure = jest.fn();
const mockClearFailures = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...a: unknown[]) => mockAuthMiddleware(...a),
}));
jest.mock('../../middleware/originGuard', () => ({
  requireSameSiteOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../middleware/authUtils', () => ({
  decodeToken: (...a: unknown[]) => mockDecodeToken(...a),
  extractTokenFromRequest: () => 'tkn',
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: {
    getState: (...a: unknown[]) => mockGetState(...a),
    addAccount: (...a: unknown[]) => mockAddAccount(...a),
    switchActive: (...a: unknown[]) => mockSwitchActive(...a),
    signout: (...a: unknown[]) => mockSignout(...a),
    resolveActiveToken: (...a: unknown[]) => mockResolveActiveToken(...a),
    resolveTokenForAccount: (...a: unknown[]) => mockResolveTokenForAccount(...a),
    getStateBySecret: (...a: unknown[]) => mockGetStateBySecret(...a),
    issueDeviceSecret: (...a: unknown[]) => mockIssueDeviceSecret(...a),
  },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    getSession: (...a: unknown[]) => mockGetSession(...a),
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
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import sessionDeviceRouter from '../sessionDevice';
import { errorHandler } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

const STATE = { deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: 1, updatedAt: 1720000000000 };

async function requestJson(server: http.Server, method: string, path: string, payload?: unknown, extraHeaders?: Record<string, string>) {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ method, host: '127.0.0.1', port: address.port, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), Authorization: 'Bearer t', ...(extraHeaders ?? {}) } },
      (res) => { let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }); }); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

let server: http.Server;
beforeAll((done) => {
  mockAuthMiddleware.mockImplementation((req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user?: unknown }).user = { _id: { toString: () => '64b0000000000000000000aa' }, id: '64b0000000000000000000aa' };
    next();
  });
  mockDecodeToken.mockReturnValue({ sessionId: 's1', deviceId: 'd1' });
  const app = express();
  app.use(express.json());
  app.use('/session/device', sessionDeviceRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveActiveToken.mockResolvedValue({ accessToken: 'jwt-active', expiresAt: '2026-07-07T00:00:00.000Z' });
  // The signout route pre-reads the device state (to diff which users were
  // removed) before signing out — default it to the single-account STATE.
  mockGetState.mockResolvedValue(STATE);
  // Default to an active first-party session; individual tests override this
  // to exercise managed sessions or the expired/revoked (null) 401 path.
  mockGetSession.mockResolvedValue({ operatedByUserId: null });
  // Default: device is not locked out. Tests override for the 429 path.
  mockIsLockedOut.mockResolvedValue({ locked: false, attempts: 0 });
  mockRecordFailure.mockResolvedValue({ locked: false, attempts: 1 });
  mockClearFailures.mockResolvedValue(undefined);
});

describe('GET /session/device/state', () => {
  it('returns the device state', async () => {
    mockGetState.mockResolvedValueOnce(STATE);
    const res = await requestJson(server, 'GET', '/session/device/state');
    expect(res.status).toBe(200);
    expect(res.body.data.state).toEqual(STATE);
    expect(res.body.data.activeToken).toEqual({ accessToken: 'jwt-active', expiresAt: '2026-07-07T00:00:00.000Z' });
    expect(mockGetState).toHaveBeenCalledWith('d1');
  });
});

describe('POST /session/device/switch', () => {
  it('switches active account and broadcasts', async () => {
    mockSwitchActive.mockResolvedValueOnce({ ok: true, state: STATE });
    const res = await requestJson(server, 'POST', '/session/device/switch', { accountId: 'a1' });
    expect(res.status).toBe(200);
    expect(mockSwitchActive).toHaveBeenCalledWith('d1', 'a1');
    expect(mockBroadcast).toHaveBeenCalledWith(STATE);
    // A1: cross-device signal to the switched-to account's user room.
    expect(mockBroadcastAccounts).toHaveBeenCalledWith('a1', STATE.revision, 'switch');
    expect(res.body.data.state).toEqual(STATE);
    expect(res.body.data.activeToken.accessToken).toBe('jwt-active');
  });

  it('404 when the account is not on the device', async () => {
    mockSwitchActive.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    const res = await requestJson(server, 'POST', '/session/device/switch', { accountId: 'ghost' });
    expect(res.status).toBe(404);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
  });

  it('403 and broadcasts the healed state when the target session is revoked (act_as membership pulled)', async () => {
    const healed = { ...STATE, accounts: [], activeAccountId: null, revision: 2 };
    mockSwitchActive.mockResolvedValueOnce({ ok: false, reason: 'unauthorized', state: healed });
    const res = await requestJson(server, 'POST', '/session/device/switch', { accountId: 'org1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Account not authorized');
    // switchActive healed the device set (dropped the revoked account); the
    // route broadcasts that healed state so the device's other tabs converge.
    expect(mockBroadcast).toHaveBeenCalledWith(healed);
    // A1: the revoked account's user is signalled to refetch.
    expect(mockBroadcastAccounts).toHaveBeenCalledWith('org1', healed.revision, 'revoke');
  });
});

describe('POST /session/device/signout', () => {
  it('signs out one account and broadcasts', async () => {
    const after = { ...STATE, accounts: [], activeAccountId: null, revision: 2 };
    mockSignout.mockResolvedValueOnce(after);
    const res = await requestJson(server, 'POST', '/session/device/signout', { accountId: 'a1' });
    expect(res.status).toBe(200);
    expect(mockSignout).toHaveBeenCalledWith('d1', { accountId: 'a1' });
    expect(mockBroadcast).toHaveBeenCalledWith(after);
    // A1: the removed account (present before, gone after) is signalled.
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(['a1'], after.revision, 'signout');
    expect(res.body.data.state).toEqual(after);
  });

  it('signs out all when { all: true } and signals every removed user', async () => {
    // Two accounts on the device before; all removed.
    const before = {
      ...STATE,
      accounts: [
        { accountId: 'a1', sessionId: 's1', authuser: 0 },
        { accountId: 'a2', sessionId: 's2', authuser: 1 },
      ],
    };
    mockGetState.mockResolvedValueOnce(before);
    const after = { ...STATE, accounts: [], activeAccountId: null, revision: 2 };
    mockSignout.mockResolvedValueOnce(after);
    const res = await requestJson(server, 'POST', '/session/device/signout', { all: true });
    expect(res.status).toBe(200);
    expect(mockSignout).toHaveBeenCalledWith('d1', { all: true });
    expect(mockBroadcastAccounts).toHaveBeenCalledWith(['a1', 'a2'], after.revision, 'signout');
  });
});

describe('POST /session/device/add', () => {
  it('adds an account and broadcasts when the state changed', async () => {
    mockAddAccount.mockResolvedValueOnce({ state: STATE, changed: true });
    const res = await requestJson(server, 'POST', '/session/device/add', {});
    expect(res.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledWith('s1', true);
    expect(mockAddAccount).toHaveBeenCalledWith('d1', { accountId: '64b0000000000000000000aa', sessionId: 's1' });
    expect(mockBroadcast).toHaveBeenCalledWith(STATE);
    // A1: the added account's user is signalled to refetch.
    expect(mockBroadcastAccounts).toHaveBeenCalledWith('64b0000000000000000000aa', STATE.revision, 'add');
    expect(res.body.data.state).toEqual(STATE);
    expect(res.body.data.activeToken.accessToken).toBe('jwt-active');
  });

  it('does NOT broadcast on an idempotent re-register (changed=false) but still returns the current state', async () => {
    mockAddAccount.mockResolvedValueOnce({ state: STATE, changed: false });
    const res = await requestJson(server, 'POST', '/session/device/add', {});
    expect(res.status).toBe(200);
    expect(mockBroadcast).not.toHaveBeenCalled();
    // No change → no cross-device signal either.
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
    expect(res.body.data.state).toEqual(STATE);
    expect(res.body.data.activeToken.accessToken).toBe('jwt-active');
  });

  it('passes the operator id through to addAccount for a managed-account session', async () => {
    mockGetSession.mockResolvedValueOnce({ operatedByUserId: { toString: () => 'op1' } });
    mockAddAccount.mockResolvedValueOnce({ state: STATE, changed: true });
    const res = await requestJson(server, 'POST', '/session/device/add', {});
    expect(res.status).toBe(200);
    expect(mockAddAccount).toHaveBeenCalledWith('d1', { accountId: '64b0000000000000000000aa', sessionId: 's1', operatedByUserId: 'op1' });
  });

  it('does not forward operatedByUserId for an ordinary first-party session', async () => {
    mockGetSession.mockResolvedValueOnce({ operatedByUserId: null });
    mockAddAccount.mockResolvedValueOnce({ state: STATE, changed: true });
    await requestJson(server, 'POST', '/session/device/add', {});
    expect(mockAddAccount).toHaveBeenCalledWith('d1', { accountId: '64b0000000000000000000aa', sessionId: 's1' });
  });

  it('401s and never adds the account when the session is expired/revoked (getSession returns null)', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await requestJson(server, 'POST', '/session/device/add', {});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid session');
    expect(mockAddAccount).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('POST /session/device/token (phase 2c — public deviceSecret mint)', () => {
  const SECRET_STATE = {
    deviceId: 'd1',
    accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }],
    activeAccountId: 'a1',
    revision: 3,
    updatedAt: 1720000000000,
  };

  it('mints a short access token and preserves the valid device secret', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(SECRET_STATE);
    mockResolveActiveToken.mockResolvedValueOnce({ accessToken: 'jwt-mint', expiresAt: '2026-07-07T00:00:00.000Z' });
    mockIssueDeviceSecret.mockResolvedValueOnce('next-secret-value');

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret' });

    expect(res.status).toBe(200);
    expect(mockGetStateBySecret).toHaveBeenCalledWith('d1', 'raw-secret');
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'device-token', identifier: 'd1' });
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({
      accessToken: 'jwt-mint',
      expiresAt: '2026-07-07T00:00:00.000Z',
      nextDeviceSecret: 'raw-secret',
      state: SECRET_STATE,
    });
    expect(mockRecordFailure).not.toHaveBeenCalled();
    // Telemetry: the mint is attributed to the secret lane.
    expect(logger.info).toHaveBeenCalledWith('device.token.mint', { mint_source: 'secret', deviceId: 'd1' });
    // No `accountId` → the active-account resolver, exactly as before.
    expect(mockResolveTokenForAccount).not.toHaveBeenCalled();
  });

  it('401 invalid_device_secret and records a failure on an unknown/mismatched secret', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(null);

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'bad' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    expect(mockRecordFailure).toHaveBeenCalledWith({ scope: 'device-token', identifier: 'd1' });
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    expect(mockClearFailures).not.toHaveBeenCalled();
  });

  it('429 when the device is locked out — never touches the secret', async () => {
    mockIsLockedOut.mockResolvedValueOnce({ locked: true, retryAfterSeconds: 42, attempts: 5 });

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'x' });

    expect(res.status).toBe(429);
    expect(mockGetStateBySecret).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('401 no_active_session WITHOUT rotating when the secret is valid but the session is dead', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(SECRET_STATE);
    mockResolveActiveToken.mockResolvedValueOnce(null);

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_active_session');
    // Valid secret → failures cleared, but the secret is NOT rotated: the client
    // must re-auth and keeps its still-valid secret.
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'device-token', identifier: 'd1' });
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('returns the proven secret unchanged so concurrent app origins do not race', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(SECRET_STATE);
    mockResolveActiveToken.mockResolvedValueOnce({ accessToken: 'jwt-grace', expiresAt: '2026-07-07T00:00:00.000Z' });

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'previous-secret' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBe('jwt-grace');
    expect(res.body.data.nextDeviceSecret).toBe('previous-secret');
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
  });

  it('400 when the body shape is invalid (missing deviceSecret)', async () => {
    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1' });
    expect(res.status).toBe(400);
    expect(mockGetStateBySecret).not.toHaveBeenCalled();
    expect(mockIsLockedOut).not.toHaveBeenCalled();
  });
});

describe('POST /session/device/token — pinned mint (identity-bound clients)', () => {
  // Two accounts registered on the device; a1 is the one every other app made
  // active, a2 is the account whose key the identity-bound client (Commons) holds.
  const PINNED_STATE = {
    deviceId: 'd1',
    accounts: [
      { accountId: 'a1', sessionId: 's1', authuser: 0 },
      { accountId: 'a2', sessionId: 's2', authuser: 1 },
    ],
    activeAccountId: 'a1',
    revision: 7,
    updatedAt: 1720000000000,
  };

  it('mints the PINNED account token (not the active one) and preserves the secret', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(PINNED_STATE);
    mockResolveTokenForAccount.mockResolvedValueOnce({ accessToken: 'jwt-a2', expiresAt: '2026-07-07T00:00:00.000Z' });
    mockIssueDeviceSecret.mockResolvedValueOnce('next-secret-value');

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret', accountId: 'a2' });

    expect(res.status).toBe(200);
    expect(mockResolveTokenForAccount).toHaveBeenCalledWith(PINNED_STATE, 'a2');
    // The active-account resolver is never consulted on the pinned lane.
    expect(mockResolveActiveToken).not.toHaveBeenCalled();
    expect(res.body.data.accessToken).toBe('jwt-a2');
    expect(res.body.data.nextDeviceSecret).toBe('raw-secret');
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    // Telemetry discriminates the pinned lane — and carries no accountId.
    expect(logger.info).toHaveBeenCalledWith('device.token.mint', { mint_source: 'secret', deviceId: 'd1', pinned: true });
  });

  it('never mutates the device state: no switch, no add, no revision bump, no broadcast — and reports the TRUE activeAccountId', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(PINNED_STATE);
    mockResolveTokenForAccount.mockResolvedValueOnce({ accessToken: 'jwt-a2', expiresAt: '2026-07-07T00:00:00.000Z' });
    mockIssueDeviceSecret.mockResolvedValueOnce('next-secret-value');

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret', accountId: 'a2' });

    expect(res.status).toBe(200);
    // Pinning is read-only w.r.t. everything the other apps on this device observe.
    expect(mockSwitchActive).not.toHaveBeenCalled();
    expect(mockAddAccount).not.toHaveBeenCalled();
    expect(mockSignout).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastAccounts).not.toHaveBeenCalled();
    // The response does NOT pretend the pinned account became active.
    expect(res.body.data.state).toEqual(PINNED_STATE);
    expect((res.body.data.state as { activeAccountId: string }).activeAccountId).toBe('a1');
    expect((res.body.data.state as { revision: number }).revision).toBe(PINNED_STATE.revision);
  });

  it('401 account_not_on_device for an accountId that is not registered on the device — no rotation, no lockout failure', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(PINNED_STATE);
    mockResolveTokenForAccount.mockResolvedValueOnce(null);

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret', accountId: 'ghost' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    // The secret was proven — a bad pin must never count as secret guessing.
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockClearFailures).toHaveBeenCalledWith({ scope: 'device-token', identifier: 'd1' });
  });

  it('401 account_not_on_device (same generic error, no enumeration oracle) when the pinned member session is dead — and does NOT rotate', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(PINNED_STATE);
    // a2 IS on the device, but its session no longer validates.
    mockResolveTokenForAccount.mockResolvedValueOnce(null);

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret', accountId: 'a2' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_not_on_device');
    expect(mockIssueDeviceSecret).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('a bad pin on an INVALID secret is still the plain invalid_device_secret lane (records a failure, never resolves the account)', async () => {
    mockGetStateBySecret.mockResolvedValueOnce(null);

    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'bad', accountId: 'a2' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_device_secret');
    expect(mockRecordFailure).toHaveBeenCalledWith({ scope: 'device-token', identifier: 'd1' });
    expect(mockResolveTokenForAccount).not.toHaveBeenCalled();
  });

  it('400 when accountId is present but empty (schema requires min(1))', async () => {
    const res = await requestJson(server, 'POST', '/session/device/token', { deviceId: 'd1', deviceSecret: 'raw-secret', accountId: '' });
    expect(res.status).toBe(400);
    expect(mockGetStateBySecret).not.toHaveBeenCalled();
  });
});
