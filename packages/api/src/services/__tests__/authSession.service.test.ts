/**
 * `authSession.service` against a REAL Postgres.
 *
 * This module decides who may claim a session, who may approve one, and how
 * many authorization codes a request can ever mint, so every assertion here
 * runs the real service against the throwaway database and then READS THE ROW
 * BACK. The suite it replaces mocked the Mongoose models and asserted on
 * `$set` / `findOneAndUpdate` payload SHAPES — that proved the call was built
 * as expected, never that the stored row ended up correct, and it could not
 * have caught a filter that matched the wrong row.
 *
 * It absorbs four earlier mock-based files, one describe block each, so no
 * concern is silently dropped: `sessionAuthorizeSigned.test.ts`,
 * `authorizeSessionWithBearer.test.ts`, `authSessionOAuthFinalize.test.ts` and
 * `authSessionPurposeScope.test.ts`.
 *
 * MOCKED, because each is a collaborator rather than the subject and owns its
 * own port: `session.service` (session minting), `signature.service` (secp256k1
 * verification), `account.service` (`account:act_as` membership) and
 * `oauthCode.service`'s `issueAuthCode`. Nothing about the storage layer is
 * mocked — every row this file asserts on is a real row.
 *
 * Every test mints its own users, application and tokens, so no assertion
 * depends on a table being empty: the suite shares one database with the rest
 * of the run and `auth_sessions` carries real foreign keys.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

const mockCreateSession = jest.fn();
const mockVerifyChallengeResponse = jest.fn();
const mockVerifyActingAs = jest.fn();
const mockIssueAuthCode = jest.fn();

jest.mock('../session.service', () => ({
  __esModule: true,
  default: { createSession: (...a: unknown[]) => mockCreateSession(...a) },
}));

jest.mock('../signature.service', () => ({
  __esModule: true,
  default: {
    verifyChallengeResponse: (...a: unknown[]) => mockVerifyChallengeResponse(...a),
  },
}));

jest.mock('../account.service', () => ({
  __esModule: true,
  accountService: { verifyActingAs: (...a: unknown[]) => mockVerifyActingAs(...a) },
}));

// Only the minting half is stubbed. `AUTH_CODE_TTL_MS` stays real so the
// `expiresIn` the route returns is the real contract value.
jest.mock('../oauthCode.service', () => ({
  __esModule: true,
  ...jest.requireActual('../oauthCode.service'),
  issueAuthCode: (...a: unknown[]) => mockIssueAuthCode(...a),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { authChallenges } from '../../db/schema/authChallenges';
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import {
  approvalMintsSession,
  authorizeSessionWithBearer,
  authorizeSessionWithSignedChallenge,
  claimAuthSession,
  finalizeOAuthAuthorization,
  resolveOAuthContext,
  verifyDelegatedSubject,
} from '../authSession.service';

const REDIRECT_URI = 'https://rp.example/callback';

/** A personal `users` row. */
async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(over).returning({ id: users.id });
  return row.id;
}

/** An organization account — one of the kinds that may be a delegated subject. */
async function organization(): Promise<string> {
  return account({ kind: 'organization' });
}

/** A registered application owned by `ownerId`. */
async function application(
  over: Partial<typeof applications.$inferInsert> = {}
): Promise<string> {
  const ownerAccountId = over.ownerAccountId ?? (await account());
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: 'Acme Widgets',
      ownerAccountId,
      redirectUris: [REDIRECT_URI],
      scopes: ['user:read', 'files:read'],
      ...over,
    })
    .returning({ id: applications.id });
  return row.id;
}

/** A pending `auth_sessions` row, plus the two credentials that address it. */
async function authSession(over: Partial<typeof authSessions.$inferInsert> = {}) {
  const sessionToken = `st-${randomUUID()}`;
  const authorizeCode = `ac-${randomUUID()}`;
  const applicationId = over.applicationId ?? (await application());
  const [row] = await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      applicationId,
      originVerified: true,
      boundOrigin: 'https://rp.example',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      ...over,
    })
    .returning({ id: authSessions.id });
  return { id: row.id, sessionToken, authorizeCode, applicationId };
}

/** The OAuth binding columns of a bound request, as an insert fragment. */
function oauthBinding(over: Partial<typeof authSessions.$inferInsert> = {}) {
  return {
    purpose: 'oauth_authorization' as const,
    oauthRedirectUri: REDIRECT_URI,
    oauthCodeChallenge: 'challenge-abc',
    oauthCodeChallengeMethod: 'S256' as const,
    oauthScopes: ['user:read'],
    ...over,
  };
}

/** An unused, unexpired signin challenge for `publicKey`. */
async function challenge(
  publicKey: string,
  over: Partial<typeof authChallenges.$inferInsert> = {}
): Promise<string> {
  const value = `ch-${randomUUID()}`;
  await getDb()
    .insert(authChallenges)
    .values({
      publicKey,
      challenge: value,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      ...over,
    });
  return value;
}

/** The stored row, read straight from Postgres rather than through the service. */
async function stored(id: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, id))
    .limit(1);
  return row;
}

/**
 * The constraint a rejected write violated, or null if it did not reject.
 *
 * Named rather than pattern-matched on the message: drizzle's wrapper reports
 * the failed SQL, and only the driver error underneath carries
 * `constraint_name` — so asserting on the message would pass for ANY failure of
 * that statement, including one from an unrelated typo in the fixture.
 */
async function violatedConstraint(write: Promise<unknown>): Promise<string | null> {
  try {
    await write;
    return null;
  } catch (error) {
    const candidates = [error, (error as { cause?: unknown }).cause];
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const name = (candidate as { constraint_name?: unknown }).constraint_name;
      if (typeof name === 'string') return name;
    }
    return null;
  }
}

async function storedChallenge(value: string) {
  const [row] = await getDb()
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.challenge, value))
    .limit(1);
  return row;
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
 * Two calls to `Promise.all` do NOT reliably interleave — measured: with every
 * atomic filter in this module removed, `Promise.all`-style concurrency tests
 * stayed green, so they passed against the exact bug they guard. This forces the
 * real interleave through Postgres instead of hoping for it:
 *
 *  1. `competitor` applies its change inside an OPEN transaction, so the row is
 *     LOCKED and the change is invisible to anyone else (READ COMMITTED).
 *  2. `subject` starts. Its READ still sees the pre-change row — exactly the
 *     stale peek a racing request gets — and its own conditional WRITE then
 *     blocks on the lock.
 *  3. The transaction commits. Postgres re-evaluates the blocked write's `WHERE`
 *     against the NEW row version, which is precisely what the atomic filters
 *     exist for: with them, nothing matches; without them, both writers win.
 *
 * The caller must assert a vacuity floor — some observable that could only have
 * happened if the subject's read really did precede the commit — because a
 * subject that started too late would take an ordinary rejection path and could
 * look like a pass.
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
  mockVerifyChallengeResponse.mockReturnValue(true);
  mockCreateSession.mockResolvedValue({ sessionId: `sess-${randomUUID()}` });
  mockIssueAuthCode.mockResolvedValue({ code: 'raw-code', expiresAt: new Date() });
});

describe('resolveOAuthContext', () => {
  it('reads the binding off the flat columns of a bound request', async () => {
    const subject = await organization();
    const { id } = await authSession(oauthBinding({ oauthSubjectAccountId: subject }));

    expect(resolveOAuthContext(await stored(id))).toEqual({
      redirectUri: REDIRECT_URI,
      codeChallenge: 'challenge-abc',
      codeChallengeMethod: 'S256',
      scopes: ['user:read'],
      subjectAccountId: subject,
    });
  });

  it('returns null for a device sign-in request', async () => {
    const { id } = await authSession();
    expect(resolveOAuthContext(await stored(id))).toBeNull();
  });

  it('reports a bound request with NO delegated subject as subjectAccountId null', async () => {
    const { id } = await authSession(oauthBinding());
    expect(resolveOAuthContext(await stored(id))?.subjectAccountId).toBeNull();
  });

  it('the database refuses a HALF-bound request outright', async () => {
    // The all-or-nothing CHECK is what makes the null-guards in
    // `resolveOAuthContext` a type-level narrowing rather than the only
    // defence: a row this function would have to reject cannot be written.
    expect(
      await violatedConstraint(
        authSession({ purpose: 'oauth_authorization', oauthRedirectUri: REDIRECT_URI })
      )
    ).toBe('auth_sessions_oauth_binding_check');
  });

  it('the database refuses an OAuth binding on a device sign-in request', async () => {
    expect(
      await violatedConstraint(authSession(oauthBinding({ purpose: 'device_sign_in' })))
    ).toBe('auth_sessions_oauth_purpose_check');
  });
});

describe('approvalMintsSession', () => {
  it('is true for a device sign-in and false for an OAuth authorization', () => {
    expect(approvalMintsSession({ purpose: 'device_sign_in' })).toBe(true);
    expect(approvalMintsSession({ purpose: 'oauth_authorization' })).toBe(false);
  });
});

describe('claimAuthSession', () => {
  it('atomically claims an authorized request and marks the STORED row consumed', async () => {
    const { id, sessionToken } = await authSession({
      status: 'authorized',
      authorizedSessionId: 'sess-new',
    });

    const result = await claimAuthSession({ sessionToken });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authSession.authorizedSessionId).toBe('sess-new');
      // The claim credential is NOT handed back: the caller already had it, and
      // `auth_sessions.session_token` is a protected column.
      expect('sessionToken' in result.authSession).toBe(false);
    }

    const row = await stored(id);
    expect(row.status).toBe('consumed');
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  it('loses to a request whose status changed between the peek and the claim', async () => {
    const { id, sessionToken } = await authSession({ status: 'authorized' });

    const result = await loseTheRaceTo(
      (tx) =>
        tx
          .update(authSessions)
          .set({ status: 'cancelled' })
          .where(eq(authSessions.id, id))
          .then(() => undefined),
      () => claimAuthSession({ sessionToken })
    );

    // VACUITY FLOOR: `already_consumed` is only reachable through the atomic
    // claim, which is only reached if the peek saw `authorized`. Had the
    // competitor committed first, the peek would have answered `cancelled` — so
    // this outcome proves the interleave really happened.
    expect(result).toEqual({ ok: false, reason: 'already_consumed' });
    expect((await stored(id)).status).toBe('cancelled');
  });

  it('refuses a replay of an already-consumed request', async () => {
    const { sessionToken } = await authSession({ status: 'consumed' });
    expect(await claimAuthSession({ sessionToken })).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
  });

  it('distinguishes not_found, pending and cancelled', async () => {
    expect(await claimAuthSession({ sessionToken: `st-${randomUUID()}` })).toEqual({
      ok: false,
      reason: 'not_found',
    });

    const pending = await authSession();
    expect(await claimAuthSession({ sessionToken: pending.sessionToken })).toEqual({
      ok: false,
      reason: 'pending',
    });

    const cancelled = await authSession({ status: 'cancelled' });
    expect(await claimAuthSession({ sessionToken: cancelled.sessionToken })).toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });

  it('refuses an authorized request whose deadline has passed, and leaves it unclaimed', async () => {
    // The row is still PRESENT — `db/expiry.ts` keeps `auth_sessions` for an
    // hour past its deadline precisely so a late poll answers "expired" rather
    // than "never existed". The read-side filter is what makes that safe.
    const { id, sessionToken } = await authSession({
      status: 'authorized',
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await claimAuthSession({ sessionToken })).toEqual({ ok: false, reason: 'expired' });
    expect((await stored(id)).status).toBe('authorized');
  });

  it('refuses a status-expired request even while its deadline is in the future', async () => {
    const { sessionToken } = await authSession({ status: 'expired' });
    expect(await claimAuthSession({ sessionToken })).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses to claim an OAuth authorization request — a code flow never yields a token', async () => {
    const { id, sessionToken } = await authSession({
      ...oauthBinding(),
      status: 'authorized',
    });

    expect(await claimAuthSession({ sessionToken })).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });
    expect((await stored(id)).status).toBe('authorized');
  });
});

describe('verifyDelegatedSubject', () => {
  it('accepts an organization the identity may act as', async () => {
    mockVerifyActingAs.mockResolvedValueOnce('admin');
    const subject = await organization();
    const identity = await account();

    expect(await verifyDelegatedSubject(identity, subject)).toEqual({ ok: true, role: 'admin' });
    expect(mockVerifyActingAs).toHaveBeenCalledWith(identity, subject);
  });

  it('refuses a PERSONAL account as a subject — that would be impersonation', async () => {
    const subject = await account();
    const outcome = await verifyDelegatedSubject(await account(), subject);

    expect(outcome).toEqual({ ok: false, reason: 'personal_account' });
    // Refused before the membership lookup is even attempted.
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
  });

  /**
   * The second act-as door. Blocking `POST /accounts/:id/switch` alone would
   * leave this one open: an OAuth delegated subject is the other way an
   * application comes to act as an account, and it is gated by its own copy of
   * the predicate. Both now read `isActAsEligibleKind`.
   */
  it('refuses a CHANNEL account as a subject — nobody acts as a channel', async () => {
    const subject = await account({ kind: 'channel' });
    const outcome = await verifyDelegatedSubject(await account(), subject);

    expect(outcome).toEqual({ ok: false, reason: 'channel_account' });
    // Refused before the membership lookup is even attempted.
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
  });

  it('refuses an archived account', async () => {
    const subject = await account({ kind: 'organization', accountStatus: 'archived' });
    expect(await verifyDelegatedSubject(await account(), subject)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses when act_as membership does not hold', async () => {
    mockVerifyActingAs.mockResolvedValueOnce(null);
    expect(await verifyDelegatedSubject(await account(), await organization())).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('answers not_found for a malformed id instead of throwing a driver error', async () => {
    // The `isValidObjectId` guard is deleted: a text id that names no row is a
    // miss, not a cast failure, so a malformed subject is simply refused.
    expect(await verifyDelegatedSubject(await account(), 'not-an-id')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('authorizeSessionWithSignedChallenge', () => {
  /** A signer with a `users` row and a live signin challenge. */
  async function signer() {
    const publicKey = `pk-${randomUUID()}`;
    const userId = await account({ publicKey, username: `u${randomUUID().slice(0, 8)}` });
    return { publicKey, userId, challenge: await challenge(publicKey) };
  }

  function input(over: Record<string, unknown>) {
    return {
      publicKey: '',
      challenge: '',
      signature: 'sig',
      timestamp: Date.now(),
      req: {} as never,
      authorizeCode: '',
      ...over,
    };
  }

  it('binds the VERIFIED signer onto the stored row and burns the challenge', async () => {
    const { publicKey, userId, challenge: value } = await signer();
    const { id, authorizeCode, sessionToken } = await authSession();
    mockCreateSession.mockResolvedValueOnce({ sessionId: 'sess-signed' });

    const outcome = await authorizeSessionWithSignedChallenge(
      input({ authorizeCode, publicKey, challenge: value })
    );

    expect(outcome).toMatchObject({
      ok: true,
      sessionToken,
      sessionId: 'sess-signed',
      userId,
      publicKey,
    });

    const row = await stored(id);
    expect(row.status).toBe('authorized');
    expect(row.authorizedBy).toBe(publicKey);
    expect(row.authorizedUserId).toBe(userId);
    expect(row.authorizedSessionId).toBe('sess-signed');
    expect((await storedChallenge(value)).used).toBe(true);
  });

  it('resolves the signer case-insensitively, through the identifier index expression', async () => {
    // The account is stored UPPER-cased and the request arrives lower-cased.
    // The challenge is matched verbatim on the lower-cased form, so the only
    // lookup that has to bridge the case difference is the account one —
    // `lower(btrim(public_key))`, the expression `users_lower_public_key_key`
    // is built on. A plain `public_key = $1` would return "User not found".
    const stored = `PK-${randomUUID().toUpperCase()}`;
    const presented = stored.toLowerCase();
    const userId = await account({ publicKey: stored });
    const value = await challenge(presented);
    const { authorizeCode } = await authSession();

    expect(
      await authorizeSessionWithSignedChallenge(
        input({ authorizeCode, publicKey: presented, challenge: value })
      )
    ).toMatchObject({ ok: true, userId });
  });

  it('rejects an invalid signature and leaves the challenge SPENDABLE', async () => {
    const { publicKey, challenge: value } = await signer();
    const { id, authorizeCode } = await authSession();
    mockVerifyChallengeResponse.mockReturnValueOnce(false);

    const outcome = await authorizeSessionWithSignedChallenge(
      input({ authorizeCode, publicKey, challenge: value })
    );

    expect(outcome).toEqual({ ok: false, status: 401, message: 'Invalid signature' });
    expect((await storedChallenge(value)).used).toBe(false);
    expect((await stored(id)).status).toBe('pending');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects an EXPIRED challenge — the sweep is housekeeping, this filter is the gate', async () => {
    const publicKey = `pk-${randomUUID()}`;
    await account({ publicKey });
    // Still present in the table: `auth_challenges` is swept on an interval, so
    // dropping this read-side filter would leave it spendable in the meantime.
    const value = await challenge(publicKey, { expiresAt: new Date(Date.now() - 1_000) });
    const { authorizeCode } = await authSession();

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({ ok: false, status: 401, message: 'Invalid or expired challenge' });
    expect(mockVerifyChallengeResponse).not.toHaveBeenCalled();
  });

  it('rejects an already-used challenge', async () => {
    const publicKey = `pk-${randomUUID()}`;
    await account({ publicKey });
    const value = await challenge(publicKey, { used: true });
    const { authorizeCode } = await authSession();

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({ ok: false, status: 401, message: 'Invalid or expired challenge' });
  });

  it('rejects a rotate_key challenge at the gate — it can never mint a session', async () => {
    const publicKey = `pk-${randomUUID()}`;
    await account({ publicKey });
    const value = await challenge(publicKey, { purpose: 'rotate_key' });
    const { authorizeCode } = await authSession();

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({ ok: false, status: 401, message: 'Invalid or expired challenge' });
    // Refused before the signature is even checked, so a valid rotate_key
    // signature buys nothing on this path.
    expect(mockVerifyChallengeResponse).not.toHaveBeenCalled();
  });

  it('refuses when the challenge is burned between the read and its own burn', async () => {
    const { publicKey, challenge: value } = await signer();
    const [row] = await getDb()
      .select({ id: authChallenges.id })
      .from(authChallenges)
      .where(eq(authChallenges.challenge, value))
      .limit(1);
    const { authorizeCode } = await authSession();

    const outcome = await loseTheRaceTo(
      (tx) =>
        tx
          .update(authChallenges)
          .set({ used: true })
          .where(eq(authChallenges.id, row.id))
          .then(() => undefined),
      () =>
        authorizeSessionWithSignedChallenge(
          input({ authorizeCode, publicKey, challenge: value })
        )
    );

    expect(outcome).toEqual({ ok: false, status: 401, message: 'Invalid or expired challenge' });
    // VACUITY FLOOR: the signature check runs only AFTER the challenge read
    // succeeded, so its having been called proves the read saw the unburned
    // row and the rejection came from the burn's own `used = false` filter.
    expect(mockVerifyChallengeResponse).toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown or already-processed authorizeCode', async () => {
    const { publicKey, challenge: value } = await signer();
    expect(
      await authorizeSessionWithSignedChallenge(
        input({ authorizeCode: `ac-${randomUUID()}`, publicKey, challenge: value })
      )
    ).toEqual({ ok: false, status: 404, message: 'Auth session not found or already processed' });

    const signerTwo = await signer();
    const { authorizeCode } = await authSession({ status: 'authorized' });
    expect(
      await authorizeSessionWithSignedChallenge(
        input({ authorizeCode, publicKey: signerTwo.publicKey, challenge: signerTwo.challenge })
      )
    ).toEqual({ ok: false, status: 404, message: 'Auth session not found or already processed' });
  });

  it('marks an elapsed request EXPIRED in the stored row and mints nothing', async () => {
    const { publicKey, challenge: value } = await signer();
    const { id, authorizeCode } = await authSession({
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({ ok: false, status: 400, message: 'Auth session has expired' });
    expect((await stored(id)).status).toBe('expired');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('returns 404 when no account owns the signer public key', async () => {
    const publicKey = `pk-${randomUUID()}`;
    const value = await challenge(publicKey);
    const { id, authorizeCode } = await authSession();

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({ ok: false, status: 404, message: 'User not found' });
    expect((await stored(id)).status).toBe('pending');
  });

  it('isolates the claimant from a requester-supplied deviceId', async () => {
    const { publicKey, challenge: value } = await signer();
    const { authorizeCode } = await authSession({ deviceId: 'device-xyz' });

    await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }));

    const options = mockCreateSession.mock.calls[0]?.[2] as { deviceId: string };
    expect(options.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.deviceId).not.toBe('device-xyz');
  });

  it('labels the minted device with the bound application name', async () => {
    const { publicKey, challenge: value } = await signer();
    const applicationId = await application({ name: 'Acme Widgets' });
    const { authorizeCode } = await authSession({ applicationId });

    await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }));

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ deviceName: 'Acme Widgets App' })
    );
  });

  it('approves an OAuth request WITHOUT minting a session', async () => {
    const { publicKey, userId, challenge: value } = await signer();
    const { id, authorizeCode } = await authSession(oauthBinding());

    const outcome = await authorizeSessionWithSignedChallenge(
      input({ authorizeCode, publicKey, challenge: value })
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.sessionId).toBeUndefined();
    expect(mockCreateSession).not.toHaveBeenCalled();

    const row = await stored(id);
    expect(row.status).toBe('authorized');
    expect(row.authorizedUserId).toBe(userId);
    expect(row.authorizedSessionId).toBeNull();
  });

  it('refuses (403) when the signer cannot act as the delegated subject', async () => {
    mockVerifyActingAs.mockResolvedValueOnce(null);
    const { publicKey, challenge: value } = await signer();
    const subject = await organization();
    const { id, authorizeCode } = await authSession(
      oauthBinding({ oauthSubjectAccountId: subject })
    );

    expect(
      await authorizeSessionWithSignedChallenge(input({ authorizeCode, publicKey, challenge: value }))
    ).toEqual({
      ok: false,
      status: 403,
      message: 'Not authorized to act as the requested account',
    });
    // Nothing is bound — the request stays approvable by someone who does hold it.
    expect((await stored(id)).status).toBe('pending');
  });
});

describe('authorizeSessionWithBearer', () => {
  function input(over: Record<string, unknown>) {
    return {
      authorizeCode: '',
      authenticatedUserId: '',
      req: {} as never,
      ...over,
    };
  }

  it('claims the request, binds the bearer identity, and attaches the minted session', async () => {
    const userId = await account();
    const { id, authorizeCode, sessionToken } = await authSession();
    mockCreateSession.mockResolvedValueOnce({ sessionId: 'sess-bearer' });

    const outcome = await authorizeSessionWithBearer(
      input({ authorizeCode, authenticatedUserId: userId, authenticatedPublicKey: 'pk-hub' })
    );

    expect(outcome).toEqual({ ok: true, sessionToken, sessionId: 'sess-bearer' });

    const row = await stored(id);
    expect(row.status).toBe('authorized');
    expect(row.authorizedUserId).toBe(userId);
    expect(row.authorizedBy).toBe('pk-hub');
    expect(row.authorizedSessionId).toBe('sess-bearer');
  });

  it('mints NOTHING when the request expires between the peek and the claim', async () => {
    const userId = await account();
    const { id, authorizeCode } = await authSession();

    const outcome = await loseTheRaceTo(
      (tx) =>
        tx
          .update(authSessions)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(authSessions.id, id))
          .then(() => undefined),
      () => authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }))
    );

    // VACUITY FLOOR: 404 comes ONLY from the atomic claim matching nothing. Had
    // the competitor committed first, the peek's own expiry check would have
    // answered 400 "Auth session has expired" — a different status.
    expect(outcome).toEqual({
      ok: false,
      status: 404,
      message: 'Auth session not found or already processed',
    });
    // Rejected BEFORE minting — the whole point of the claim being one
    // conditional update rather than a read followed by a write.
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect((await stored(id)).status).toBe('pending');
  });

  it('returns 404 for an unknown code and for an already-processed one', async () => {
    const userId = await account();
    expect(
      await authorizeSessionWithBearer(
        input({ authorizeCode: `ac-${randomUUID()}`, authenticatedUserId: userId })
      )
    ).toEqual({ ok: false, status: 404, message: 'Auth session not found or already processed' });

    const { authorizeCode } = await authSession({ status: 'authorized' });
    expect(
      await authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }))
    ).toEqual({ ok: false, status: 404, message: 'Auth session not found or already processed' });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('returns 400 for an elapsed request without attempting the claim', async () => {
    const userId = await account();
    const { id, authorizeCode } = await authSession({ expiresAt: new Date(Date.now() - 1_000) });

    expect(
      await authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }))
    ).toEqual({ ok: false, status: 400, message: 'Auth session has expired' });
    expect((await stored(id)).status).toBe('pending');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('approves an OAuth request without minting a session', async () => {
    const userId = await account();
    const { id, authorizeCode, sessionToken } = await authSession(oauthBinding());

    expect(
      await authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }))
    ).toEqual({ ok: true, sessionToken });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect((await stored(id)).authorizedSessionId).toBeNull();
  });

  it('refuses (403) a delegated subject the bearer cannot act as, before claiming', async () => {
    mockVerifyActingAs.mockResolvedValueOnce(null);
    const userId = await account();
    const { id, authorizeCode } = await authSession(
      oauthBinding({ oauthSubjectAccountId: await organization() })
    );

    expect(
      await authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }))
    ).toEqual({
      ok: false,
      status: 403,
      message: 'Not authorized to act as the requested account',
    });
    expect((await stored(id)).status).toBe('pending');
  });

  it('isolates the claimant from a requester-supplied deviceId', async () => {
    const userId = await account();
    const { authorizeCode } = await authSession({ deviceId: 'device-xyz' });

    await authorizeSessionWithBearer(input({ authorizeCode, authenticatedUserId: userId }));

    const options = mockCreateSession.mock.calls[0]?.[2] as { deviceId: string };
    expect(options.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.deviceId).not.toBe('device-xyz');
  });
});

describe('finalizeOAuthAuthorization', () => {
  /** An APPROVED, OAuth-bound request ready to be finalized. */
  async function approved(
    over: Partial<typeof authSessions.$inferInsert> = {},
    appOver: Partial<typeof applications.$inferInsert> = {}
  ) {
    const identityUserId = await account();
    const applicationId = await application(appOver);
    const session = await authSession({
      applicationId,
      ...oauthBinding(),
      status: 'authorized',
      authorizedUserId: identityUserId,
      ...over,
    });
    return { ...session, identityUserId, applicationId };
  }

  it('mints exactly one code, spends the request, and RESERVES the code id on the row', async () => {
    const { id, sessionToken } = await approved();

    const outcome = await finalizeOAuthAuthorization({ sessionToken });

    expect(outcome).toEqual({
      ok: true,
      code: 'raw-code',
      redirectUri: REDIRECT_URI,
      expiresIn: 60,
    });

    const row = await stored(id);
    expect(row.status).toBe('consumed');
    expect(row.consumedAt).toBeInstanceOf(Date);
    // The reservation: the id was allocated and written by the SAME update that
    // spent the request, and handed to the minter afterwards.
    expect(row.finalizedAuthCodeId).toEqual(expect.any(String));
    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ codeId: row.finalizedAuthCodeId })
    );
  });

  it('mints NO code when the request is spent between the peek and the claim', async () => {
    const { id, sessionToken } = await approved();

    const outcome = await loseTheRaceTo(
      (tx) =>
        tx
          .update(authSessions)
          .set({ status: 'cancelled' })
          .where(eq(authSessions.id, id))
          .then(() => undefined),
      () => finalizeOAuthAuthorization({ sessionToken })
    );

    // VACUITY FLOOR: `already_finalized` is the atomic claim's own miss. Had the
    // competitor committed first, the peek would have answered `not_authorized`.
    expect(outcome).toEqual({ ok: false, reason: 'already_finalized' });
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('refuses a row that already RESERVED a code id, whatever its status says', async () => {
    // The reservation is the single-use record: `finalized_auth_code_id` is
    // written by the same update that spends the request, so a row carrying one
    // has already had its one code — even if some other path left the status
    // looking claimable.
    const { sessionToken } = await approved({ finalizedAuthCodeId: randomUUID() });

    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'already_finalized',
    });
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('a finalized request can never mint a second code', async () => {
    const { sessionToken } = await approved();
    expect((await finalizeOAuthAuthorization({ sessionToken })).ok).toBe(true);
    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'already_finalized',
    });
    expect(mockIssueAuthCode).toHaveBeenCalledTimes(1);
  });

  it('leaves the request SPENT when the mint itself fails — fail closed', async () => {
    const { id, sessionToken } = await approved();
    mockIssueAuthCode.mockRejectedValueOnce(new Error('mint exploded'));

    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'issue_failed',
    });

    const row = await stored(id);
    expect(row.status).toBe('consumed');
    expect(row.finalizedAuthCodeId).toEqual(expect.any(String));
    // …and the spent request cannot be retried into a second minting attempt.
    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'already_finalized',
    });
  });

  it('refuses every precondition failure, and mints nothing for any of them', async () => {
    expect(await finalizeOAuthAuthorization({ sessionToken: `st-${randomUUID()}` })).toEqual({
      ok: false,
      reason: 'not_found',
    });

    const deviceSignIn = await authSession({ status: 'authorized' });
    expect(await finalizeOAuthAuthorization({ sessionToken: deviceSignIn.sessionToken })).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });

    const unapproved = await authSession(oauthBinding());
    expect(await finalizeOAuthAuthorization({ sessionToken: unapproved.sessionToken })).toEqual({
      ok: false,
      reason: 'not_authorized',
    });

    const expired = await approved({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await finalizeOAuthAuthorization({ sessionToken: expired.sessionToken })).toEqual({
      ok: false,
      reason: 'expired',
    });

    const suspended = await approved({}, { status: 'suspended' });
    expect(await finalizeOAuthAuthorization({ sessionToken: suspended.sessionToken })).toEqual({
      ok: false,
      reason: 'application_unavailable',
    });

    const unregistered = await approved({}, { redirectUris: ['https://other.example/cb'] });
    expect(await finalizeOAuthAuthorization({ sessionToken: unregistered.sessionToken })).toEqual({
      ok: false,
      reason: 'redirect_uri_unregistered',
    });

    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('refuses an approved row whose approver was never recorded', async () => {
    const { sessionToken } = await authSession({ ...oauthBinding(), status: 'authorized' });
    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'not_authorized',
    });
  });

  it('intersects the requested scopes with the application registered set', async () => {
    const { sessionToken } = await approved(
      { oauthScopes: ['user:read', 'files:write'] },
      { scopes: ['user:read', 'files:read'] }
    );

    await finalizeOAuthAuthorization({ sessionToken });

    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['user:read'] })
    );
  });

  it('falls back to the application scopes when the request named none', async () => {
    const { sessionToken } = await approved({ oauthScopes: [] }, { scopes: ['user:read'] });

    await finalizeOAuthAuthorization({ sessionToken });

    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['user:read'] })
    );
  });

  it('threads the originating device id into the code', async () => {
    const { sessionToken } = await approved({ deviceId: 'device-rp' });
    await finalizeOAuthAuthorization({ sessionToken });
    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-rp' })
    );
  });

  it('records a revocable grant for a third-party app', async () => {
    const { sessionToken, identityUserId, applicationId } = await approved();

    await finalizeOAuthAuthorization({ sessionToken });

    const [grant] = await getDb()
      .select()
      .from(appGrants)
      .where(eq(appGrants.applicationId, applicationId));
    expect(grant).toMatchObject({ userId: identityUserId, scopes: ['user:read'] });
    expect(grant.firstGrantedAt).toBeInstanceOf(Date);
  });

  it('UNIONS scopes onto an existing grant, keeping each scope first position', async () => {
    const identityUserId = await account();
    const applicationId = await application({ scopes: ['user:read', 'files:read'] });
    await getDb().insert(appGrants).values({
      userId: identityUserId,
      applicationId,
      scopes: ['files:read'],
    });
    const { sessionToken } = await authSession({
      applicationId,
      ...oauthBinding({ oauthScopes: ['files:read', 'user:read'] }),
      status: 'authorized',
      authorizedUserId: identityUserId,
    });

    await finalizeOAuthAuthorization({ sessionToken });

    const [grant] = await getDb()
      .select()
      .from(appGrants)
      .where(eq(appGrants.applicationId, applicationId));
    // `files:read` was already granted and keeps its slot; `user:read` is
    // appended. A re-granted scope must not be duplicated, which is what
    // Mongo's `$addToSet` guaranteed.
    expect(grant.scopes).toEqual(['files:read', 'user:read']);
  });

  it('never records a grant for a TRUSTED application — those are auto-approved', async () => {
    const { sessionToken, applicationId } = await approved({}, { isOfficial: true });

    await finalizeOAuthAuthorization({ sessionToken });

    const grants = await getDb()
      .select()
      .from(appGrants)
      .where(eq(appGrants.applicationId, applicationId));
    expect(grants).toHaveLength(0);
  });

  it('issues the code FOR the delegated subject, with the approving identity recorded beside it', async () => {
    mockVerifyActingAs.mockResolvedValue('admin');
    const subject = await organization();
    const { sessionToken, identityUserId } = await approved({
      oauthSubjectAccountId: subject,
    });

    expect((await finalizeOAuthAuthorization({ sessionToken })).ok).toBe(true);

    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ userId: subject, operatedByUserId: identityUserId })
    );
  });

  it('re-checks act_as at FINALIZE, not just at approval', async () => {
    // Approval already happened; membership has since been revoked.
    mockVerifyActingAs.mockResolvedValue(null);
    const { id, sessionToken } = await approved({
      oauthSubjectAccountId: await organization(),
    });

    expect(await finalizeOAuthAuthorization({ sessionToken })).toEqual({
      ok: false,
      reason: 'delegation_denied',
    });
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
    // Refused before the request is spent, so a re-granted membership can still
    // finalize it within its deadline.
    expect((await stored(id)).status).toBe('authorized');
  });

  it('records the grant against the SUBJECT account, never the approving identity', async () => {
    mockVerifyActingAs.mockResolvedValue('admin');
    const subject = await organization();
    const { sessionToken, applicationId } = await approved({ oauthSubjectAccountId: subject });

    await finalizeOAuthAuthorization({ sessionToken });

    const [grant] = await getDb()
      .select()
      .from(appGrants)
      .where(eq(appGrants.applicationId, applicationId));
    expect(grant.userId).toBe(subject);
  });
});
