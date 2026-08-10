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

/**
 * Wait until the wall-clock SECOND advances.
 *
 * ## This is a WORKAROUND for an open token-minter defect. Do not "fix" it here.
 *
 * `generateSessionTokens` (`utils/sessionUtils.ts`) signs a payload of
 * `{userId, sessionId, deviceId, type}` with NO nonce, and a JWT's `iat`/`exp`
 * have one-second resolution. So a rotation that completes inside the same
 * second re-mints a BYTE-IDENTICAL refresh token and leaves
 * `previous_refresh_token === refresh_token` — meaning **a rotation that fast
 * does not actually invalidate a stolen refresh token**.
 *
 * That is a defect in the MINTER, not in this port and not in this test: the
 * behaviour predates the Drizzle migration and is unchanged by it. It is
 * reported and escalated; the fix (a per-mint nonce / `jti`) changes the token
 * format, which is a wire-contract change and deliberately out of scope here.
 *
 * These sleeps exist ONLY so the rotation cases exercise a REAL rotation
 * instead of silently passing against the collision. If you are here because
 * they look slow or superfluous: the correct change is to give
 * `generateSessionTokens` a nonce and then DELETE this helper — not to relax
 * the assertions that depend on it.
 */
async function nextSecond(): Promise<void> {
  const start = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === start) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
    await nextSecond();

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
    await nextSecond();
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

describe('getAccessToken — the sliding mint chokepoint', () => {
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
    await nextSecond();

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
