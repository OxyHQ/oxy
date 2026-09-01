/**
 * Subscription status projection — against a REAL Postgres.
 *
 * This is the replacement for a Mongo TTL index that DELETED a subscription when
 * its period closed. The single most important assertion in this file is
 * therefore a NEGATIVE one: the projection must relabel and never remove. A port
 * that "worked" by deleting would satisfy every status assertion here and still
 * be the data-loss bug the removal exists to fix, so the row count is checked
 * explicitly.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';
import { subscriptions } from '../schema/subscriptions';
import { users } from '../schema/users';
import { projectExpiredSubscriptions } from '../subscriptionStatus';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** The whole run shares one database, so every test mints its own account. */
async function account(): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return user.id;
}

async function giveSubscription(
  userId: string,
  status: 'active' | 'canceled' | 'expired',
  endDate: Date,
): Promise<void> {
  await getDb().insert(subscriptions).values({
    userId,
    plan: 'pro',
    status,
    startDate: new Date(Date.now() - 30 * DAY_MS),
    endDate,
  });
}

async function storedRows(userId: string) {
  return getDb()
    .select({ status: subscriptions.status, plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
}

describe('projectExpiredSubscriptions', () => {
  it('relabels a lapsed active subscription WITHOUT deleting it', async () => {
    const userId = await account();
    await giveSubscription(userId, 'active', new Date(Date.now() - DAY_MS));

    await projectExpiredSubscriptions(getDb());

    // The label caught up...
    const rows = await storedRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('expired');
    // ...and the record of what was bought is still here. A TTL index would have
    // destroyed this row, which is the bug being removed.
    expect(rows[0].plan).toBe('pro');
  });

  it('leaves a subscription whose period is still open alone', async () => {
    const userId = await account();
    await giveSubscription(userId, 'active', new Date(Date.now() + 30 * DAY_MS));

    await projectExpiredSubscriptions(getDb());

    expect((await storedRows(userId))[0].status).toBe('active');
  });

  it('never overwrites an explicit cancellation', async () => {
    const userId = await account();
    await giveSubscription(userId, 'canceled', new Date(Date.now() - DAY_MS));

    await projectExpiredSubscriptions(getDb());

    // A cancellation is a decision the user made; the deadline does not outrank it.
    expect((await storedRows(userId))[0].status).toBe('canceled');
  });

  it('is idempotent — a second run does not touch an already-expired row', async () => {
    const userId = await account();
    await giveSubscription(userId, 'active', new Date(Date.now() - DAY_MS));

    const first = await projectExpiredSubscriptions(getDb());
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const [afterFirst] = await getDb()
      .select({ status: subscriptions.status, updatedAt: subscriptions.updatedAt })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    expect(afterFirst.status).toBe('expired');

    await projectExpiredSubscriptions(getDb());

    // Asserted on THIS row rather than on a global "0 rows moved" count: the
    // projection is fleet-wide and jest runs suites in parallel against one
    // database, so another suite's lapsed row could legitimately be relabelled
    // between the two passes. An untouched `updated_at` is the stronger claim
    // anyway — the second pass performed no write at all, which is what
    // "materialization of an already-false predicate" means.
    const [afterSecond] = await getDb()
      .select({ status: subscriptions.status, updatedAt: subscriptions.updatedAt })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    expect(afterSecond.status).toBe('expired');
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
  });

  it('reports truncation when the batch ceiling is hit, and finishes on the next run', async () => {
    const userId = await account();
    await giveSubscription(userId, 'active', new Date(Date.now() - DAY_MS));
    await giveSubscription(userId, 'active', new Date(Date.now() - 2 * DAY_MS));

    // One row per statement, one statement per run: the caller must be told rows
    // remain rather than silently leaving a backlog behind. The ceiling is what
    // is asserted, not a global tally — two of the lapsed rows are this test's,
    // so a bounded run always fills its single batch.
    const first = await projectExpiredSubscriptions(getDb(), { batchSize: 1, maxBatches: 1 });
    expect(first).toEqual({ expired: 1, truncated: true });

    const second = await projectExpiredSubscriptions(getDb(), { batchSize: 1, maxBatches: 100 });
    expect(second.truncated).toBe(false);

    const rows = await storedRows(userId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'expired')).toBe(true);
  });
});

describe('the expiry sweep registry', () => {
  it('does NOT contain subscriptions', () => {
    // `db/expiry.ts` DELETES the rows it is given. Registering this table would
    // reinstate the exact TTL behaviour that destroyed subscription records —
    // the projection above is the deliberate alternative.
    const registered = EXPIRY_SWEEP_TARGETS.map((target) => target.table);
    expect(registered).not.toContain(subscriptions);
  });
});
