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
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { devicePrincipals } from '../../db/schema/devicePrincipals';
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

/** The stored holder-credential hashes of a device, read straight from Postgres. */
async function storedCredentialHashes(device: string): Promise<string[]> {
  const rows = await getDb()
    .select({ secretHash: deviceCredentials.secretHash })
    .from(deviceCredentials)
    .innerJoin(deviceSessions, eq(deviceCredentials.deviceSessionId, deviceSessions.id))
    .where(eq(deviceSessions.deviceId, device));
  return rows.map((row) => row.secretHash);
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

  it('revokes a background credential when its account session is replaced', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's-old' });
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt-old', expiresAt: new Date() });
    const credential = await deviceSessionService.issueBackgroundCredential(device, a1);
    mockGetAccessToken.mockClear();

    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's-new' });

    const stored = await storedDevice(device);
    expect(stored.backgroundSecretHash).toBeNull();
    expect(stored.backgroundSecretAccountId).toBeNull();
    expect(stored.backgroundSecretExpiresAt).toBeNull();
    expect(
      await deviceSessionService.mintFromBackgroundSecret(device, credential?.secret as string)
    ).toEqual({ ok: false, reason: 'background_credential_invalid' });
    expect(mockGetAccessToken).not.toHaveBeenCalled();
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

describe('signout — holder credentials (ADR 0029 D2)', () => {
  /*
   * The browser's DeviceSession is shared by every official web app, each with
   * its own `device_credentials` row. These read the STORED rows: whether a
   * holder can still mint after a sign-out is the property that matters.
   */
  it('signout-ALL deletes every holder credential and clears the background one to NULL', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const auth = await deviceSessionService.issueDeviceSecret(device);
    const app = await deviceSessionService.issueDeviceSecret(device);
    mockGetAccessToken.mockResolvedValue({ accessToken: 'jwt', expiresAt: new Date() });
    await deviceSessionService.issueBackgroundCredential(device, a1);

    expect(await storedCredentialHashes(device)).toHaveLength(2);
    expect((await storedDevice(device)).backgroundSecretHash).not.toBeNull();

    await deviceSessionService.signout(device, { all: true });

    const after = await storedDevice(device);
    expect(await storedCredentialHashes(device)).toEqual([]);
    expect(after.backgroundSecretHash).toBeNull();
    expect(after.backgroundSecretAccountId).toBeNull();
    expect(after.backgroundSecretExpiresAt).toBeNull();
    expect(await deviceSessionService.getStateBySecret(device, auth as string)).toBeNull();
    expect(await deviceSessionService.getStateBySecret(device, app as string)).toBeNull();
  });

  it('single-account signout keeps EVERY holder minting for the account that remains', async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    const auth = await deviceSessionService.issueDeviceSecret(device);
    const app = await deviceSessionService.issueDeviceSecret(device);

    await deviceSessionService.signout(device, { accountId: a1 });

    expect(await storedCredentialHashes(device)).toHaveLength(2);
    for (const secret of [auth, app]) {
      const state = await deviceSessionService.getStateBySecret(device, secret as string);
      expect(state?.accounts.map((a) => a.accountId)).toEqual([a2]);
      expect(state?.activeAccountId).toBe(a2);
    }
  });

  it('signing out the LAST account revokes every holder credential', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const auth = await deviceSessionService.issueDeviceSecret(device);
    const app = await deviceSessionService.issueDeviceSecret(device);

    await deviceSessionService.signout(device, { accountId: a1 });

    expect(await storedCredentialHashes(device)).toEqual([]);
    expect(await deviceSessionService.getStateBySecret(device, auth as string)).toBeNull();
    expect(await deviceSessionService.getStateBySecret(device, app as string)).toBeNull();
  });

  it('detaching the last account of a device revokes its holder credentials too', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.issueDeviceSecret(device);

    await deviceSessionService.detachMigratedAccount(device, a1, 'migrated-sess');

    expect(await storedCredentialHashes(device)).toEqual([]);
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
    // The holder credential is the browser's, not a1's: a2 is still here.
    expect(await storedCredentialHashes(device)).toHaveLength(1);
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
  it('mints a fresh secret and stores only its hash, as a holder credential', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);

    const secret = await deviceSessionService.issueDeviceSecret(device);

    expect(typeof secret).toBe('string');
    expect((secret as string).length).toBeGreaterThan(20);
    // Only the HASH is stored, never the raw value.
    expect(await storedCredentialHashes(device)).toEqual([sha256(secret as string)]);
  });

  it('ADDS a credential per holder and never rotates an earlier one out', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const first = await deviceSessionService.issueDeviceSecret(device);
    const second = await deviceSessionService.issueDeviceSecret(device);

    expect(second).not.toBe(first);
    expect((await storedCredentialHashes(device)).sort()).toEqual(
      [sha256(first as string), sha256(second as string)].sort(),
    );
    expect((await deviceSessionService.getStateBySecret(device, first as string))?.activeAccountId).toBe(a1);
    expect((await deviceSessionService.getStateBySecret(device, second as string))?.activeAccountId).toBe(a1);
  });

  it('keeps at most 32 holders per device, evicting the least recently used', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    const oldest = await deviceSessionService.issueDeviceSecret(device);
    await getDb()
      .update(deviceCredentials)
      .set({ lastUsedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(deviceCredentials.secretHash, sha256(oldest as string)));
    for (let i = 0; i < 32; i += 1) {
      await deviceSessionService.issueDeviceSecret(device);
    }

    const hashes = await storedCredentialHashes(device);
    expect(hashes).toHaveLength(32);
    expect(hashes).not.toContain(sha256(oldest as string));
  });

  it('returns null for a device row that does not exist (never binds a phantom device)', async () => {
    expect(await deviceSessionService.issueDeviceSecret(deviceId())).toBeNull();
  });
});

describe('getStateBySecret', () => {
  it('returns the projected state for a holder credential', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const secret = await deviceSessionService.issueDeviceSecret(device);

    const state = await deviceSessionService.getStateBySecret(device, secret as string);

    expect(state?.deviceId).toBe(device);
    expect(state?.activeAccountId).toBe(a1);
  });

  it("refuses another device's credential presented under this device's id", async () => {
    const mine = deviceId();
    const theirs = deviceId();
    await deviceSessionService.getState(mine);
    await deviceSessionService.getState(theirs);
    const theirSecret = await deviceSessionService.issueDeviceSecret(theirs);

    expect(await deviceSessionService.getStateBySecret(mine, theirSecret as string)).toBeNull();
  });

  it('refreshes a stale last_used_at on use, and leaves a fresh one alone', async () => {
    const device = deviceId();
    await deviceSessionService.getState(device);
    const secret = await deviceSessionService.issueDeviceSecret(device);
    const hash = sha256(secret as string);
    const stale = new Date(Date.now() - 2 * 3_600_000);
    await getDb().update(deviceCredentials).set({ lastUsedAt: stale }).where(eq(deviceCredentials.secretHash, hash));

    await deviceSessionService.getStateBySecret(device, secret as string);
    const [touched] = await getDb()
      .select({ lastUsedAt: deviceCredentials.lastUsedAt })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.secretHash, hash));
    expect(touched.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());

    await deviceSessionService.getStateBySecret(device, secret as string);
    const [again] = await getDb()
      .select({ lastUsedAt: deviceCredentials.lastUsedAt })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.secretHash, hash));
    expect(again.lastUsedAt.getTime()).toBe(touched.lastUsedAt.getTime());
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
      .delete(deviceAccountContexts)
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, row.id),
          eq(deviceAccountContexts.accountId, a2)
        )
      );

    expect(
      await deviceSessionService.mintFromBackgroundSecret(device, issued?.secret as string)
    ).toEqual({ ok: false, reason: 'account_not_on_device' });
  });
});

describe('resolveTokenForAccount / resolveActiveToken', () => {
  it("mints a NON-active member account token, from that account's own session", async () => {
    const device = deviceId();
    const a1 = await account();
    const a2 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    await deviceSessionService.addAccount(device, { accountId: a2, sessionId: 's2' });
    await deviceSessionService.switchActive(device, a1);
    const state = await deviceSessionService.getState(device);
    jest.clearAllMocks();
    mockGetAccessToken.mockResolvedValue({
      accessToken: 'jwt-a2',
      expiresAt: new Date('2026-07-07T00:00:00.000Z'),
    });

    expect(await deviceSessionService.resolveTokenForAccount(state, a2)).toEqual({
      accessToken: 'jwt-a2',
      expiresAt: '2026-07-07T00:00:00.000Z',
    });
    // `s2`, not the ACTIVE account's `s1` — and `getAccessToken` is the only
    // session call, because it is itself the re-validation (see the method).
    expect(mockGetAccessToken).toHaveBeenCalledWith('s2');
    expect(mockValidateSessionById).not.toHaveBeenCalled();
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

  it('returns null for a non-member, and for a session that cannot mint', async () => {
    const device = deviceId();
    const a1 = await account();
    await deviceSessionService.addAccount(device, { accountId: a1, sessionId: 's1' });
    const state = await deviceSessionService.getState(device);

    jest.clearAllMocks();
    // A non-member is refused off the device state alone — the session service
    // is never reached, so an unknown accountId cannot mint anything.
    expect(await deviceSessionService.resolveTokenForAccount(state, 'ghost')).toBeNull();
    expect(mockGetAccessToken).not.toHaveBeenCalled();

    // A revoked session and a session that cannot mint are ONE case here:
    // `getAccessToken` answers null for both, and the caller must not be able
    // to tell them apart (see the pinned mint route).
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
