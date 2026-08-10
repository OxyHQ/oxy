/**
 * `ensureManagedSessionAuthorized` must FAIL CLOSED when the `account:act_as`
 * membership lookup cannot be answered (issue #937).
 *
 * It used to fail OPEN — the catch returned `true`, on the reasoning that a
 * transient database error should not lock a legitimately-switched operator
 * out. The cost of that reasoning is the whole point of this file: while the
 * membership read is broken, EVERY managed-account session on the platform
 * authorizes itself, including the ones whose delegation was just revoked.
 *
 * ## Why the error here is a real one from a real server
 *
 * A synthetic `{ code: '42P01' }` fixture, or a `jest.fn()` that throws `new
 * Error('boom')`, satisfies BOTH readings of the catch and therefore proves
 * nothing about which one is in the file: the branch is entered either way and
 * the only difference is the value it returns. What it also cannot prove is that
 * the error would ever ARRIVE — that the lookup really does read a table, on a
 * connection, whose failure surfaces as an exception rather than an empty
 * result. So `account.service` runs for real, and the table its membership read
 * names is taken away underneath it. The error is Postgres' own, its SQLSTATE
 * arrives on `cause` (never on `error.code`, which is the shape a ported Mongo
 * check would have looked for), and the positive control below proves the same
 * call answers normally when the table is there.
 *
 * If the catch is ever widened back to `return true`, the first case goes red.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { eq, sql } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import { accountService } from '../account.service';
import sessionService from '../session.service';

function request(): Request {
  return {
    headers: { 'user-agent': 'jest', 'accept-language': 'en-US' },
  } as unknown as Request;
}

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

/** A live managed session: the org account, operated by a member who may act as it. */
async function managedSession(): Promise<{ sessionId: string; operatorId: string; orgId: string }> {
  const operatorId = await account();
  const orgId = await account({
    kind: 'organization',
    username: `org-${randomUUID().slice(0, 8)}`,
  });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: orgId, memberUserId: operatorId, role: 'admin', status: 'active' });
  const session = await sessionService.createSession(orgId, request(), {
    deviceId: `dev-${randomUUID()}`,
    operatedByUserId: operatorId,
  });
  return { sessionId: session.sessionId, operatorId, orgId };
}

/**
 * Take the membership table away for the duration of `run`.
 *
 * A RENAME, not a DROP: the rows survive, so nothing else in this worker's
 * database is destroyed if the restore is ever skipped, and the failure the
 * lookup meets is the ordinary `42P01` a missing relation produces.
 */
async function withMembershipTableMissing<T>(run: () => Promise<T>): Promise<T> {
  const db = getDb();
  await db.execute(sql`alter table account_members rename to account_members__gone`);
  try {
    return await run();
  } finally {
    await db.execute(sql`alter table account_members__gone rename to account_members`);
  }
}

beforeAll(async () => {
  await connectPostgres();
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
  userCache.clear();
});

describe('ensureManagedSessionAuthorized — an unanswerable membership question', () => {
  it('the lookup really does throw a real Postgres error when the table is gone', async () => {
    const { operatorId, orgId } = await managedSession();

    // The control for the control: this is the exact call the session service
    // makes, and it must FAIL rather than answer `null`, or the case below
    // would be testing the "no membership" branch instead of the catch.
    const thrown = await withMembershipTableMissing(async () => {
      try {
        await accountService.verifyActingAs(operatorId, orgId);
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    // A drizzle error carries its SQLSTATE on `cause`, never on `error.code` —
    // a ported `err.code === '42P01'` would match nothing here.
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('42P01');
  });

  it('refuses the managed session rather than authorizing it', async () => {
    const { sessionId } = await managedSession();

    const validated = await withMembershipTableMissing(() =>
      sessionService.validateSessionById(sessionId, false)
    );

    expect(validated).toBeNull();
  });

  it('does not DESTROY the session — an unanswered question is not a revocation', async () => {
    const { sessionId } = await managedSession();

    await withMembershipTableMissing(() => sessionService.validateSessionById(sessionId, false));

    const [stored] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);
    expect(stored.isActive).toBe(true);
  });

  it('re-asks on the very next request instead of inheriting the failure', async () => {
    const { sessionId } = await managedSession();

    await withMembershipTableMissing(() => sessionService.validateSessionById(sessionId, false));
    // The throttle window is 60s. A failed check that had written the recheck
    // timestamp would make this second call answer from the cache — and, worse,
    // answer `true` without asking anybody.
    const recovered = await sessionService.validateSessionById(sessionId, false);

    expect(recovered).not.toBeNull();
  });

  it('positive control: the same session validates normally while the table is there', async () => {
    const { sessionId } = await managedSession();

    expect(await sessionService.validateSessionById(sessionId, false)).not.toBeNull();
  });

  it('still fails closed on a definitive answer — a revoked membership', async () => {
    const { sessionId, orgId } = await managedSession();
    await getDb().delete(accountMembers).where(eq(accountMembers.accountId, orgId));

    expect(await sessionService.validateSessionById(sessionId, false)).toBeNull();
    // …and THIS one is a revocation, so the session really is destroyed.
    const [stored] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);
    expect(stored.isActive).toBe(false);
  });
});
