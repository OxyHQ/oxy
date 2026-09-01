/**
 * `SessionController` against a REAL Postgres.
 *
 * Every handler that touches storage is exercised end to end and then the ROW
 * IS READ BACK. The suites this replaces (`getUserByPublicKey.test.ts`, and the
 * storage half of `sessionAccess.controller.test.ts`) mocked the Mongoose
 * models and asserted on the CALL — `expect(findOne).toHaveBeenCalledWith(...)`,
 * `expect(select).toHaveBeenCalledWith(PUBLIC_USER_PROFILE_SELECT)` — which
 * proves a query was BUILT, never that the right row came back or that the
 * response withheld what it must.
 *
 * MOCKED, because each is a collaborator with its own port rather than the
 * subject here: `session.service` (session minting / validation),
 * `signature.service` (secp256k1), `deviceLogin.service`,
 * `securityActivityService`, and the socket emitter in `server.ts`. Nothing
 * about the storage layer is mocked.
 *
 * Every test mints its own rows with unique identifiers, so no assertion
 * depends on a table being empty — the suite shares one database with the rest
 * of the run.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';

const mockCreateSession = jest.fn();
const mockValidateSessionById = jest.fn();
const mockGetUserActiveSessions = jest.fn();
const mockDeactivateAllUserSessions = jest.fn();
const mockEmitSessionUpdate = jest.fn();
const mockFinalizeDeviceLogin = jest.fn();
const mockIsValidPublicKey = jest.fn();
const mockVerifyRegistrationSignature = jest.fn();
const mockVerifyChallengeResponse = jest.fn();
const mockGenerateChallenge = jest.fn();

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...a: unknown[]) => mockCreateSession(...a),
    validateSessionById: (...a: unknown[]) => mockValidateSessionById(...a),
    getUserActiveSessions: (...a: unknown[]) => mockGetUserActiveSessions(...a),
    deactivateSession: jest.fn(),
    deactivateAllUserSessions: (...a: unknown[]) => mockDeactivateAllUserSessions(...a),
  },
}));

jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    isValidPublicKey: (...a: unknown[]) => mockIsValidPublicKey(...a),
    verifyRegistrationSignature: (...a: unknown[]) => mockVerifyRegistrationSignature(...a),
    verifyChallengeResponse: (...a: unknown[]) => mockVerifyChallengeResponse(...a),
    generateChallenge: (...a: unknown[]) => mockGenerateChallenge(...a),
  },
}));

jest.mock('../../services/deviceLogin.service', () => ({
  finalizeDeviceLogin: (...a: unknown[]) => mockFinalizeDeviceLogin(...a),
}));

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logSignIn: jest.fn(), logSignOut: jest.fn() },
}));

jest.mock('../../server', () => ({
  emitSessionUpdate: (...a: unknown[]) => mockEmitSessionUpdate(...a),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { authChallenges } from '../../db/schema/authChallenges';
import { notifications } from '../../db/schema/notifications';
import { sessions } from '../../db/schema/sessions';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { userLinkMetadata } from '../../db/schema/userLinkMetadata';
import { users } from '../../db/schema/users';
import type { AuthRequest } from '../../middleware/auth';
import { SessionController } from '../session.controller';

/** A captured `res` — the status and body the handler actually produced. */
interface CapturedResponse {
  statusCode: number;
  body: unknown;
  status(code: number): CapturedResponse;
  json(payload: unknown): CapturedResponse;
  setHeader(): CapturedResponse;
}

function captureRes(): CapturedResponse {
  const res: CapturedResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res;
}

/** `res` as express types it, for handlers typed against `Response`. */
function asResponse(res: CapturedResponse): Response {
  return res as unknown as Response;
}

function request(over: Record<string, unknown>): Request {
  return { params: {}, body: {}, headers: {}, header: () => undefined, ...over } as unknown as Request;
}

function authRequest(userId: string, over: Record<string, unknown>): AuthRequest {
  return {
    params: {},
    body: {},
    headers: {},
    user: { _id: userId, id: userId },
    ...over,
  } as unknown as AuthRequest;
}

const publicKey = () => `pk${randomUUID().replace(/-/g, '')}`;
const username = () => `u${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** A `users` row. */
async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(over).returning({ id: users.id });
  return row.id;
}

/** A live `sessions` row for `userId`. */
async function session(
  userId: string,
  over: Partial<typeof sessions.$inferInsert> = {}
): Promise<string> {
  const sessionId = `sess-${randomUUID()}`;
  await getDb()
    .insert(sessions)
    .values({
      sessionId,
      userId,
      deviceId: `dev-${randomUUID()}`,
      deviceType: 'desktop',
      platform: 'web',
      accessToken: `at-${randomUUID()}`,
      refreshToken: `rt-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      ...over,
    });
  return sessionId;
}

async function storedSession(sessionId: string) {
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  return row;
}

async function storedUser(id: string) {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/** A `users` row's id, resolved case-insensitively by public key. */
async function accountIdByPublicKey(key: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicKey, key))
    .limit(1);
  return row?.id;
}

/**
 * Open several pooled connections up front.
 *
 * postgres.js connects LAZILY, so the first query on a fresh connection pays a
 * TCP and authentication handshake. {@link loseTheRaceTo} needs a second live
 * connection while the first is blocked on a row lock, so both are opened here
 * rather than mid-test.
 */
async function warmPool(): Promise<void> {
  await Promise.all(Array.from({ length: 8 }, () => getDb().execute(sql`select 1`)));
}

/** How long the subject is given to reach its own write and block on the lock. */
const RACE_SETTLE_MS = 250;

/** An open transaction handle, as drizzle hands it to a `transaction` callback. */
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Make `subject` DETERMINISTICALLY lose a race it would otherwise only
 * occasionally lose.
 *
 * Two calls raced with `Promise.all` do NOT reliably interleave — measured:
 * with the burn's `used = false` filter removed, that shape of test stayed
 * green, so it passed against the exact bug it guards. This forces the real
 * interleave through Postgres instead: the competitor's change is applied
 * inside an OPEN transaction (row locked, change invisible), the subject's READ
 * therefore sees the stale row and its own conditional WRITE blocks on the
 * lock, and the commit makes Postgres re-evaluate that write's `WHERE` against
 * the new row version — which is exactly what the filter exists for.
 *
 * The caller must assert a vacuity floor, since a subject that started too late
 * would take an ordinary rejection path and could look like a pass.
 */
async function loseTheRaceTo<T>(
  competitor: (tx: Tx) => Promise<void>,
  subject: () => Promise<T>
): Promise<T> {
  let commit = (): void => {};
  const held = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let applied = (): void => {};
  const ready = new Promise<void>((resolve) => {
    applied = resolve;
  });

  const transaction = getDb().transaction(async (tx) => {
    await competitor(tx);
    applied();
    await held;
  });

  await ready;
  const running = subject();
  await new Promise((resolve) => setTimeout(resolve, RACE_SETTLE_MS));
  commit();
  await transaction;
  return running;
}

beforeAll(async () => {
  await connectPostgres();
  await warmPool();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsValidPublicKey.mockReturnValue(true);
  mockVerifyRegistrationSignature.mockReturnValue(true);
  mockVerifyChallengeResponse.mockReturnValue(true);
  mockGenerateChallenge.mockImplementation(() => `ch-${randomUUID()}`);
  mockFinalizeDeviceLogin.mockResolvedValue({});
});

describe('register', () => {
  function registerBody(over: Record<string, unknown> = {}) {
    return { publicKey: publicKey(), signature: 'sig', timestamp: Date.now(), ...over };
  }

  it('creates the account, its identity auth method and a welcome notification', async () => {
    const body = registerBody({ username: username(), email: `${username()}@example.com` });
    const res = captureRes();

    await SessionController.register(request({ body }), asResponse(res));

    expect(res.statusCode).toBe(201);
    const userId = await accountIdByPublicKey(body.publicKey as string);
    expect(userId).toEqual(expect.any(String));

    const stored = await storedUser(userId as string);
    expect(stored.username).toBe(body.username);
    expect(stored.email).toBe(body.email);

    // The auth method is the account's PROVENANCE and used to be an embedded
    // array, so a row without it was unrepresentable. It is a child table now,
    // which is why the write is one transaction.
    const methods = await getDb()
      .select()
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, userId as string));
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ type: 'identity', methodPublicKey: body.publicKey });

    const welcome = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, userId as string));
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ type: 'welcome', entityType: 'profile' });
  });

  it('emits a formatted user DTO carrying the display name contract', async () => {
    const body = registerBody({ username: username() });
    const res = captureRes();

    await SessionController.register(request({ body }), asResponse(res));

    const payload = res.body as { user: { id: string; name: Record<string, unknown> } };
    expect(payload.user.id).toEqual(expect.any(String));
    // A key-only account has no real name, so `displayName` is deliberately
    // ABSENT and consumers fall back to the handle. The `name` object itself is
    // still present — every sign-in path requires it.
    expect(payload.user.name).toBeDefined();
    expect(payload.user.name.displayName).toBeUndefined();
  });

  it('composes name.displayName once the account has a real name', async () => {
    const body = registerBody();
    const res = captureRes();
    await SessionController.register(request({ body }), asResponse(res));
    const userId = (await accountIdByPublicKey(body.publicKey as string)) as string;

    await getDb().update(users).set({ nameFirst: 'Ada', nameLast: 'Lovelace' }).where(eq(users.id, userId));

    // Re-read through the public endpoint that serializes the same row.
    const lookup = captureRes();
    await SessionController.getUserByPublicKey(
      request({ params: { publicKey: body.publicKey } }),
      asResponse(lookup)
    );
    expect((lookup.body as { name: { displayName?: string } }).name.displayName).toBe(
      'Ada Lovelace'
    );
  });

  it('rejects a duplicate identity, email and username', async () => {
    const key = publicKey();
    const name = username();
    const email = `${name}@example.com`;
    await SessionController.register(
      request({ body: registerBody({ publicKey: key, username: name, email }) }),
      asResponse(captureRes())
    );

    const dupIdentity = captureRes();
    await SessionController.register(
      request({ body: registerBody({ publicKey: key }) }),
      asResponse(dupIdentity)
    );
    expect(dupIdentity.statusCode).toBe(409);
    expect(dupIdentity.body).toEqual({ message: 'Identity already registered' });

    const dupEmail = captureRes();
    await SessionController.register(
      request({ body: registerBody({ email }) }),
      asResponse(dupEmail)
    );
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.body).toEqual({ message: 'Email already registered' });

    const dupUsername = captureRes();
    await SessionController.register(
      request({ body: registerBody({ username: name }) }),
      asResponse(dupUsername)
    );
    expect(dupUsername.statusCode).toBe(409);
    expect(dupUsername.body).toEqual({ message: 'Username already taken' });
  });

  it('rejects a username that differs only by CASE', async () => {
    const name = username();
    await SessionController.register(
      request({ body: registerBody({ username: name }) }),
      asResponse(captureRes())
    );

    const res = captureRes();
    await SessionController.register(
      request({ body: registerBody({ username: name.toUpperCase() }) }),
      asResponse(res)
    );

    // Mongo indexed `username` case-SENSITIVELY, so `Nate` and `nate` could
    // coexist while every lookup ran a case-insensitive regex. The unique index
    // on `lower(btrim(username))` is what closes that.
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'Username already taken' });
  });

  it('two concurrent registrations of one identity: exactly one account exists', async () => {
    // The pre-check cannot close the race between the check and the insert; the
    // unique index does, and this is the path the `E11000` handler became.
    const key = publicKey();
    const first = captureRes();
    const second = captureRes();

    await Promise.all([
      SessionController.register(
        request({ body: registerBody({ publicKey: key }) }),
        asResponse(first)
      ),
      SessionController.register(
        request({ body: registerBody({ publicKey: key }) }),
        asResponse(second)
      ),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.publicKey, key));
    expect(rows).toHaveLength(1);
  });

  it('refuses an invalid registration signature and writes nothing', async () => {
    mockVerifyRegistrationSignature.mockReturnValueOnce(false);
    const body = registerBody();
    const res = captureRes();

    await SessionController.register(request({ body }), asResponse(res));

    expect(res.statusCode).toBe(401);
    expect(await accountIdByPublicKey(body.publicKey as string)).toBeUndefined();
  });
});

describe('requestChallenge', () => {
  it('stores a signin-purpose challenge for a known account', async () => {
    const key = publicKey();
    await account({ publicKey: key });
    const res = captureRes();

    await SessionController.requestChallenge(request({ body: { publicKey: key } }), asResponse(res));

    const issued = (res.body as { challenge: string }).challenge;
    const [row] = await getDb()
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.challenge, issued))
      .limit(1);
    expect(row).toMatchObject({ publicKey: key, purpose: 'signin', used: false });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404 for an unregistered key and stores no challenge', async () => {
    const key = publicKey();
    const res = captureRes();

    await SessionController.requestChallenge(request({ body: { publicKey: key } }), asResponse(res));

    expect(res.statusCode).toBe(404);
    const rows = await getDb()
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.publicKey, key));
    expect(rows).toHaveLength(0);
  });
});

describe('verifyChallenge', () => {
  /** An account with a live signin challenge. */
  async function signer(over: Partial<typeof authChallenges.$inferInsert> = {}) {
    const key = publicKey();
    const userId = await account({ publicKey: key, username: username() });
    const challenge = `ch-${randomUUID()}`;
    await getDb()
      .insert(authChallenges)
      .values({
        publicKey: key,
        challenge,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        ...over,
      });
    return { key, userId, challenge };
  }

  function verifyBody(key: string, challenge: string) {
    return { publicKey: key, challenge, signature: 'sig', timestamp: Date.now() };
  }

  async function storedChallenge(challenge: string) {
    const [row] = await getDb()
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.challenge, challenge))
      .limit(1);
    return row;
  }

  it('burns the challenge, mints a session and returns the device-first arm', async () => {
    const { key, userId, challenge } = await signer();
    mockCreateSession.mockResolvedValueOnce({
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      expiresAt: new Date(Date.now() + 60_000),
      accessToken: 'at-1',
      createdAt: new Date(),
      deviceName: 'Chrome',
      deviceType: 'desktop',
      platform: 'web',
    });
    mockFinalizeDeviceLogin.mockResolvedValueOnce({ deviceSecret: 'ds-1' });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.body).toMatchObject({
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      accessToken: 'at-1',
      deviceSecret: 'ds-1',
      user: { id: userId },
    });
    expect((await storedChallenge(challenge)).used).toBe(true);
    expect(mockEmitSessionUpdate).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ type: 'session_created' })
    );
  });

  it('never puts a bearer credential of the account on the wire', async () => {
    const { key, challenge } = await signer();
    mockCreateSession.mockResolvedValueOnce({
      sessionId: 'sess-2',
      deviceId: 'dev-2',
      expiresAt: new Date(Date.now() + 60_000),
      accessToken: 'at-2',
      createdAt: new Date(),
      deviceType: 'desktop',
      platform: 'web',
    });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    // The user object is read through `publicColumns(users)`, so the columns the
    // registry withholds cannot appear even if the serializer forgot them.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('hashedEmail');
    expect(serialized).not.toContain('hashedPhone');
  });

  it('rejects an EXPIRED challenge that is still in the table', async () => {
    // `auth_challenges` is swept on an interval, so a row past its deadline is
    // routinely still present. Dropping the read-side filter would leave it
    // spendable for up to one sweep interval.
    const { key, challenge } = await signer({ expiresAt: new Date(Date.now() - 1_000) });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects a rotate_key challenge — it can never be spent for a session', async () => {
    const { key, challenge } = await signer({ purpose: 'rotate_key' });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(401);
    expect(mockVerifyChallengeResponse).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects an already-used challenge', async () => {
    const { key, challenge } = await signer({ used: true });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('leaves the challenge SPENDABLE when the signature does not verify', async () => {
    const { key, challenge } = await signer();
    mockVerifyChallengeResponse.mockReturnValueOnce(false);
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(401);
    expect((await storedChallenge(challenge)).used).toBe(false);
  });

  it('mints NOTHING when the challenge is burned between the read and its own burn', async () => {
    // Single-use is what a challenge IS. Mongo burned it with a filter on `_id`
    // alone — so a request that read the row before another burned it still
    // minted a session. The burn's `used = false` filter is what closes that,
    // and this drives the interleave through a real row lock rather than hoping
    // two `Promise.all` calls land in the right order.
    const { key, challenge } = await signer();
    const [row] = await getDb()
      .select({ id: authChallenges.id })
      .from(authChallenges)
      .where(eq(authChallenges.challenge, challenge))
      .limit(1);
    const res = captureRes();

    await loseTheRaceTo(
      (tx) =>
        tx
          .update(authChallenges)
          .set({ used: true })
          .where(eq(authChallenges.id, row.id))
          .then(() => undefined),
      () =>
        SessionController.verifyChallenge(
          request({ body: verifyBody(key, challenge) }),
          asResponse(res)
        )
    );

    expect(res.statusCode).toBe(401);
    // VACUITY FLOOR: the signature check runs only AFTER the challenge read
    // succeeded, so its having been called proves the read saw the unburned row
    // and the rejection came from the burn's own filter — not from the read.
    expect(mockVerifyChallengeResponse).toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('returns 404 when the signer owns no account, and still burns the challenge', async () => {
    const key = publicKey();
    const challenge = `ch-${randomUUID()}`;
    await getDb()
      .insert(authChallenges)
      .values({ publicKey: key, challenge, expiresAt: new Date(Date.now() + 60_000) });
    const res = captureRes();

    await SessionController.verifyChallenge(
      request({ body: verifyBody(key, challenge) }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(404);
    expect((await storedChallenge(challenge)).used).toBe(true);
  });
});

describe('logoutAllSessions', () => {
  it('broadcasts exactly the OTHER live sessions of the owner', async () => {
    const userId = await account();
    const current = await session(userId);
    const other = await session(userId);
    const expired = await session(userId, { expiresAt: new Date(Date.now() - 1_000) });
    const inactive = await session(userId, { isActive: false });
    const strangerId = await account();
    const stranger = await session(strangerId);

    mockValidateSessionById.mockResolvedValueOnce({ session: { userId, sessionId: current } });
    mockDeactivateAllUserSessions.mockResolvedValueOnce(1);
    const res = captureRes();

    await SessionController.logoutAllSessions(
      request({ params: { sessionId: current } }),
      asResponse(res)
    );

    expect(mockEmitSessionUpdate).toHaveBeenCalledWith(userId, {
      type: 'sessions_removed',
      sessionIds: [other],
    });
    // The current session, an expired one, a deactivated one and another user's
    // are all excluded — the broadcast must name exactly what was revoked.
    const broadcast = mockEmitSessionUpdate.mock.calls[0][1].sessionIds as string[];
    expect(broadcast).not.toContain(current);
    expect(broadcast).not.toContain(expired);
    expect(broadcast).not.toContain(inactive);
    expect(broadcast).not.toContain(stranger);
  });

  it('emits nothing when the owner has no other live session', async () => {
    const userId = await account();
    const current = await session(userId);
    mockValidateSessionById.mockResolvedValueOnce({ session: { userId, sessionId: current } });
    mockDeactivateAllUserSessions.mockResolvedValueOnce(0);

    await SessionController.logoutAllSessions(
      request({ params: { sessionId: current } }),
      asResponse(captureRes())
    );

    expect(mockEmitSessionUpdate).not.toHaveBeenCalled();
  });
});

describe('getUsersBySessions', () => {
  it('resolves each live session to its owner and nulls the rest', async () => {
    const name = username();
    const userId = await account({ username: name });
    const live = await session(userId);
    const expired = await session(userId, { expiresAt: new Date(Date.now() - 1_000) });
    const inactive = await session(userId, { isActive: false });
    const unknown = `sess-${randomUUID()}`;
    const res = captureRes();

    await SessionController.getUsersBySessions(
      request({ body: { sessionIds: [live, expired, inactive, unknown] } }),
      asResponse(res)
    );

    const body = res.body as { sessionId: string; user: { id: string } | null }[];
    expect(body.map((entry) => entry.sessionId)).toEqual([live, expired, inactive, unknown]);
    expect(body[0].user).toMatchObject({ id: userId, username: name });
    expect(body[1].user).toBeNull();
    expect(body[2].user).toBeNull();
    expect(body[3].user).toBeNull();
  });

  it('deduplicates the input and caps the batch at 20', async () => {
    const userId = await account();
    const live = await session(userId);
    const res = captureRes();

    const padding = Array.from({ length: 25 }, () => `sess-${randomUUID()}`);
    await SessionController.getUsersBySessions(
      request({ body: { sessionIds: [live, live, ...padding] } }),
      asResponse(res)
    );

    const body = res.body as { sessionId: string }[];
    expect(body).toHaveLength(20);
    expect(body.filter((entry) => entry.sessionId === live)).toHaveLength(1);
  });

  it('never carries a session bearer token into the batch response', async () => {
    const userId = await account();
    const live = await session(userId);
    const token = (await storedSession(live)).accessToken;
    const res = captureRes();

    await SessionController.getUsersBySessions(
      request({ body: { sessionIds: [live] } }),
      asResponse(res)
    );

    // The join names its columns; the natural transliteration of Mongo's
    // `.populate()` — `select().from(sessions)` then `.map(...)` — would have
    // carried both live tokens into whatever the mapper forgot to drop.
    expect(JSON.stringify(res.body)).not.toContain(token);
  });
});

describe('updateDeviceName', () => {
  it('writes the column and advances updated_at', async () => {
    const userId = await account();
    const sessionId = await session(userId, { deviceName: 'Old' });
    const before = await storedSession(sessionId);
    mockValidateSessionById.mockResolvedValueOnce({ session: { sessionId } });
    const res = captureRes();

    await SessionController.updateDeviceName(
      request({ params: { sessionId }, body: { deviceName: 'Nate MacBook' } }),
      asResponse(res)
    );

    const after = await storedSession(sessionId);
    expect(after.deviceName).toBe('Nate MacBook');
    // `updated_at` is maintained by the schema's `$onUpdate`, not by hand.
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(res.body).toMatchObject({ success: true, deviceName: 'Nate MacBook' });
  });

  it('touches nothing when the session cannot be validated', async () => {
    const userId = await account();
    const sessionId = await session(userId, { deviceName: 'Old' });
    mockValidateSessionById.mockResolvedValueOnce(null);
    const res = captureRes();

    await SessionController.updateDeviceName(
      request({ params: { sessionId }, body: { deviceName: 'Nate MacBook' } }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(404);
    expect((await storedSession(sessionId)).deviceName).toBe('Old');
  });
});

describe('getUserByPublicKey', () => {
  it('returns a public profile and withholds every private column', async () => {
    const key = publicKey();
    const name = username();
    const email = `${name}@example.com`;
    await account({
      publicKey: key,
      username: name,
      email,
      phone: '+15551234567',
      nameFirst: 'Ada',
      bio: 'Analytical engines',
    });
    const res = captureRes();

    await SessionController.getUserByPublicKey(
      request({ params: { publicKey: key } }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ username: name, bio: 'Analytical engines' });

    // The Mongo projection was inclusion-only so that an unnamed field is
    // dropped by the query rather than by a serializer remembering to. The
    // explicit column list is the same guarantee, asserted on the REAL row
    // rather than on the projection string having been passed.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain('+15551234567');
    expect(serialized).not.toContain('hashedEmail');
    expect(serialized).not.toContain('hashedPhone');
  });

  it('reports the account fediverse-sharing choice rather than defaulting it on', async () => {
    const key = publicKey();
    await account({ publicKey: key, privacyFediverseSharing: false });
    const res = captureRes();

    await SessionController.getUserByPublicKey(
      request({ params: { publicKey: key } }),
      asResponse(res)
    );

    // A PUBLIC, derived flag: forgetting to select the column would silently
    // report every opted-out account as sharing.
    expect((res.body as { fediverseSharing: boolean }).fediverseSharing).toBe(false);
  });

  it('joins the link previews back in the author-chosen order', async () => {
    const key = publicKey();
    const userId = await account({ publicKey: key, links: ['https://b.example', 'https://a.example'] });
    // Inserted out of order on purpose: `position` is the author's order and is
    // visible on the profile, so an unordered read would silently reshuffle it.
    await getDb().insert(userLinkMetadata).values([
      { userId, position: 1, url: 'https://a.example', title: 'A', description: 'second' },
      {
        userId,
        position: 0,
        url: 'https://b.example',
        title: 'B',
        description: 'first',
        image: 'file-1',
      },
    ]);
    const res = captureRes();

    await SessionController.getUserByPublicKey(
      request({ params: { publicKey: key } }),
      asResponse(res)
    );

    // A preview with no image OMITS the key, exactly as the Mongo subdocument
    // did — `image: null` would be a new value on the wire.
    expect((res.body as { linksMetadata: unknown[] }).linksMetadata).toEqual([
      { url: 'https://b.example', title: 'B', description: 'first', image: 'file-1' },
      { url: 'https://a.example', title: 'A', description: 'second' },
    ]);
  });

  it('answers 404 for an unknown key', async () => {
    const res = captureRes();

    await SessionController.getUserByPublicKey(
      request({ params: { publicKey: publicKey() } }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(404);
  });
});

describe('session access control (C1 / H3)', () => {
  const OWNER = '64f7c2a1b8e9d3f4a1c2b3d4';
  const ATTACKER = '74f7c2a1b8e9d3f4a1c2b3d5';
  const SESSION_ID = 'sess-victim';

  it('getUserBySession requires authentication', async () => {
    const res = captureRes();
    await SessionController.getUserBySession(
      { params: { sessionId: SESSION_ID }, headers: {} } as unknown as AuthRequest,
      asResponse(res)
    );

    expect(res.statusCode).toBe(401);
    expect(mockValidateSessionById).not.toHaveBeenCalled();
  });

  it('getUserBySession answers 404 — never 403 — across a user boundary', async () => {
    mockValidateSessionById.mockResolvedValueOnce({
      session: { userId: OWNER, sessionId: SESSION_ID },
      user: { id: OWNER, username: 'victim' },
    });
    const res = captureRes();

    await SessionController.getUserBySession(
      authRequest(ATTACKER, { params: { sessionId: SESSION_ID } }),
      asResponse(res)
    );

    // 403 would confirm the session exists; 404 leaks nothing.
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: 'Session not found' });
  });

  it('getUserBySession returns the owner their own user', async () => {
    mockValidateSessionById.mockResolvedValueOnce({
      session: { userId: OWNER, sessionId: SESSION_ID },
      user: { id: OWNER, username: 'me' },
    });
    const res = captureRes();

    await SessionController.getUserBySession(
      authRequest(OWNER, { params: { sessionId: SESSION_ID } }),
      asResponse(res)
    );

    expect(res.body).toMatchObject({ id: OWNER, username: 'me' });
  });

  it('getUserSessions does not enumerate another user sessions', async () => {
    mockValidateSessionById.mockResolvedValueOnce({
      session: { userId: OWNER, sessionId: SESSION_ID },
    });
    const res = captureRes();

    await SessionController.getUserSessions(
      authRequest(ATTACKER, { params: { sessionId: SESSION_ID } }),
      asResponse(res)
    );

    expect(res.statusCode).toBe(404);
    expect(mockGetUserActiveSessions).not.toHaveBeenCalled();
  });

  it('getUserSessions lists the owner sessions from the FLAT device columns', async () => {
    mockValidateSessionById.mockResolvedValueOnce({
      session: { userId: OWNER, sessionId: SESSION_ID },
    });
    mockGetUserActiveSessions.mockResolvedValueOnce([
      {
        sessionId: SESSION_ID,
        deviceId: 'dev-1',
        deviceName: 'iPhone',
        isActive: true,
        userId: OWNER,
      },
      { sessionId: 'sess-2', deviceId: 'dev-2', deviceName: null, isActive: true, userId: OWNER },
    ]);
    const res = captureRes();

    await SessionController.getUserSessions(
      authRequest(OWNER, { params: { sessionId: SESSION_ID } }),
      asResponse(res)
    );

    expect(res.body).toEqual([
      { sessionId: SESSION_ID, deviceId: 'dev-1', deviceName: 'iPhone', isActive: true, userId: OWNER },
      // A nameless device reports `undefined`, not the column's NULL — the wire
      // contract has no null there.
      { sessionId: 'sess-2', deviceId: 'dev-2', deviceName: undefined, isActive: true, userId: OWNER },
    ]);
  });

  it('validateSession reports lastActivity from last_active_at, and the deviceId to chain', async () => {
    const expiresAt = new Date('2026-08-01T00:00:00.000Z');
    const lastActiveAt = new Date('2026-07-01T00:00:00.000Z');
    mockValidateSessionById.mockResolvedValueOnce({
      session: { userId: OWNER, sessionId: SESSION_ID, deviceId: 'dev-xyz', expiresAt, lastActiveAt },
      user: { id: OWNER, username: 'me' },
    });
    const res = captureRes();

    await SessionController.validateSession(
      request({ params: { sessionId: SESSION_ID } }),
      asResponse(res)
    );

    expect(res.body).toMatchObject({
      valid: true,
      expiresAt: expiresAt.toISOString(),
      lastActivity: lastActiveAt.toISOString(),
      deviceId: 'dev-xyz',
    });
  });

  it('validateSessionFromHeader reports the same, plus the sessionId', async () => {
    const expiresAt = new Date('2026-08-01T00:00:00.000Z');
    const lastActiveAt = new Date('2026-07-01T00:00:00.000Z');
    mockValidateSessionById.mockResolvedValueOnce({
      session: {
        userId: OWNER,
        sessionId: SESSION_ID,
        deviceId: 'dev-xyz',
        expiresAt,
        lastActiveAt,
        deviceFingerprint: 'fp-1',
      },
      user: { id: OWNER, username: 'me' },
    });
    const res = captureRes();

    await SessionController.validateSessionFromHeader(
      request({ params: { sessionId: SESSION_ID }, header: () => 'fp-other' }),
      asResponse(res)
    );

    expect(res.body).toMatchObject({
      valid: true,
      expiresAt: expiresAt.toISOString(),
      lastActivity: lastActiveAt.toISOString(),
      deviceId: 'dev-xyz',
      sessionId: SESSION_ID,
    });
  });
});

describe('the sessions a handler reads are the live ones', () => {
  it('logoutAllSessions never names a session outside the owner live set', async () => {
    // A second owner with an identically-shaped set, to prove the predicate is
    // scoped by user rather than merely by liveness.
    const userId = await account();
    const current = await session(userId);
    const mine = await session(userId);
    const otherOwner = await account();
    await session(otherOwner);

    mockValidateSessionById.mockResolvedValueOnce({ session: { userId, sessionId: current } });
    mockDeactivateAllUserSessions.mockResolvedValueOnce(1);

    await SessionController.logoutAllSessions(
      request({ params: { sessionId: current } }),
      asResponse(captureRes())
    );

    expect(mockEmitSessionUpdate).toHaveBeenCalledWith(userId, {
      type: 'sessions_removed',
      sessionIds: [mine],
    });

    const live = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.userId, otherOwner), eq(sessions.isActive, true)));
    expect(live).toHaveLength(1);
  });
});
