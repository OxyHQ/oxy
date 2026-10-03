/**
 * Subscription read/cancel — against a REAL Postgres.
 *
 * The Mongoose model mocks this suite used to carry could only assert the query
 * SHAPE. Two guarantees here are about stored state rather than call arguments —
 * that cancelling leaves the account's analytics-sharing preference EXACTLY as
 * the person set it (issue #1524), and that it CANCELS the legacy row
 * rather than deleting it — so they are asserted against real rows.
 *
 * Only Stripe is stubbed: it is a third-party network call.
 */

const mockStripeSubscriptionsUpdate = jest.fn();

jest.mock('../../utils/stripeClient', () => ({
  getStripe: () => ({
    subscriptions: {
      update: (...args: unknown[]) => mockStripeSubscriptionsUpdate(...args),
    },
  }),
}));

import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
import { subscriptions } from '../../db/schema/subscriptions';
import { users } from '../../db/schema/users';
import type { AuthRequest } from '../../middleware/auth';
import { cancelSubscription, getSubscription } from '../subscription.controller';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStripeSubscriptionsUpdate.mockResolvedValue({});
});

/** The whole run shares one database, so every test mints its own account. */
async function account(): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return user.id;
}

async function analyticsSharing(userId: string): Promise<boolean> {
  const [user] = await getDb()
    .select({ analyticsSharing: users.privacyAnalyticsSharing })
    .from(users)
    .where(eq(users.id, userId));
  return user.analyticsSharing;
}

function requestFor(userId: string): AuthRequest {
  return {
    params: { userId },
    user: { _id: { toString: () => userId } },
  } as unknown as AuthRequest;
}

function responseSpy() {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  return { json, status, res: { json, status } as unknown as Response };
}

async function giveBillingSubscription(userId: string): Promise<void> {
  await getDb().insert(billingSubscriptions).values({
    userId,
    stripeCustomerId: `cus_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    stripePriceId: 'price_test',
    status: 'active',
    currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    planName: 'pro',
    planCreditsPerMonth: 10_000,
    planPriceMinorUnits: 2999,
    planCurrency: 'usd',
  });
}

async function giveLegacySubscription(userId: string): Promise<void> {
  await getDb().insert(subscriptions).values({
    userId,
    plan: 'pro',
    status: 'active',
    startDate: new Date(Date.now() - 30 * DAY_MS),
    endDate: new Date(Date.now() + 30 * DAY_MS),
  });
}

describe('getSubscription', () => {
  it('returns the billing subscription when Stripe billing is active', async () => {
    const userId = await account();
    await giveBillingSubscription(userId);

    const { json, res } = responseSpy();
    await getSubscription(requestFor(userId), res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      plan: 'pro',
      status: 'active',
      userId,
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-02-01T00:00:00.000Z',
    }));
  });

  it('returns the basic fallback when the account has no subscription at all', async () => {
    const userId = await account();

    const { json, res } = responseSpy();
    await getSubscription(requestFor(userId), res);

    expect(json).toHaveBeenCalledWith({ plan: 'basic' });
  });
});

describe('cancelSubscription', () => {
  it('cancels an active Stripe billing subscription at period end', async () => {
    const userId = await account();
    await giveBillingSubscription(userId);

    const { json, res } = responseSpy();
    await cancelSubscription(requestFor(userId), res);

    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(`sub_${userId}`, {
      cancel_at_period_end: true,
    });

    // Stripe accepted it, so the local mirror must agree.
    const [row] = await getDb()
      .select({ cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId));
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(await analyticsSharing(userId)).toBe(true);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      plan: 'pro',
      status: 'active',
      autoRenew: false,
    }));
  });

  it.each([true, false])(
    'leaves analytics sharing at %s when a plan is cancelled',
    async (preference) => {
      const userId = await account();
      await getDb()
        .update(users)
        .set({ privacyAnalyticsSharing: preference })
        .where(eq(users.id, userId));
      await giveBillingSubscription(userId);
      await giveLegacySubscription(userId);

      const { res } = responseSpy();
      await cancelSubscription(requestFor(userId), res);

      // A commercial act. The privacy choice is the person's, and neither turns
      // off nor — the worse failure — turns on because a plan ended.
      expect(await analyticsSharing(userId)).toBe(preference);
    }
  );

  it('cancels a legacy-only subscription and keeps it as a record', async () => {
    const userId = await account();
    await giveLegacySubscription(userId);

    const { json, res } = responseSpy();
    await cancelSubscription(requestFor(userId), res);

    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();

    // CANCELED, never deleted — the record of what was bought survives, which is
    // the whole reason the TTL index on this table was removed.
    const [row] = await getDb()
      .select({ status: subscriptions.status, plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    expect(row).toEqual({ status: 'canceled', plan: 'pro' });

    expect(await analyticsSharing(userId)).toBe(true);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      plan: 'pro',
      status: 'canceled',
    }));
  });

  it('returns 404 when no billing or legacy subscription exists', async () => {
    const userId = await account();

    const { json, status, res } = responseSpy();
    await cancelSubscription(requestFor(userId), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ message: 'Subscription not found' });
  });
});

it("legacy cancellation changes only its own source when a billing plan is present", async () => {
	const userId = await account();
	await giveBillingSubscription(userId);
	await giveLegacySubscription(userId);
	const { res } = responseSpy();
	await cancelSubscription(requestFor(userId), res);
	const [legacy] = await getDb()
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.userId, userId));
	expect(legacy.status).toBe("active");
	expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledTimes(1);
});
