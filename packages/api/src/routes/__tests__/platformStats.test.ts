/**
 * `GET /platform-stats` — the numbers-only staff DTO, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **Every counter must reach the client as a JSON NUMBER.**
 *
 * Postgres `count(*)` is `bigint` and the driver returns a bigint as a STRING.
 * `res.json` serializes `"42"` exactly as happily as `42`, so a naive port turns
 * every field of this DTO into a string with no error at any layer — the SQL
 * runs, the route answers 200, the dashboard renders, and every consumer's
 * arithmetic is quietly wrong. `emits every counter as a JSON number` below is
 * the only thing standing between that and production, which is why it asserts
 * `typeof`, not the value: `expect(body.totalUsers).toBe(3)` passes against
 * `"3"` under `toEqual` semantics for no field, but a test that only checked ONE
 * counter's value would still let the other seven regress.
 *
 * ## Why the counter assertions are a sandwich, not an equality
 *
 * These are WHOLE-TABLE counts and jest runs suites in parallel against ONE
 * throwaway database, so no suite can own `count(users)`. Each field is instead
 * bracketed by an independently-written reference count taken immediately
 * before and after the request: under a quiescent database the three are equal,
 * and under a concurrent one the bracket still holds. It is not a weaker
 * assertion than it looks — a field wired to the WRONG table lands outside the
 * bracket, and the two filtered counters (`activeSessions`, `totalApplications`)
 * are seeded so that their unfiltered counterpart is strictly larger, which is
 * what makes a dropped `WHERE` fail rather than merely look plausible.
 *
 * ## The 2-second cache
 *
 * `fetchStats` memoizes for 2s, so this file issues exactly ONE request and
 * asserts everything against that single body. The seeding therefore all happens
 * before the first call.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt } from 'drizzle-orm';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  // `routes/accounts.ts` reaches this module too, and its service-scoped
  // provisioning routes take `serviceAuthMiddleware` as a handler. Omitting it
  // from a WHOLE-module mock makes Express refuse the route at import time
  // ("requires a callback function but got [object Undefined]"), which fails the
  // suite before a single test runs.
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/requireStaff', () => ({
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { notifications } from '../../db/schema/notifications';
import { sessions } from '../../db/schema/sessions';
import { transactions } from '../../db/schema/transactions';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import platformStatsRouter from '../platform-stats';

const HOUR_MS = 60 * 60 * 1000;

/** The one response body every case reads. */
let body: Record<string, unknown>;
/** Reference counts taken immediately before and after that request. */
let before: Record<string, number>;
let after: Record<string, number>;
/** Unfiltered counterparts, for the two counters that carry a `WHERE`. */
let sessionsIgnoringExpiry = 0;
let applicationsIgnoringStatus = 0;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertSession(
  userId: string,
  options: { isActive: boolean; expiresAt: Date }
): Promise<void> {
  await getDb().insert(sessions).values({
    sessionId: randomUUID(),
    userId,
    deviceId: randomUUID(),
    deviceType: 'desktop',
    platform: 'web',
    accessToken: randomUUID(),
    refreshToken: randomUUID(),
    isActive: options.isActive,
    expiresAt: options.expiresAt,
  });
}

/** Every reference count, computed independently of the route. */
async function reference(): Promise<Record<string, number>> {
  const db = getDb();
  const [
    totalUsers,
    activeSessions,
    totalMessages,
    totalNotifications,
    totalFiles,
    totalTransactions,
    totalApplications,
    totalFollows,
  ] = await Promise.all([
    db.select({ n: count() }).from(users),
    db
      .select({ n: count() })
      .from(sessions)
      .where(and(eq(sessions.isActive, true), gt(sessions.expiresAt, new Date()))),
    db.select({ n: count() }).from(messages),
    db.select({ n: count() }).from(notifications),
    db.select({ n: count() }).from(files),
    db.select({ n: count() }).from(transactions),
    db.select({ n: count() }).from(applications).where(eq(applications.status, 'active')),
    db.select({ n: count() }).from(userFollows),
  ]);

  return {
    totalUsers: totalUsers[0].n,
    activeSessions: activeSessions[0].n,
    totalMessages: totalMessages[0].n,
    totalNotifications: totalNotifications[0].n,
    totalFiles: totalFiles[0].n,
    totalTransactions: totalTransactions[0].n,
    totalApplications: totalApplications[0].n,
    totalFollows: totalFollows[0].n,
  };
}

async function getStats(): Promise<Record<string, unknown>> {
  const app = express();
  app.use('/platform-stats', platformStatsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/platform-stats`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

beforeAll(async () => {
  await connectPostgres();
  const db = getDb();

  // Distinct row counts per table, so a counter wired to the WRONG table cannot
  // land inside the right one's bracket by coincidence.
  const owner = await insertUser();
  const follower = await insertUser();
  const secondFollower = await insertUser();

  const [mailbox] = await db
    .insert(mailboxes)
    .values({ userId: owner, name: 'Inbox', path: `Inbox-${randomUUID()}` })
    .returning({ id: mailboxes.id });

  await db.insert(messages).values(
    Array.from({ length: 3 }, () => ({
      userId: owner,
      mailboxId: mailbox.id,
      messageId: `<${randomUUID()}@oxy.so>`,
      fromAddress: 'sender@example.com',
      subject: 'Seeded',
      size: 128,
      date: new Date(),
    }))
  );

  await db.insert(notifications).values(
    Array.from({ length: 5 }, () => ({
      recipientId: owner,
      actorId: follower,
      type: 'like' as const,
      entityId: randomUUID(),
      entityType: 'post' as const,
    }))
  );

  await db.insert(files).values(
    Array.from({ length: 7 }, () => ({
      sha256: randomUUID().replace(/-/g, '').repeat(2),
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      ownerUserId: owner,
      storageKey: `seed/${randomUUID()}`,
    }))
  );

  await db
    .insert(transactions)
    .values([{ userId: owner, type: 'deposit' as const, amount: '1.00000000' }]);

  await db.insert(userFollows).values([
    { followerId: follower, followedId: owner },
    { followerId: secondFollower, followedId: owner },
  ]);

  // Two `active` applications and one `deleted` one — the deleted row is what
  // makes the status filter falsifiable rather than merely present.
  await db.insert(applications).values([
    { name: `Seed ${randomUUID()}`, ownerAccountId: owner, status: 'active' as const },
    { name: `Seed ${randomUUID()}`, ownerAccountId: owner, status: 'active' as const },
    { name: `Seed ${randomUUID()}`, ownerAccountId: owner, status: 'deleted' as const },
  ]);

  // One live session, plus the two shapes the counter must NOT count.
  await insertSession(owner, { isActive: true, expiresAt: new Date(Date.now() + HOUR_MS) });
  await insertSession(owner, { isActive: false, expiresAt: new Date(Date.now() + HOUR_MS) });
  await insertSession(owner, { isActive: true, expiresAt: new Date(Date.now() - HOUR_MS) });

  before = await reference();
  body = await getStats();
  after = await reference();

  // The UNFILTERED counts are read LAST, and the ordering is load-bearing.
  //
  // Every assertion below compares an unfiltered count against a FILTERED one
  // taken at a different instant, and this suite shares its database with the
  // whole run — so other suites are inserting `is_active` sessions and `active`
  // applications throughout. Reading unfiltered FIRST let those inserts inflate
  // the filtered figure afterwards until it caught up, and
  // `unfiltered > filtered` flaked. Read last, a concurrent insert can only
  // inflate the unfiltered side, and the strict inequality is then carried by
  // the expired session and the `deleted` application THIS suite seeded — which
  // is the property the assertions are actually about.
  [sessionsIgnoringExpiry] = (
    await db.select({ n: count() }).from(sessions).where(eq(sessions.isActive, true))
  ).map((row) => row.n);
  [applicationsIgnoringStatus] = (await db.select({ n: count() }).from(applications)).map(
    (row) => row.n
  );
});

afterAll(async () => {
  await closePostgres();
});

/** Every counter field, in the order the DTO declares them. */
const COUNTERS = [
  'totalUsers',
  'activeSessions',
  'totalMessages',
  'totalNotifications',
  'totalFiles',
  'totalTransactions',
  'totalApplications',
  'totalFollows',
] as const;

describe('the wire format', () => {
  it('emits every counter as a JSON number, never a bigint string', () => {
    // THE guarantee. `count(*)` is bigint and the driver hands a bigint back as
    // a string; `res.json` cannot tell the difference and neither can a consumer
    // until it does arithmetic.
    for (const field of COUNTERS) {
      expect(typeof body[field]).toBe('number');
      expect(Number.isInteger(body[field])).toBe(true);
    }
    expect(typeof body.aiModels).toBe('number');
  });

  it('carries exactly the ten documented fields, and `totalApplications` keeps its name', () => {
    // `totalApplications` was renamed from the legacy developer-app model on
    // purpose; drifting back would break the console silently.
    expect(Object.keys(body).sort()).toEqual(
      [...COUNTERS, 'aiModels', 'timestamp'].sort()
    );
  });

  it('reports the AI model constant and an ISO-8601 timestamp', () => {
    expect(body.aiModels).toBe(4);
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(String(body.timestamp)).toISOString()).toBe(body.timestamp);
  });
});

describe('each counter measures its own table', () => {
  it.each(COUNTERS)('%s matches an independent count of that table', (field) => {
    const low = Math.min(before[field], after[field]);
    const high = Math.max(before[field], after[field]);
    expect(body[field]).toBeGreaterThanOrEqual(low);
    expect(body[field]).toBeLessThanOrEqual(high);
  });

  it('counted the rows this suite seeded (guards against a vacuous bracket)', () => {
    // A bracket around zero would pass for every field regardless of wiring.
    expect(before.totalUsers).toBeGreaterThanOrEqual(3);
    expect(before.totalMessages).toBeGreaterThanOrEqual(3);
    expect(before.totalNotifications).toBeGreaterThanOrEqual(5);
    expect(before.totalFiles).toBeGreaterThanOrEqual(7);
    expect(before.totalTransactions).toBeGreaterThanOrEqual(1);
    expect(before.totalFollows).toBeGreaterThanOrEqual(2);
    expect(before.totalApplications).toBeGreaterThanOrEqual(2);
    expect(before.activeSessions).toBeGreaterThanOrEqual(1);
  });
});

describe('the two counters that carry a WHERE', () => {
  it('excludes a session that is still `is_active` but has expired', () => {
    // The Mongo query filtered on `isActive` alone and leant on a TTL index to
    // have already removed the row. Nothing in this codebase DELETES a session,
    // so without the expiry predicate this number grows without bound between
    // sweeps — a plausible-looking wrong answer, which is the failure mode this
    // whole batch exists to remove. Drop the predicate and the reported figure
    // becomes the unfiltered one below.
    expect(sessionsIgnoringExpiry).toBeGreaterThan(before.activeSessions);
    expect(body.activeSessions).toBeLessThan(sessionsIgnoringExpiry);
  });

  it('excludes an application whose status is not `active`', () => {
    expect(applicationsIgnoringStatus).toBeGreaterThan(before.totalApplications);
    expect(body.totalApplications).toBeLessThan(applicationsIgnoringStatus);
  });
});
