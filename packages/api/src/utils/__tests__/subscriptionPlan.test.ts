/**
 * Premium-plan resolution — against a REAL Postgres.
 *
 * This used to mock both Mongoose models, which meant it asserted the call
 * SHAPE and nothing about the query. That mattered here more than usual: the
 * legacy `subscriptions` table lost its Mongo TTL index (which DELETED lapsed
 * rows and destroyed the record of what was bought), so the read is now the only
 * thing standing between a lapsed subscription and a live premium entitlement.
 * A mock cannot see that, so the whole suite runs against real rows.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
import { subscriptions } from '../../db/schema/subscriptions';
import { users } from '../../db/schema/users';
import { isPremiumSubscriptionPlan, resolveUserSubscriptionPlan } from '../subscriptionPlan';

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

async function giveBillingSubscription(
  userId: string,
  values: { planName: string; status: 'active' | 'trialing' | 'canceled' | 'past_due' },
): Promise<void> {
  await getDb().insert(billingSubscriptions).values({
    userId,
    stripeCustomerId: `cus_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    stripePriceId: 'price_test',
    status: values.status,
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
    planName: values.planName,
    planCreditsPerMonth: 10_000,
    planPriceMinorUnits: 2999,
    planCurrency: 'usd',
  });
}

async function giveLegacySubscription(
  userId: string,
  values: { plan: 'basic' | 'pro' | 'business'; status: 'active' | 'canceled' | 'expired'; endDate: Date },
): Promise<void> {
  await getDb().insert(subscriptions).values({
    userId,
    plan: values.plan,
    status: values.status,
    startDate: new Date(Date.now() - 30 * DAY_MS),
    endDate: values.endDate,
  });
}

describe('resolveUserSubscriptionPlan', () => {
  it('returns pro when billing has an active Pro plan', async () => {
    const userId = await account();
    await giveBillingSubscription(userId, { planName: 'Pro', status: 'active' });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('pro');
  });

  it('counts a trialing billing subscription as live', async () => {
    const userId = await account();
    await giveBillingSubscription(userId, { planName: 'Business', status: 'trialing' });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('business');
  });

  it('ignores a canceled billing subscription', async () => {
    const userId = await account();
    await giveBillingSubscription(userId, { planName: 'Pro', status: 'canceled' });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('basic');
  });

  it('falls back to the legacy table when billing has no live row', async () => {
    const userId = await account();
    await giveLegacySubscription(userId, {
      plan: 'business',
      status: 'active',
      endDate: new Date(Date.now() + 30 * DAY_MS),
    });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('business');
  });

  it('returns basic when neither table has a premium plan', async () => {
    const userId = await account();

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('basic');
  });

  /**
   * The guarantee the removed TTL index used to provide by DELETING the row, now
   * provided by the read itself. Without `end_date > now()` in the query, a
   * lapsed row still marked `active` keeps granting premium forever — and it now
   * survives forever, because nothing deletes it.
   */
  it('does NOT grant premium for a lapsed legacy subscription still marked active', async () => {
    const userId = await account();
    await giveLegacySubscription(userId, {
      plan: 'pro',
      status: 'active',
      endDate: new Date(Date.now() - DAY_MS),
    });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('basic');

    // And the row is still there — the entitlement lapsed, the record did not.
    const [row] = await getDb()
      .select({ plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    expect(row.plan).toBe('pro');
  });

  it('does not grant premium from a canceled legacy subscription', async () => {
    const userId = await account();
    await giveLegacySubscription(userId, {
      plan: 'pro',
      status: 'canceled',
      endDate: new Date(Date.now() + 30 * DAY_MS),
    });

    await expect(resolveUserSubscriptionPlan(userId)).resolves.toBe('basic');
  });
});

describe('isPremiumSubscriptionPlan', () => {
  it('treats pro and business as premium', () => {
    expect(isPremiumSubscriptionPlan('pro')).toBe(true);
    expect(isPremiumSubscriptionPlan('business')).toBe(true);
    expect(isPremiumSubscriptionPlan('basic')).toBe(false);
  });
});
