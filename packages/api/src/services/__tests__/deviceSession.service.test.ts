/**
 * `deviceSession.service` against a REAL Postgres.
 *
 * This is the server authority for what is signed in on a device, so every
 * assertion here runs the real service against the throwaway database rather
 * than against a mocked driver — the previous suite mocked the Mongoose model
 * and therefore asserted on `$set`/`$unset` payload SHAPES, which proved the
 * call was built as expected but never that the stored row ended up correct.
 *
 * `session.service` IS mocked: it is a collaborator (token minting, session
 * validation/deactivation), not the subject, and its own port is a separate
 * file. Nothing about MongoDB is mocked here.
 *
 * Every test mints its own device id and its own `users` rows, so no assertion
 * depends on a table being empty — the suite shares one database with the rest
 * of the run, and `device_session_accounts` carries real foreign keys to
 * `users`.
 */

import { randomUUID } from 'node:crypto';
import * as nodeCrypto from 'crypto';
import { and, eq } from 'drizzle-orm';

const mockDeactivate = jest.fn();
const mockGetAccessToken = jest.fn();
const mockValidateSessionById = jest.fn();

jest.mock('../session.service', () => ({
  __esModule: true,
  default: {
    deactivateSession: (...a: unknown[]) => mockDeactivate(...a),
    getAccessToken: (...a: unknown[]) => mockGetAccessToken(...a),
    validateSessionById: (...a: unknown[]) => mockValidateSessionById(...a),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { deviceSessionAccounts } from '../../db/schema/deviceSessionAccounts';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import deviceSessionService, { projectState } from '../deviceSession.service';

/** A real `users` row — `device_session_accounts.account_id` has a real FK. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A device id unique to one test, so the shared database never cross-talks. */
function deviceId(): string {
  return `dev-${randomUUID()}`;
}

/** The stored device row, read straight from Postgres (not through the service). */
async function storedDevice(device: string) {
  const [row] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, device))
    .limit(1);
  return row;
}

/** The stored account rows for a device, in the service's own read order. */
async function storedAccounts(device: string) {
  const row = await storedDevice(device);
  return getDb()
    .select()
    .from(deviceSessionAccounts)
    .where(eq(deviceSessionAccounts.deviceSessionId, row.id))
    .orderBy(deviceSessionAccounts.addedAt, deviceSessionAccounts.authuser);
}

const sha256 = (value: string) =>
  nodeCrypto.createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateSessionById.mockResolvedValue({ session: {} });
});

describe('projectState', () => {
  it('maps a row to DeviceSessionState and omits operatedByUserId for a personal account', () => {
    expect(
      projectState({
        id: 'row1',
        deviceId: 'd1',
        activeAccountId: 'a1',
        secretHash: null,
        prevSecretHash: null,
        prevSecretExpiresAt: null,
        backgroundSecretHash: null,
        backgroundSecretAccountId: null,
        backgroundSecretExpiresAt: null,
        revision: 2,
        updatedAt: new Date(1720000000000),
        accounts: [
          { accountId: 'a1', sessionId: 's1', authuser: 0, operatedByUserId: null },
        ],
      })
    ).toEqual({
      deviceId: 'd1',
      accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }],
      activeAccountId: 'a1',
      revision: 2,
      updatedAt: 1720000000000,
    });
  });

  it('surfaces operatedByUserId for a DELEGATED account', () => {
    const state = projectState({
      id: 'row1',
      deviceId: 'd1',
      activeAccountId: 'org1',
      secretHash: null,
      prevSecretHash: null,
      prevSecretExpiresAt: null,
      backgroundSecretHash: null,
      backgroundSecretAccountId: null,
      backgroundSecretExpiresAt: null,
      revision: 1,
      updatedAt: new Date(1720000000000),
      accounts: [
        { accountId: 'org1', sessionId: 's-org', authuser: 0, operatedByUserId: 'op1' },
      ],
    });
    expect(state.accounts[0].operatedByUserId).toBe('op1');
  });
});

describe('getState', () => {
  it('creates an empty device row on first read and is idempotent', async () => {
    const device = deviceId();
    const first = await deviceSessionService.getState(device);
    expect(first).toEqual({
      deviceId: device,
      accounts: [],
      activeAccountId: null,
      revision: 0,
      updatedAt: expect.any(Number),
    });

    const second = await deviceSessionService.getState(device);
    expect(second.revision).toBe(0);
    // Still exactly one row — the create path is an upsert, not a duplicate.
    const rows = await getDb()
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, device));
    expect(rows).toHaveLength(1);
  });
});

describe('addAccount', () => {
  it('adds a new account at authuser 0, sets it active, bumps revision', async () => {
    const device = deviceId();
    const a1 = await account();

    const { state, changed } = await deviceSessionService.addAccount(device, {
      accountId: a1,
      sessionId: 's1',
    });

    expect(changed).toBe(true);
    expect(state.activeAccountId).toBe(a1);
    expect(state.accounts).toEqual([{ accountId: a1, sessionId: 's1', authuser: 0 }]);
    expect(state.revision).toBe(1);

    const stored = await storedDevice(device);
    expect(stored.activeAccountId).toBe(a1);
    expect(stored.revision).toBe(1);
  });

  it('PERSISTS operatedByUserId onto the stored row, not merely the projection', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();

    const { state } = await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });

    expect(state.accounts[0].operatedByUserId).toBe(op1);
    const [row] = await storedAccounts(device);
    expect(row.operatedByUserId).toBe(op1);
  });

  it('stores NULL — never an empty string — for a personal account', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });

    const [row] = await storedAccounts(device);
    // The delegated/personal distinction IS this null. `''` would be a value
    // that reads as a delegated entry owned by nobody.
    expect(row.operatedByUserId).toBeNull();
  });

  it('assigns the lowest free authuser across existing accounts', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    const a3 = await account();

    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    const { state } = await deviceSessionService.addAccount(device, {
      accountId: a3,
      sessionId: 's3',
    });

    expect(state.accounts.map((a) => a.authuser)).toEqual([0, 1, 2]);
  });

  it('re-adding the same account with a DIFFERENT sessionId replaces it and deactivates the displaced session', async () => {
    const device = deviceId();
    const a1 = await account();
    const b1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's-old' });
    await deviceSessionService.addAccount(device, { accountId: b1, sessionId: 's-b' });
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    const { state, changed } = await deviceSessionService.addAccount(device, {
      accountId: a1,
      sessionId: 's-new',
    });

    expect(changed).toBe(true);
    expect(mockDeactivate).toHaveBeenCalledWith('s-old');
    expect(state.activeAccountId).toBe(a1);
    // Exactly one row per account — the unique constraint plus the delete-then-
    // insert must not leave the account listed twice with two session ids.
    const rows = await storedAccounts(device);
    expect(rows.filter((r) => r.accountId === a1)).toHaveLength(1);
    expect(rows.find((r) => r.accountId === a1)?.sessionId).toBe('s-new');
  });

  it('idempotent re-register with the SAME sessionId is a pure no-op (no deactivate, no revision bump)', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const before = await storedDevice(device);
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    const { state, changed } = await deviceSessionService.addAccount(device, {
      accountId: a1,
      sessionId: 's1',
    });

    expect(changed).toBe(false);
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(state.revision).toBe(before.revision);
    const after = await storedDevice(device);
    expect(after.revision).toBe(before.revision);
  });

  it('REGRESSION: an idempotent re-register of a NON-active account never steals active (the reload-handoff bug)', async () => {
    const device = deviceId();
    const A = await account();
    const B = await account();
    await deviceSessionService.addAccount(device, { accountId: A, sessionId: 's-A' });
    await deviceSessionService.addAccount(device, { accountId: B, sessionId: 's-B' });
    // B is active. The cold-boot handoff re-registers the still-restored A.
    const { state, changed } = await deviceSessionService.addAccount(device, {
      accountId: A,
      sessionId: 's-A',
    });

    expect(changed).toBe(false);
    expect(state.activeAccountId).toBe(B);
    expect((await storedDevice(device)).activeAccountId).toBe(B);
  });

  it("'if-empty' does NOT flip the active account when one already exists", async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });

    const { state } = await deviceSessionService.addAccount(
      device,
      { accountId: a2, sessionId: 's2' },
      { activate: 'if-empty' }
    );

    expect(state.activeAccountId).toBe(a1);
    expect((await storedDevice(device)).activeAccountId).toBe(a1);
  });

  it("'if-empty' DOES set active when the device has no active account", async () => {
    const device = deviceId();
    const a2 = await account();
    await deviceSessionService.getState(device); // create the empty device row

    const { state } = await deviceSessionService.addAccount(
      device,
      { accountId: a2, sessionId: 's2' },
      { activate: 'if-empty' }
    );

    expect(state.activeAccountId).toBe(a2);
  });

  it("default 'always' sets the new account active", async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });

    const { state } = await deviceSessionService.addAccount(device, {
      accountId: a2,
      sessionId: 's2',
    });

    expect(state.activeAccountId).toBe(a2);
  });
});

describe('switchActive', () => {
  it('returns not_found when the account is not on the device, without validating', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    expect(await deviceSessionService.switchActive(device, 'ghost')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(mockValidateSessionById).not.toHaveBeenCalled();
  });

  it('switches active and bumps revision when the target session validates', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    const before = await storedDevice(device);

    const result = await deviceSessionService.switchActive(device, a1);

    expect(mockValidateSessionById).toHaveBeenCalledWith('s1', false);
    expect(result).toEqual({
      ok: true,
      state: expect.objectContaining({ activeAccountId: a1, revision: before.revision + 1 }),
    });
    expect((await storedDevice(device)).activeAccountId).toBe(a1);
  });

  it('heals a revoked DELEGATED target: drops it from the set and does NOT commit the switch', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    await deviceSessionService.addAccount(device, { accountId: op1, sessionId: 's-op' });
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    await deviceSessionService.switchActive(device, op1);
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue(null); // target session revoked

    const result = await deviceSessionService.switchActive(device, org1);

    expect(mockDeactivate).toHaveBeenCalledWith('s-org');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the switch to be refused');
    expect(result.reason).toBe('unauthorized');
    expect(result.state.accounts.map((a) => a.accountId)).toEqual([op1]);
    // The switch itself was never committed.
    expect(result.state.activeAccountId).toBe(op1);
    expect((await storedDevice(device)).activeAccountId).toBe(op1);
  });
});

describe('getState self-heals a revoked managed active account', () => {
  it('drops the active DELEGATED account when its session fails validation and re-elects', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    await deviceSessionService.addAccount(device, { accountId: op1, sessionId: 's-op' });
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue(null);

    const state = await deviceSessionService.getState(device);

    expect(mockValidateSessionById).toHaveBeenCalledWith('s-org', false);
    expect(mockDeactivate).toHaveBeenCalledWith('s-org');
    expect(state.accounts.map((a) => a.accountId)).toEqual([op1]);
    expect(state.activeAccountId).toBe(op1);
  });

  it('keeps a DELEGATED active account whose session still validates', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    const state = await deviceSessionService.getState(device);

    expect(mockValidateSessionById).toHaveBeenCalledWith('s-org', false);
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(state.activeAccountId).toBe(org1);
  });

  it('NEVER touches a PERSONAL active account — no validation call at all', async () => {
    const device = deviceId();
    const op1 = await account();
    await deviceSessionService.addAccount(device, { accountId: op1, sessionId: 's-op' });
    jest.clearAllMocks();

    const state = await deviceSessionService.getState(device);

    // This is the delegated/personal distinction on the read path: a personal
    // entry (operated_by_user_id IS NULL) is not re-checked, so a transient
    // validation failure can never drop it.
    expect(mockValidateSessionById).not.toHaveBeenCalled();
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(state.activeAccountId).toBe(op1);
  });
});

describe('signout', () => {
  it('revokes the account session and drops it from the set', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });

    const state = await deviceSessionService.signout(device, { accountId: a1 });

    expect(mockDeactivate).toHaveBeenCalledWith('s1');
    expect(state.accounts).toHaveLength(0);
    expect(state.activeAccountId).toBeNull();
    expect(await storedAccounts(device)).toHaveLength(0);
  });

  it('CASCADES: signing out an operator also removes the accounts it operates, and never elects one as next-active', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    await deviceSessionService.addAccount(device, { accountId: op1, sessionId: 's-op' });
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    const state = await deviceSessionService.signout(device, { accountId: op1 });

    expect(mockDeactivate).toHaveBeenCalledWith('s-op');
    expect(mockDeactivate).toHaveBeenCalledWith('s-org');
    expect(mockDeactivate).toHaveBeenCalledTimes(2);
    expect(state.accounts).toHaveLength(0);
    expect(state.activeAccountId).toBeNull();
    expect(await storedAccounts(device)).toHaveLength(0);
  });

  it('does not cascade beyond one level and leaves unrelated accounts untouched', async () => {
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    const other = await account();
    await deviceSessionService.addAccount(device, { accountId: op1, sessionId: 's-op' });
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    await deviceSessionService.addAccount(device, { accountId: other, sessionId: 's-other' });
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    const state = await deviceSessionService.signout(device, { accountId: op1 });

    expect(mockDeactivate).toHaveBeenCalledWith('s-op');
    expect(mockDeactivate).toHaveBeenCalledWith('s-org');
    expect(mockDeactivate).not.toHaveBeenCalledWith('s-other');
    expect(state.accounts.map((a) => a.accountId)).toEqual([other]);
    expect(state.activeAccountId).toBe(other);
  });

  it('is a no-op for an account that is not on the device', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const before = await storedDevice(device);
    jest.clearAllMocks();

    const state = await deviceSessionService.signout(device, { accountId: 'ghost' });

    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(state.revision).toBe(before.revision);
  });
});

describe('signout — device-secret cleanup', () => {
  /*
   * These assertions read the STORED ROW, not an update payload. Clearing this
   * material is what stops a retained secret from minting a token after a
   * signout, so the property that matters is the column's value afterwards —
   * and specifically that it is NULL rather than `''`, which would be a real
   * value occupying the unique `secret_hash` slot while still reading as
   * "no secret" to `getStateBySecret`.
   */
  it('signout-ALL clears every secret column, device AND background, to NULL', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.issueDeviceSecret(device);
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    await deviceSessionService.issueBackgroundCredential(device, a1);

    const before = await storedDevice(device);
    expect(before.secretHash).not.toBeNull();
    expect(before.backgroundSecretHash).not.toBeNull();

    await deviceSessionService.signout(device, { all: true });

    const after = await storedDevice(device);
    expect(after.secretHash).toBeNull();
    expect(after.prevSecretHash).toBeNull();
    expect(after.prevSecretExpiresAt).toBeNull();
    expect(after.backgroundSecretHash).toBeNull();
    expect(after.backgroundSecretAccountId).toBeNull();
    expect(after.backgroundSecretExpiresAt).toBeNull();
  });

  it('single-account signout revokes the shared device secret', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    const previousRetainedSecret = await deviceSessionService.issueDeviceSecret(device);
    const retainedSecret = await deviceSessionService.issueDeviceSecret(device);

    await deviceSessionService.signout(device, { accountId: a1 });

    const after = await storedDevice(device);
    expect(after.secretHash).toBeNull();
    expect(after.prevSecretHash).toBeNull();
    expect(after.prevSecretExpiresAt).toBeNull();
    expect(await deviceSessionService.getStateBySecret(device, retainedSecret as string)).toBeNull();
    expect(await deviceSessionService.getStateBySecret(device, previousRetainedSecret as string)).toBeNull();
  });

  it('single-account signout DOES clear a background credential bound to the removed account', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    await deviceSessionService.issueDeviceSecret(device);
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    await deviceSessionService.issueBackgroundCredential(device, a1);

    await deviceSessionService.signout(device, { accountId: a1 });

    const after = await storedDevice(device);
    expect(after.backgroundSecretHash).toBeNull();
    expect(after.backgroundSecretAccountId).toBeNull();
    // The device secret is shared, so removing any account must revoke it too.
    expect(after.secretHash).toBeNull();
  });

  it('single-account signout leaves a background credential bound to a DIFFERENT account alone', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    await deviceSessionService.issueBackgroundCredential(device, a2);
    const before = await storedDevice(device);

    await deviceSessionService.signout(device, { accountId: a1 });

    const after = await storedDevice(device);
    expect(after.backgroundSecretHash).toBe(before.backgroundSecretHash);
    expect(after.backgroundSecretAccountId).toBe(a2);
  });
});

describe('issueDeviceSecret', () => {
  it('mints a fresh secret, stores only its hash, and leaves no prev on first issuance', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);

    const secret = await deviceSessionService.issueDeviceSecret(device);

    expect(typeof secret).toBe('string');
    expect((secret as string).length).toBeGreaterThan(20);
    const stored = await storedDevice(device);
    // Only the HASH is stored, never the raw value.
    expect(stored.secretHash).toBe(sha256(secret as string));
    expect(stored.secretHash).not.toBe(secret);
    expect(stored.prevSecretHash).toBeNull();
    expect(stored.prevSecretExpiresAt).toBeNull();
  });

  it('binds the FIRST secret on a row whose secret_hash is NULL', async () => {
    // The CAS guard for a never-bound device is `secret_hash IS NULL`. Mongo
    // expressed it as `{$exists: false}` only because a sparse unique index
    // collides on nulls; comparing against `''` here would match nothing and
    // silently never bind a first secret.
    const device = deviceId();
    await deviceSessionService.getState(device);
    expect((await storedDevice(device)).secretHash).toBeNull();

    expect(await deviceSessionService.issueDeviceSecret(device)).not.toBeNull();
    expect((await storedDevice(device)).secretHash).not.toBeNull();
  });

  it('rotates: moves the existing secret to prev with a ~60s grace and sets the new one', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    const first = await deviceSessionService.issueDeviceSecret(device);
    const firstHash = sha256(first as string);

    const before = Date.now();
    const second = await deviceSessionService.issueDeviceSecret(device);
    const after = Date.now();

    expect(second).not.toBe(first);
    const stored = await storedDevice(device);
    expect(stored.prevSecretHash).toBe(firstHash);
    expect(stored.secretHash).toBe(sha256(second as string));
    const grace = stored.prevSecretExpiresAt as Date;
    expect(grace.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(grace.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it('returns null for a device row that does not exist (never binds a phantom device)', async () => {
    expect(await deviceSessionService.issueDeviceSecret(deviceId())).toBeNull();
  });

  it('two devices can both sit at a NULL secret_hash — NULLs are distinct in Postgres', async () => {
    // The sparse-unique workaround did not travel. If NULL were replaced by
    // `''` this would violate `device_sessions_secret_hash_key`.
    const one = deviceId();
    const two = deviceId();
    await deviceSessionService.getState(one);
    await deviceSessionService.getState(two);
    expect((await storedDevice(one)).secretHash).toBeNull();
    expect((await storedDevice(two)).secretHash).toBeNull();
  });
});

describe('getStateBySecret', () => {
  it('returns the projected state for the current secret', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const secret = await deviceSessionService.issueDeviceSecret(device);

    const state = await deviceSessionService.getStateBySecret(device, secret as string);

    expect(state?.deviceId).toBe(device);
    expect(state?.activeAccountId).toBe(a1);
  });

  it('accepts the PREVIOUS secret within the grace window', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    const first = await deviceSessionService.issueDeviceSecret(device);
    await deviceSessionService.issueDeviceSecret(device); // rotate

    const state = await deviceSessionService.getStateBySecret(device, first as string);
    expect(state?.deviceId).toBe(device);
  });

  it('rejects the previous secret once the grace window has expired', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    const first = await deviceSessionService.issueDeviceSecret(device);
    await deviceSessionService.issueDeviceSecret(device);
    // Expire the grace directly in the database rather than waiting 60s.
    await getDb()
      .update(deviceSessions)
      .set({ prevSecretExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceSessions.deviceId, device));

    expect(await deviceSessionService.getStateBySecret(device, first as string)).toBeNull();
  });

  it('returns null on a secret mismatch, for a secret-less row, and for an unknown device', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    // No secret bound yet.
    expect(await deviceSessionService.getStateBySecret(device, 'nope')).toBeNull();

    await deviceSessionService.issueDeviceSecret(device);
    expect(await deviceSessionService.getStateBySecret(device, 'wrong-secret')).toBeNull();
    expect(await deviceSessionService.getStateBySecret(deviceId(), 'anything')).toBeNull();
  });

  it('short-circuits on empty inputs', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    await deviceSessionService.issueDeviceSecret(device);
    expect(await deviceSessionService.getStateBySecret(device, '')).toBeNull();
    expect(await deviceSessionService.getStateBySecret('', 'x')).toBeNull();
  });
});

describe('background credential', () => {
  it('provisions for a member account and mints without rotating the secret', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    mockGetAccessToken.mockResolvedValue({
      accessToken: 'jwt',
      expiresAt: new Date('2026-07-07T00:00:00.000Z'),
    });

    const issued = await deviceSessionService.issueBackgroundCredential(device, a1);
    expect(issued?.accountId).toBe(a1);
    const stored = await storedDevice(device);
    expect(stored.backgroundSecretHash).toBe(sha256(issued?.secret as string));

    const minted = await deviceSessionService.mintFromBackgroundSecret(
      device,
      issued?.secret as string
    );
    expect(minted).toEqual({
      ok: true,
      accessToken: 'jwt',
      expiresAt: '2026-07-07T00:00:00.000Z',
      accountId: a1,
    });
    // NEVER rotates the presented secret.
    expect((await storedDevice(device)).backgroundSecretHash).toBe(stored.backgroundSecretHash);
  });

  it('refuses to provision for an account that is not on the device', async () => {
    const device = deviceId();
    const a1 = await account();
    const ghost = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    expect(await deviceSessionService.issueBackgroundCredential(device, ghost)).toBeNull();
  });

  it('rejects an invalid or expired credential', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    const issued = await deviceSessionService.issueBackgroundCredential(device, a1);

    expect(await deviceSessionService.mintFromBackgroundSecret(device, 'wrong')).toEqual({
      ok: false,
      reason: 'background_credential_invalid',
    });

    await getDb()
      .update(deviceSessions)
      .set({ backgroundSecretExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceSessions.deviceId, device));
    expect(
      await deviceSessionService.mintFromBackgroundSecret(device, issued?.secret as string)
    ).toEqual({ ok: false, reason: 'background_credential_invalid' });
  });

  it('distinguishes a live credential whose bound account left the device', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    const issued = await deviceSessionService.issueBackgroundCredential(device, a2);
    // Remove a2 WITHOUT going through signout, so the credential survives and
    // the bound account is simply absent from the set.
    const row = await storedDevice(device);
    await getDb()
      .delete(deviceSessionAccounts)
      .where(
        and(
          eq(deviceSessionAccounts.deviceSessionId, row.id),
          eq(deviceSessionAccounts.accountId, a2)
        )
      );

    expect(
      await deviceSessionService.mintFromBackgroundSecret(device, issued?.secret as string)
    ).toEqual({ ok: false, reason: 'account_not_on_device' });
  });
});

describe('resolveTokenForAccount / resolveActiveToken', () => {
  it('mints a NON-active member account token after re-validating its session', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    await deviceSessionService.switchActive(device, a1);
    const state = await deviceSessionService.getState(device);
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });
    mockGetAccessToken.mockResolvedValue({
      accessToken: 'jwt-a2',
      expiresAt: new Date('2026-07-07T00:00:00.000Z'),
    });

    expect(await deviceSessionService.resolveTokenForAccount(state, a2)).toEqual({
      accessToken: 'jwt-a2',
      expiresAt: '2026-07-07T00:00:00.000Z',
    });
    expect(mockValidateSessionById).toHaveBeenCalledWith('s2', false);
  });

  it('is READ-ONLY: resolving a pinned account performs no device-row write at all', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    const state = await deviceSessionService.getState(device);
    const before = await storedDevice(device);
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });

    await deviceSessionService.resolveTokenForAccount(state, a1);

    const after = await storedDevice(device);
    // Nothing another app on this device could observe.
    expect(after.revision).toBe(before.revision);
    expect(after.activeAccountId).toBe(before.activeAccountId);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('returns null for a non-member, a revoked session, and a session that cannot mint', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const state = await deviceSessionService.getState(device);

    jest.clearAllMocks();
    expect(await deviceSessionService.resolveTokenForAccount(state, 'ghost')).toBeNull();
    expect(mockValidateSessionById).not.toHaveBeenCalled();

    mockValidateSessionById.mockResolvedValueOnce(null);
    expect(await deviceSessionService.resolveTokenForAccount(state, a1)).toBeNull();
    expect(mockGetAccessToken).not.toHaveBeenCalled();

    mockValidateSessionById.mockResolvedValue({ session: {} });
    mockGetAccessToken.mockResolvedValueOnce(null);
    expect(await deviceSessionService.resolveTokenForAccount(state, a1)).toBeNull();
  });

  it('resolveActiveToken is the active-account case, and null with no active account', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const state = await deviceSessionService.getState(device);
    mockGetAccessToken.mockResolvedValue({
      accessToken: 'jwt-a1',
      expiresAt: new Date('2026-07-07T00:00:00.000Z'),
    });

    expect(await deviceSessionService.resolveActiveToken(state)).toEqual({
      accessToken: 'jwt-a1',
      expiresAt: '2026-07-07T00:00:00.000Z',
    });
    expect(
      await deviceSessionService.resolveActiveToken({ ...state, activeAccountId: null })
    ).toBeNull();
  });
});

describe('detachMigratedAccount', () => {
  it('drops the entry WITHOUT deactivating the migrated (preserved) session', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 'migrated-sess' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    await deviceSessionService.switchActive(device, a1);
    jest.clearAllMocks();

    await deviceSessionService.detachMigratedAccount(device, a1, 'migrated-sess');

    expect(mockDeactivate).not.toHaveBeenCalled();
    const rows = await storedAccounts(device);
    expect(rows.map((r) => r.sessionId)).toEqual(['s2']);
    expect((await storedDevice(device)).activeAccountId).toBe(a2);
  });

  it('deactivates a DIFFERENT stale session the old row referenced', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 'stale-sess' });
    jest.clearAllMocks();

    await deviceSessionService.detachMigratedAccount(device, a1, 'migrated-sess');

    expect(mockDeactivate).toHaveBeenCalledWith('stale-sess');
    expect(await storedAccounts(device)).toHaveLength(0);
    expect((await storedDevice(device)).activeAccountId).toBeNull();
  });

  it('is a no-op when the device row is absent or the account is not listed', async () => {
    const absent = deviceId();
    await deviceSessionService.detachMigratedAccount(absent, 'a1', 'migrated-sess');
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(await storedDevice(absent)).toBeUndefined();

    const device = deviceId();
    const other = await account();
    await deviceSessionService.addAccount(device, { accountId: other, sessionId: 's-other' });
    const before = await storedDevice(device);
    jest.clearAllMocks();

    await deviceSessionService.detachMigratedAccount(device, 'a1', 'migrated-sess');

    expect(mockDeactivate).not.toHaveBeenCalled();
    expect((await storedDevice(device)).revision).toBe(before.revision);
  });
});

describe('purgeAccountFromAllDevices', () => {
  it('signs the account out of every device that lists it, and touches no other device', async () => {
    const d1 = deviceId();
    const d2 = deviceId();
    const untouched = deviceId();
    const u1 = await account();
    const other = await account();
    await deviceSessionService.addAccount(d1, { accountId: u1, sessionId: 's1' });
    await deviceSessionService.addAccount(d2, { accountId: u1, sessionId: 's2' });
    await deviceSessionService.addAccount(untouched, { accountId: other, sessionId: 's3' });
    const untouchedBefore = await storedDevice(untouched);
    jest.clearAllMocks();
    mockValidateSessionById.mockResolvedValue({ session: {} });

    await deviceSessionService.purgeAccountFromAllDevices(u1);

    expect(mockDeactivate).toHaveBeenCalledWith('s1');
    expect(mockDeactivate).toHaveBeenCalledWith('s2');
    expect(mockDeactivate).toHaveBeenCalledTimes(2);
    expect(await storedAccounts(d1)).toHaveLength(0);
    expect(await storedAccounts(d2)).toHaveLength(0);
    expect((await storedDevice(untouched)).revision).toBe(untouchedBefore.revision);
  });
});

describe('foreign keys enforce what the service assumes', () => {
  it('deleting an ACCOUNT removes its entry from every device (ON DELETE CASCADE)', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });

    await getDb().delete(users).where(eq(users.id, a1));

    const rows = await storedAccounts(device);
    expect(rows.map((r) => r.accountId)).toEqual([a2]);
  });

  it('deleting an OPERATOR deletes the delegated ENTRY — it is never laundered into a personal one', async () => {
    /*
     * `operated_by_user_id` is ON DELETE CASCADE, deliberately not SET NULL.
     * NULL there means "not a delegated session", so SET NULL would leave the
     * managed account sitting on the device as an ordinary entry — mintable
     * with no `account:act_as` re-check at all. This test is the guard on that:
     * it fails if the constraint is ever weakened to SET NULL, because the row
     * would survive with a NULL operator instead of disappearing.
     */
    const device = deviceId();
    const op1 = await account();
    const org1 = await account();
    await deviceSessionService.addAccount(device, {
      accountId: org1,
      sessionId: 's-org',
      operatedByUserId: op1,
    });
    expect((await storedAccounts(device))).toHaveLength(1);

    await getDb().delete(users).where(eq(users.id, op1));

    const rows = await storedAccounts(device);
    expect(rows).toHaveLength(0);
    expect(rows.find((r) => r.accountId === org1)).toBeUndefined();
  });

  it('deleting the ACTIVE account nulls active_account_id without deleting the device (ON DELETE SET NULL)', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    expect((await storedDevice(device)).activeAccountId).toBe(a1);

    await getDb().delete(users).where(eq(users.id, a1));

    const after = await storedDevice(device);
    expect(after).toBeDefined();
    expect(after.activeAccountId).toBeNull();
  });
});
