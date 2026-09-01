/**
 * `session.service` against a REAL Postgres.
 *
 * This replaces two suites that mocked the Mongoose model wholesale
 * (`session.service.test.ts` and `session.service.managedSwitch.test.ts`) and
 * therefore asserted on `$set` payload SHAPES — proving the call was BUILT as
 * expected, never that the stored row was correct. Every case below runs the
 * real service against the throwaway database and reads the row back.
 *
 * Three collaborators stay mocked, and none of them is the subject:
 *  - `models/User` — the user half of `getSessionWithUser` is the one remaining
 *    Mongoose read in the service (see the note at its import).
 *  - `securityActivityService` — a different batch, still on Mongoose.
 *  - `account.service` — the `account:act_as` membership oracle, imported
 *    lazily; mocking it is what lets a test revoke membership deterministically.
 *
 * `utils/socket` is mocked for the opposite reason: the migration path emits a
 * device-state broadcast, and the emit is the assertion.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';

/*
 * The global `jest.setup.cjs` mocks `jsonwebtoken` to a constant string. That is
 * fine against a mocked driver, but `sessions.access_token` / `refresh_token`
 * are really UNIQUE here, so a constant token makes the SECOND insert of the
 * suite fail on `sessions_access_token_key`. Restoring the real signer is not a
 * workaround for the constraint — it is what lets these tests assert on the
 * claims the service actually mints.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

const mockVerifyActingAs = jest.fn();
const mockLogDeviceAdded = jest.fn();
const mockBroadcastDeviceState = jest.fn();

jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...a: unknown[]) => mockBroadcastDeviceState(...a),
  broadcastSessionAccountsChanged: jest.fn(),
}));

jest.mock('../account.service.js', () => ({
  __esModule: true,
  accountService: { verifyActingAs: (...a: unknown[]) => mockVerifyActingAs(...a) },
}));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: (...a: unknown[]) => mockLogDeviceAdded(...a) },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import { validateAccessToken } from '../../utils/sessionUtils';
import { deviceSessions } from '../../db/schema/deviceSessions';
import deviceSessionService from '../deviceSession.service';
import sessionService from '../session.service';

const SESSION_EXPIRES_IN = 7 * 24 * 60 * 60 * 1000;

/** A minimal Express request carrying only what `extractDeviceInfo` reads. */
function request(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'accept-language': 'en-US',
      ...headers,
    },
  } as unknown as Request;
}

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

async function storedSession(sessionId: string) {
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  return row;
}

const deviceId = () => `dev-${randomUUID()}`;

/** A registered application plus one credential, for the binding cases. */
async function applicationRow(): Promise<{ id: string; clientId: string }> {
  const owner = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      redirectUris: ['https://example.test/cb'],
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
  return { id: app.id, clientId };
}

beforeAll(async () => {
  await connectPostgres();
  // The service mints real JWTs and this suite verifies their claims, so these
  // are set rather than mocked — `sessionUtils` reads them at call time.
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionCache.clear();
  mockVerifyActingAs.mockResolvedValue('admin');
  mockLogDeviceAdded.mockResolvedValue(undefined);
});

describe('createSession', () => {
  it('creates a session and stores the flattened device columns', async () => {
    const user = await account();
    const device = deviceId();

    const session = await sessionService.createSession(user, request(), {
      deviceId: device,
      deviceName: 'My Laptop',
    });

    expect(session.sessionId).toEqual(expect.any(String));
    expect(session.deviceId).toBe(device);
    expect(session.userId).toBe(user);

    const stored = await storedSession(session.sessionId);
    // `deviceInfo` was a nested subdocument in Mongo; these are real columns.
    expect(stored.deviceName).toBe('My Laptop');
    expect(stored.deviceType).toBe('desktop');
    expect(stored.browser).toBe('Chrome');
    expect(stored.os).toBe('Windows');
    expect(stored.lastActiveAt).toBeInstanceOf(Date);
    expect(stored.isActive).toBe(true);
  });

  it('generates a unique session id per session', async () => {
    const user = await account();
    const a = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const b = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('mints an access token whose claims address this session and device', async () => {
    const user = await account();
    const device = deviceId();
    const session = await sessionService.createSession(user, request(), { deviceId: device });

    const decoded = validateAccessToken(session.accessToken);
    expect(decoded.valid).toBe(true);
    expect(decoded.payload?.userId).toBe(user);
    expect(decoded.payload?.sessionId).toBe(session.sessionId);
    expect(decoded.payload?.deviceId).toBe(device);
  });

  it('reuses the SAME session for repeated exchanges of one (user, clientOrigin)', async () => {
    const user = await account();
    const first = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });
    const second = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('creates DIFFERENT sessions for two different clientOrigins (per-RP deviceId)', async () => {
    const user = await account();
    const a = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://one.example',
    });
    const b = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://two.example',
    });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.deviceId).not.toBe(a.deviceId);
  });

  it('uses an explicit deviceId verbatim, and it wins over stableDeviceKey', async () => {
    const user = await account();
    const device = deviceId();
    const session = await sessionService.createSession(user, request(), {
      deviceId: device,
      stableDeviceKey: 'https://ignored.example',
    });
    expect(session.deviceId).toBe(device);
  });

  it('reuses the same session across repeated calls with the same explicit deviceId', async () => {
    const user = await account();
    const device = deviceId();
    const first = await sessionService.createSession(user, request(), { deviceId: device });
    const second = await sessionService.createSession(user, request(), { deviceId: device });
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('migrates a reused legacy per-origin session onto the caller central device', async () => {
    const user = await account();
    const central = deviceId();
    const legacy = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });

    const migrated = await sessionService.createSession(user, request(), {
      deviceId: central,
      stableDeviceKey: 'https://rp.example',
    });

    expect(migrated.sessionId).toBe(legacy.sessionId);
    expect(migrated.deviceId).toBe(central);
    expect((await storedSession(legacy.sessionId)).deviceId).toBe(central);
  });

  /**
   * The detach advances the OLD device's `revision`, and for a long time it did
   * so SILENTLY — the one revision bump in `deviceSession.service` with no
   * broadcast beside it. A client still listening on that device room then held
   * a revision the server had moved past, with no event that would ever tell it
   * to re-fetch: a graveyard device has no next mutation to converge on.
   */
  it('announces the OLD device state when a reused session migrates off it', async () => {
    const user = await account();
    const central = deviceId();
    const legacy = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });
    await deviceSessionService.addAccount(legacy.deviceId, {
      accountId: user,
      sessionId: legacy.sessionId,
    });
    const [before] = await getDb()
      .select({ revision: deviceSessions.revision })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, legacy.deviceId))
      .limit(1);
    mockBroadcastDeviceState.mockClear();

    await sessionService.createSession(user, request(), {
      deviceId: central,
      stableDeviceKey: 'https://rp.example',
    });

    expect(mockBroadcastDeviceState).toHaveBeenCalledTimes(1);
    const [state] = mockBroadcastDeviceState.mock.calls[0] as [
      { deviceId: string; revision: number; accounts: unknown[] },
    ];
    expect(state.deviceId).toBe(legacy.deviceId);
    expect(state.revision).toBeGreaterThan(before.revision);
    expect(state.accounts).toEqual([]);
  });

  it('says nothing when the migration had no old device entry to detach', async () => {
    const user = await account();
    const central = deviceId();
    await sessionService.createSession(user, request(), { stableDeviceKey: 'https://rp.other' });
    mockBroadcastDeviceState.mockClear();

    await sessionService.createSession(user, request(), {
      deviceId: central,
      stableDeviceKey: 'https://rp.other',
    });

    expect(mockBroadcastDeviceState).not.toHaveBeenCalled();
  });

  it('does NOT migrate on reuse when no explicit deviceId is supplied', async () => {
    const user = await account();
    const first = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });
    const second = await sessionService.createSession(user, request(), {
      stableDeviceKey: 'https://rp.example',
    });
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('binds operatedByUserId on a switched (managed) session, and NULL on an ordinary one', async () => {
    const operator = await account();
    const managed = await account();

    const delegated = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });
    const ordinary = await sessionService.createSession(await account(), request(), {
      deviceId: deviceId(),
    });

    expect((await storedSession(delegated.sessionId)).operatedByUserId).toBe(operator);
    // NULL is the distinction: "not a delegated session".
    expect((await storedSession(ordinary.sessionId)).operatedByUserId).toBeNull();
  });

  /**
   * One device can hold two people who both act as the same organization
   * (issue #937, ADR 0001). Reuse keyed on `(user, device)` alone collapses them
   * onto ONE row and then rewrites `operated_by_user_id` — so the audit actor
   * changes underneath a live session, and removing either person revokes the
   * other's access to an account they hold in their own right.
   */
  it('never reuses ANOTHER operator’s delegated session on the same device', async () => {
    const org = await account({ kind: 'organization' });
    const nate = await account();
    const alice = await account();
    const device = deviceId();

    const viaNate = await sessionService.createSession(org, request(), {
      deviceId: device,
      operatedByUserId: nate,
    });
    const viaAlice = await sessionService.createSession(org, request(), {
      deviceId: device,
      operatedByUserId: alice,
    });

    expect(viaAlice.sessionId).not.toBe(viaNate.sessionId);
    expect((await storedSession(viaNate.sessionId)).operatedByUserId).toBe(nate);
    expect((await storedSession(viaNate.sessionId)).isActive).toBe(true);
    expect((await storedSession(viaAlice.sessionId)).operatedByUserId).toBe(alice);
  });

  it('still reuses the SAME operator’s delegated session', async () => {
    const org = await account({ kind: 'organization' });
    const nate = await account();
    const device = deviceId();

    const first = await sessionService.createSession(org, request(), {
      deviceId: device,
      operatedByUserId: nate,
    });
    const second = await sessionService.createSession(org, request(), {
      deviceId: device,
      operatedByUserId: nate,
    });

    expect(second.sessionId).toBe(first.sessionId);
  });
});

describe('getSession', () => {
  it('returns an active, unexpired session', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    sessionCache.clear();

    const found = await sessionService.getSession(created.sessionId, false);
    expect(found?.sessionId).toBe(created.sessionId);
  });

  it('rejects an EXPIRED session — the read filters expiry itself', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    // Correctness must not depend on the expiry sweep having run.
    expect(await sessionService.getSession(created.sessionId, false)).toBeNull();
  });

  it('rejects a DEACTIVATED session', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await sessionService.deactivateSession(created.sessionId);
    sessionCache.clear();

    expect(await sessionService.getSession(created.sessionId, false)).toBeNull();
  });
});

describe('deactivateSession / deactivateAllUserSessions', () => {
  it('deactivates without deleting the row', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });

    expect(await sessionService.deactivateSession(created.sessionId)).toBe(true);

    // Nothing in the codebase deletes a session row — only the expiry sweep.
    const stored = await storedSession(created.sessionId);
    expect(stored).toBeDefined();
    expect(stored.isActive).toBe(false);
  });

  it('reports false when there was no active session to deactivate', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await sessionService.deactivateSession(created.sessionId);

    expect(await sessionService.deactivateSession(created.sessionId)).toBe(false);
  });

  it('deactivates every session of a user except the excluded one', async () => {
    const user = await account();
    const keep = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const dropA = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const dropB = await sessionService.createSession(user, request(), { deviceId: deviceId() });

    expect(await sessionService.deactivateAllUserSessions(user, keep.sessionId)).toBe(2);

    expect((await storedSession(keep.sessionId)).isActive).toBe(true);
    expect((await storedSession(dropA.sessionId)).isActive).toBe(false);
    expect((await storedSession(dropB.sessionId)).isActive).toBe(false);
  });

  it("never touches another user's sessions", async () => {
    const mine = await account();
    const theirs = await account();
    await sessionService.createSession(mine, request(), { deviceId: deviceId() });
    const other = await sessionService.createSession(theirs, request(), { deviceId: deviceId() });

    await sessionService.deactivateAllUserSessions(mine);

    expect((await storedSession(other.sessionId)).isActive).toBe(true);
  });
});

describe('getUserActiveSessions', () => {
  it('returns only live sessions, most recently active first', async () => {
    const user = await account();
    const older = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const newer = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const dead = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await sessionService.deactivateSession(dead.sessionId);
    await getDb()
      .update(sessions)
      .set({ lastActiveAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.sessionId, older.sessionId));

    const live = await sessionService.getUserActiveSessions(user);

    expect(live.map((s) => s.sessionId)).toEqual([newer.sessionId, older.sessionId]);
  });
});

describe('refreshTokens', () => {
  it('rotates the pair, keeps the old refresh token for the grace window, and slides expiry', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const before = await storedSession(created.sessionId);

    const result = await sessionService.refreshTokens(created.refreshToken);

    expect(result).not.toBeNull();
    expect(result?.refreshToken).not.toBe(created.refreshToken);
    const after = await storedSession(created.sessionId);
    expect(after.refreshToken).toBe(result?.refreshToken);
    expect(after.previousRefreshToken).toBe(created.refreshToken);
    expect(after.tokenRotatedAt).toBeInstanceOf(Date);
    // Sliding idle window — a rotation is a USE of the session.
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('honours the just-superseded token inside the grace window WITHOUT rotating again', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const rotated = await sessionService.refreshTokens(created.refreshToken);
    sessionCache.clear();

    // The multi-tab race: tab B still holds the pre-rotation token.
    const graced = await sessionService.refreshTokens(created.refreshToken);

    expect(graced?.refreshToken).toBe(rotated?.refreshToken);
    expect(graced?.accessToken).toBe(rotated?.accessToken);
  });

  it('rejects the superseded token once the grace window has passed', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await sessionService.refreshTokens(created.refreshToken);
    await getDb()
      .update(sessions)
      .set({ tokenRotatedAt: new Date(Date.now() - 120_000) })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    expect(await sessionService.refreshTokens(created.refreshToken)).toBeNull();
  });

  it('rejects a refresh token for a deactivated or expired session', async () => {
    const user = await account();
    const dead = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await sessionService.deactivateSession(dead.sessionId);
    sessionCache.clear();
    expect(await sessionService.refreshTokens(dead.refreshToken)).toBeNull();

    const expired = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.sessionId, expired.sessionId));
    sessionCache.clear();
    expect(await sessionService.refreshTokens(expired.refreshToken)).toBeNull();
  });

  it('rejects a garbage refresh token', async () => {
    expect(await sessionService.refreshTokens('not-a-jwt')).toBeNull();
  });
});

describe('getAccessToken — the mint chokepoint', () => {
  it('slides expiresAt forward when a still-valid session mints without rotating', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    const token = await sessionService.getAccessToken(created.sessionId);

    expect(token?.accessToken).toBe(created.accessToken);
    const after = await storedSession(created.sessionId);
    // Renewed to a full window from now, so an actively-used session never dies.
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_EXPIRES_IN - 60_000);
  });

  it('mints nothing for an idle-expired or absent session', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    expect(await sessionService.getAccessToken(created.sessionId)).toBeNull();
    expect(await sessionService.getAccessToken(randomUUID())).toBeNull();
  });

  it('never asks the membership oracle for an ordinary session', async () => {
    // The performance half of the mint-path re-check, pinned rather than left
    // to the comment on it. `ensureManagedSessionAuthorized` returns before any
    // lookup when `operated_by_user_id` is NULL, so the overwhelmingly common
    // session pays nothing for a guarantee only delegated sessions need.
    //
    // Not a vacuous assertion: 'mints NO token for a preserved operator who
    // has lost act_as' proves this same mock IS reached, with these same
    // arguments, when the session carries an operator.
    const user = await account();
    const session = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    expect((await storedSession(session.sessionId)).operatedByUserId).toBeNull();

    mockVerifyActingAs.mockClear();
    expect(await sessionService.getAccessToken(session.sessionId)).not.toBeNull();
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
  });

  it('mints from the ROW, never from a stale cached copy', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    const beforeRotation = await storedSession(created.sessionId);

    // Another process rotates this session. Its `sessionCache.invalidate` reaches
    // only its OWN local tier, so this one keeps the superseded pair...
    expect(await sessionService.refreshTokens(created.refreshToken)).not.toBeNull();
    // ...and once the rotation grace has passed, the superseded refresh token
    // resolves to nothing at all.
    await getDb()
      .update(sessions)
      .set({ tokenRotatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(sessions.sessionId, created.sessionId));

    // The cached copy as it looks 15 minutes on: the row it describes is gone
    // and its access token has expired, which is what sends `getAccessToken`
    // down the rotate path.
    const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
    const claims = jwt.decode(beforeRotation.accessToken) as Record<string, unknown>;
    delete claims.iat;
    delete claims.exp;
    sessionCache.set(created.sessionId, {
      ...beforeRotation,
      accessToken: jwt.sign(claims, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '-1s' }),
    });

    const minted = await sessionService.getAccessToken(created.sessionId);
    expect(minted).not.toBeNull();
    expect(await sessionService.validateSession(minted?.accessToken ?? '')).not.toBeNull();
  });
});

describe("managed-account sessions stay bound to the operator's act_as", () => {
  it('validates while the operator still holds act_as', async () => {
    const operator = await account();
    const managed = await account();
    const created = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });
    mockVerifyActingAs.mockResolvedValue('admin');

    const result = await sessionService.validateSessionById(created.sessionId, false);

    expect(result?.session.sessionId).toBe(created.sessionId);
    expect(mockVerifyActingAs).toHaveBeenCalledWith(operator, managed);
  });

  it('DEACTIVATES and rejects once the operator lost act_as', async () => {
    const operator = await account();
    const managed = await account();
    const created = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });
    mockVerifyActingAs.mockResolvedValue(null); // membership revoked

    expect(await sessionService.validateSessionById(created.sessionId, false)).toBeNull();
    // Revocation is durable, not just a rejected read.
    expect((await storedSession(created.sessionId)).isActive).toBe(false);
  });

  it('NEVER re-checks an ordinary (non-delegated) session', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });

    await sessionService.validateSessionById(created.sessionId, false);

    // operated_by_user_id IS NULL means "not a delegated session".
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
  });

  it('refuses to REFRESH and deactivates when the operator lost act_as', async () => {
    const operator = await account();
    const managed = await account();
    const created = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });
    sessionCache.clear();
    mockVerifyActingAs.mockResolvedValue(null);

    expect(await sessionService.refreshTokens(created.refreshToken)).toBeNull();
    expect((await storedSession(created.sessionId)).isActive).toBe(false);
  });

  it('rotates tokens when the operator still holds act_as', async () => {
    const operator = await account();
    const managed = await account();
    const created = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });
    sessionCache.clear();
    mockVerifyActingAs.mockResolvedValue('admin');

    const result = await sessionService.refreshTokens(created.refreshToken);

    expect(result?.refreshToken).not.toBe(created.refreshToken);
  });
});

describe('validateSession / getSessionWithUser', () => {
  it('resolves the session and its user from a live access token', async () => {
    const user = await account({ username: `nate-${randomUUID().slice(0, 8)}` });
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    sessionCache.clear();
    userCache.clear();

    const result = await sessionService.validateSession(created.accessToken);

    expect(result?.session.sessionId).toBe(created.sessionId);
    // `session.userId` stays the id it is declared to be — Mongo replaced it
    // with the populated user document here; that swap does not travel.
    expect(result?.session.userId).toBe(user);
    // The user half is the REAL account document, hydrated through
    // `userService.readAccountDocument` — the same serializer
    // `GET /users/me/data` returns. `_id` is the account id, which is the field
    // `middleware/auth.ts` puts on `req.user`.
    expect(result?.user._id).toBe(user);
    expect(result?.user.privacySettings).toEqual(expect.objectContaining({
      isPrivateAccount: expect.any(Boolean),
    }));
  });

  it('withholds every protected column from the user it hands the request path', async () => {
    const user = await account({ phone: '+15551234567' });
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    sessionCache.clear();
    userCache.clear();

    const result = await sessionService.validateSession(created.accessToken);

    // `readAccountDocument` reads through `publicColumns(users)`, which is
    // strictly narrower than the `.select('-password')` this replaced: the raw
    // phone number and both contact-discovery hashes used to ride on
    // `req.user` and no longer do.
    expect(result?.user).not.toHaveProperty('phone');
    expect(result?.user).not.toHaveProperty('hashedEmail');
    expect(result?.user).not.toHaveProperty('hashedPhone');
    expect(result?.user).not.toHaveProperty('refreshToken');
    expect(result?.user).not.toHaveProperty('password');
  });

  it('returns null when the token is not a session token', async () => {
    expect(await sessionService.validateSession('garbage')).toBeNull();
  });

  it("returns null when the session's user no longer exists", async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });
    sessionCache.clear();
    userCache.clear();

    // Deleting the account cascades the session row away too; the token is
    // still syntactically valid, which is exactly the case this guards.
    await getDb().delete(users).where(eq(users.id, user));

    expect(await sessionService.validateSession(created.accessToken)).toBeNull();
  });
});

/**
 * Issue #937, Phase 6 — the access-token v2 binding, at the seam where it is
 * written and re-read rather than in the pure claim-set unit
 * (`utils/__tests__/accessTokenV2.test.ts`).
 */
describe('access token v2 binding', () => {
  it('mints a v2 token whose subject and actor come from the ROW', async () => {
    const operator = await account();
    const managed = await account({ kind: 'organization' });
    mockVerifyActingAs.mockResolvedValue('admin');

    const created = await sessionService.createSession(managed, request(), {
      deviceId: deviceId(),
      operatedByUserId: operator,
    });

    const claims = validateAccessToken(created.accessToken).payload;
    expect(claims?.ver).toBe(2);
    expect(claims?.sub).toBe(managed);
    expect(claims?.act?.sub).toBe(operator);
    expect(claims?.sid).toBe(created.sessionId);
  });

  it('records the application binding on the row and mints azp/scope from it', async () => {
    const user = await account();
    const app = await applicationRow();

    const created = await sessionService.createSession(user, request(), {
      deviceId: deviceId(),
      application: { applicationId: app.id, clientId: app.clientId, scopes: ['profile:read'] },
    });

    const stored = await storedSession(created.sessionId);
    expect(stored.applicationId).toBe(app.id);
    expect(stored.clientId).toBe(app.clientId);
    expect(stored.scopes).toEqual(['profile:read']);

    const claims = validateAccessToken(created.accessToken).payload;
    expect(claims?.azp).toBe(app.clientId);
    expect(claims?.scope).toBe('profile:read');
  });

  it('never hands an application-bound mint somebody else’s session on the same device', async () => {
    // The capture case. Before the reuse guard, an OAuth exchange landing on
    // the user's central device found the device's own first-party session and
    // took it over — the client received a token for the shared session and the
    // only trace was the row being renamed.
    const user = await account();
    const device = deviceId();
    const app = await applicationRow();
    const shared = await sessionService.createSession(user, request(), { deviceId: device });

    const bound = await sessionService.createSession(user, request(), {
      deviceId: device,
      application: { applicationId: app.id, clientId: app.clientId, scopes: [] },
    });

    expect(bound.sessionId).not.toBe(shared.sessionId);
    // ...and the shared session is untouched, still belonging to no application.
    const sharedAfter = await storedSession(shared.sessionId);
    expect(sharedAfter.applicationId).toBeNull();
  });

  it('reuses the SAME application’s session across exchanges', async () => {
    // The other half of the guard: isolation must not mean one row per
    // exchange.
    const user = await account();
    const device = deviceId();
    const app = await applicationRow();
    const options = {
      deviceId: device,
      application: { applicationId: app.id, clientId: app.clientId, scopes: [] },
    };

    const first = await sessionService.createSession(user, request(), options);
    const second = await sessionService.createSession(user, request(), options);

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('rejects a bearer once its session is bound to a DIFFERENT application', async () => {
    const user = await account();
    const app = await applicationRow();
    const created = await sessionService.createSession(user, request(), {
      deviceId: deviceId(),
      application: { applicationId: app.id, clientId: app.clientId, scopes: [] },
    });
    expect(await sessionService.validateSession(created.accessToken)).not.toBeNull();

    const other = await applicationRow();
    await getDb()
      .update(sessions)
      .set({ applicationId: other.id, clientId: other.clientId })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    // The token still verifies and its session is still live — the row moved
    // out from under it, and that alone is enough.
    expect(await sessionService.validateSession(created.accessToken)).toBeNull();
  });

  it('upgrades a v1 token to v2 on the next mint, without rotating a matching one', async () => {
    const user = await account();
    const created = await sessionService.createSession(user, request(), { deviceId: deviceId() });

    // Rewrite the stored token into the pre-Phase-6 shape, exactly as a session
    // that survived the deploy carries it.
    const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
    const legacy = jwt.sign(
      { userId: user, sessionId: created.sessionId, deviceId: created.deviceId, type: 'access' },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' }
    );
    await getDb()
      .update(sessions)
      .set({ accessToken: legacy })
      .where(eq(sessions.sessionId, created.sessionId));
    sessionCache.clear();

    const upgraded = await sessionService.getAccessToken(created.sessionId);
    expect(upgraded).not.toBeNull();
    expect(upgraded?.accessToken).not.toBe(legacy);
    expect(validateAccessToken(upgraded?.accessToken ?? '').payload?.ver).toBe(2);

    // A second mint of the now-matching token must NOT rotate again, or every
    // request would burn a refresh.
    sessionCache.clear();
    const again = await sessionService.getAccessToken(created.sessionId);
    expect(again?.accessToken).toBe(upgraded?.accessToken);
  });

  it('carries the device context onto the token once the login lane binds it', async () => {
    const user = await account();
    const device = deviceId();
    const created = await sessionService.createSession(user, request(), { deviceId: device });
    // The token at this point predates the context: `addAccount` has not run.
    expect(validateAccessToken(created.accessToken).payload?.device_context_id).toBeUndefined();

    await deviceSessionService.addAccount(device, {
      accountId: user,
      sessionId: created.sessionId,
    });
    await deviceSessionService.bindSessionToContext(device, created.sessionId);

    const minted = await sessionService.getAccessToken(created.sessionId);
    const claims = validateAccessToken(minted?.accessToken ?? '').payload;
    expect(typeof claims?.device_context_id).toBe('string');
    expect(typeof claims?.device_session_id).toBe('string');
  });
});

/**
 * Reuse must never NARROW the binding a session already carries.
 *
 * `createSession`'s reuse branch re-mints the token pair from the caller's
 * options while the row keeps everything the caller said nothing about. When
 * those two disagree the session is dead, not degraded: `checkAccessTokenBinding`
 * refuses the token against its own row on every later request, and each re-mint
 * reproduces the same disagreement, so nothing recovers it.
 *
 * The device-flow approve route is the caller that reaches this in production —
 * `POST /auth/session/authorize/:sessionToken` passes a deviceId and a label and
 * nothing else, onto the device whose own session the login lane bound to a
 * device context. Every case below asserts through `validateSession`, the real
 * consumer of the binding check, rather than re-deriving the row shape here.
 */
describe('createSession reuse preserves the binding the row already carries', () => {
  it('keeps the device context when the caller supplies none', async () => {
    const user = await account();
    const device = deviceId();
    const created = await sessionService.createSession(user, request(), { deviceId: device });
    // The login lane's ordering: the context row exists only after the session,
    // so the binding is written afterwards.
    await deviceSessionService.addAccount(device, { accountId: user, sessionId: created.sessionId });
    await deviceSessionService.bindSessionToContext(device, created.sessionId);
    const before = await storedSession(created.sessionId);
    expect(before.deviceSessionId).not.toBeNull();
    expect(before.deviceContextId).not.toBeNull();

    // The approve route's exact call.
    const reused = await sessionService.createSession(user, request(), {
      deviceId: device,
      deviceName: 'Acme App',
    });
    expect(reused.sessionId).toBe(created.sessionId);

    const claims = validateAccessToken(reused.accessToken).payload;
    expect(claims?.device_session_id).toBe(before.deviceSessionId);
    expect(claims?.device_context_id).toBe(before.deviceContextId);

    const after = await storedSession(created.sessionId);
    expect(after.deviceSessionId).toBe(before.deviceSessionId);
    expect(after.deviceContextId).toBe(before.deviceContextId);

    sessionCache.clear();
    expect(await sessionService.validateSession(reused.accessToken)).not.toBeNull();
  });

  it('keeps the application binding when the caller supplies none', async () => {
    const user = await account();
    const device = deviceId();
    const app = await applicationRow();
    const created = await sessionService.createSession(user, request(), {
      deviceId: device,
      application: { applicationId: app.id, clientId: app.clientId, scopes: ['profile:read'] },
    });

    const reused = await sessionService.createSession(user, request(), { deviceId: device });
    expect(reused.sessionId).toBe(created.sessionId);

    const claims = validateAccessToken(reused.accessToken).payload;
    expect(claims?.azp).toBe(app.clientId);
    expect(claims?.scope).toBe('profile:read');

    const after = await storedSession(created.sessionId);
    expect(after.applicationId).toBe(app.id);
    expect(after.clientId).toBe(app.clientId);
    expect(after.scopes).toEqual(['profile:read']);

    sessionCache.clear();
    expect(await sessionService.validateSession(reused.accessToken)).not.toBeNull();
  });

  it('keeps the operator when the caller supplies none', async () => {
    // The reuse lookup deliberately lets an operator-less mint reuse a
    // DELEGATED row, so the actor half of the binding takes the same route as
    // the other two. `operated_by_user_id` is a PRIVILEGE field rather than an
    // address, so this case is spelled out rather than lumped in with the
    // device and application halves.
    //
    // THE SHAPE BELOW IS REACHABLE, and it is worth stating how, because the
    // reuse lookup filters on `user_id` and a delegated row's `user_id` is the
    // MANAGED account — which reads as though an operator-less mint could never
    // find one. It can: the bearer of a managed session resolves `req.user._id`
    // to that same managed account (`validateSession` loads the user by
    // `session.userId`; `middleware/auth.ts` pins `req.user`), so while switched
    // into an organization the authenticated identity IS the organization.
    // `POST /accounts/:id/switch` then puts the delegated row on the OPERATOR's
    // central deviceId, and `POST /auth/session/authorize/:sessionToken` mints
    // `createSession(<that organization>, { deviceId: <that same device> })`
    // with no operator at all.
    //
    // Preserving is what the design asks for, not merely what keeps the binding
    // consistent: writing NULL here would mint the operator-less organization
    // session that the `account:act_as` re-check exists to make impossible. The
    // sibling case below is what keeps that safe.
    const operator = await account();
    const managed = await account({ kind: 'organization' });
    const device = deviceId();
    const created = await sessionService.createSession(managed, request(), {
      deviceId: device,
      operatedByUserId: operator,
    });

    const reused = await sessionService.createSession(managed, request(), { deviceId: device });
    expect(reused.sessionId).toBe(created.sessionId);
    expect(validateAccessToken(reused.accessToken).payload?.act?.sub).toBe(operator);
    expect((await storedSession(created.sessionId)).operatedByUserId).toBe(operator);

    sessionCache.clear();
    expect(await sessionService.validateSession(reused.accessToken)).not.toBeNull();
  });

  it('mints NO token for a preserved operator who has lost act_as', async () => {
    // The other half of preserving a PRIVILEGE field: the preserved operator
    // must still have to prove the privilege. `createSession` itself never
    // re-checks `account:act_as`, so the seam that has to is the one handing
    // out the credential — `getAccessToken`, which `POST /auth/session/claim`
    // reaches with no auth middleware in front of it.
    //
    // Until the binding was fixed this passed BY ACCIDENT: the reuse mint left
    // the token disagreeing with its row, every claim fell into `refreshTokens`
    // to be re-minted, and the check lives there. Making the token agree
    // removed that accident, which is why the check is now stated at the mint.
    const operator = await account();
    const managed = await account({ kind: 'organization' });
    const device = deviceId();
    mockVerifyActingAs.mockResolvedValue('admin');
    const created = await sessionService.createSession(managed, request(), {
      deviceId: device,
      operatedByUserId: operator,
    });
    // The approve route's operator-less mint, which preserves the operator.
    const reused = await sessionService.createSession(managed, request(), { deviceId: device });
    expect(reused.sessionId).toBe(created.sessionId);
    expect((await storedSession(created.sessionId)).operatedByUserId).toBe(operator);

    // POSITIVE CONTROL, and the vacuity floor. The SAME call on the SAME
    // session, with the membership intact, mints — so "returns null" below is
    // an answer this lane computed and not a lane that never ran. And the
    // membership oracle is provably consulted with this operator and this
    // account, which is what makes the revocation below meaningful.
    mockVerifyActingAs.mockClear();
    expect(await sessionService.getAccessToken(created.sessionId)).not.toBeNull();
    expect(mockVerifyActingAs).toHaveBeenCalledWith(operator, managed);

    // The membership is withdrawn.
    mockVerifyActingAs.mockResolvedValue(null);

    // The claim lane mints nothing...
    expect(await sessionService.getAccessToken(created.sessionId)).toBeNull();
    // ...and the refusal is a REVOCATION, not a withholding: the session is
    // deactivated, so the token handed out before the withdrawal dies on its
    // next request rather than living out its 15 minutes.
    expect((await storedSession(created.sessionId)).isActive).toBe(false);
    sessionCache.clear();
    expect(await sessionService.validateSession(reused.accessToken)).toBeNull();
  });

  it('still lets the caller REPOINT a binding it does supply', async () => {
    // The other half: "absent means keep" must not become "supplied is
    // ignored". A later exchange can widen or narrow what the client was
    // granted, and the grant is the authority — so a supplied value replaces
    // the row's outright, it does not merge with it.
    const user = await account();
    const device = deviceId();
    const app = await applicationRow();
    const created = await sessionService.createSession(user, request(), {
      deviceId: device,
      application: { applicationId: app.id, clientId: app.clientId, scopes: ['profile:read', 'mail:read'] },
    });
    const regranted = await sessionService.createSession(user, request(), {
      deviceId: device,
      application: { applicationId: app.id, clientId: app.clientId, scopes: ['profile:read'] },
    });

    expect(regranted.sessionId).toBe(created.sessionId);
    expect(validateAccessToken(regranted.accessToken).payload?.scope).toBe('profile:read');
    expect((await storedSession(created.sessionId)).scopes).toEqual(['profile:read']);

    sessionCache.clear();
    expect(await sessionService.validateSession(regranted.accessToken)).not.toBeNull();
  });

  it('leaves the refresh token it replaces usable for the grace window', async () => {
    // A reuse re-mint is a rotation, so it owes the same grace record: the
    // replaced token is held by whoever read this session before the re-mint,
    // including another process's cache, and no invalidation from here reaches
    // them.
    const user = await account();
    const device = deviceId();
    const first = await sessionService.createSession(user, request(), { deviceId: device });
    const second = await sessionService.createSession(user, request(), { deviceId: device });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const stored = await storedSession(first.sessionId);
    expect(stored.previousRefreshToken).toBe(first.refreshToken);
    expect(stored.tokenRotatedAt).not.toBeNull();

    const graced = await sessionService.refreshTokens(first.refreshToken);
    expect(graced).not.toBeNull();
    expect(graced?.accessToken).toBe(second.accessToken);
  });
});
