import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import { subscriptions } from '../db/schema/subscriptions';

export type SubscriptionPlanTier = 'basic' | 'pro' | 'business';

const PREMIUM_PLANS: ReadonlySet<SubscriptionPlanTier> = new Set(['pro', 'business']);

/** The billing statuses that count as a live subscription. */
const LIVE_BILLING_STATUSES = ['active', 'trialing'] as const;

/** The legacy plans that grant premium. */
const LEGACY_PREMIUM_PLANS = ['pro', 'business'] as const;

function normalizePlanName(planName: string | undefined | null): SubscriptionPlanTier {
  const normalized = planName?.trim().toLowerCase();
  if (normalized === 'pro') return 'pro';
  if (normalized === 'business') return 'business';
  return 'basic';
}

/**
 * Resolve the user's effective subscription plan tier.
 *
 * Stripe writes to `billing_subscriptions`; the legacy `subscriptions` table may
 * still hold rows from before the billing cutover. Check billing first, then fall
 * back to legacy so premium gates stay accurate for paying subscribers.
 *
 * ## The legacy read filters expiry ITSELF
 *
 * `subscriptions` used to carry a Mongo TTL index on `endDate`, which DELETED
 * the row when the period closed — destroying the record of what was bought.
 * That index is gone and nothing replaces it with a delete; expiry is DERIVED
 * instead, from `end_date` against now.
 *
 * So this query adds `end_date > now()` on top of the status filter, which is
 * class (A) in `db/expiry.ts`'s taxonomy: the entitlement is correct whether or
 * not the projection job has run. A read that trusted `status = 'active'` alone
 * would keep granting premium to a lapsed subscriber for as long as the job was
 * behind — and Mongo's TTL monitor had exactly that lag, up to ~60s, so this is
 * not even a regression the old index protected against.
 */
export async function resolveUserSubscriptionPlan(
  userId: string,
): Promise<SubscriptionPlanTier> {
  const db = getDb();

  const [billingSubscription] = await db
    .select({ planName: billingSubscriptions.planName })
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, userId),
        inArray(billingSubscriptions.status, LIVE_BILLING_STATUSES)
      )
    )
    .limit(1);

  if (billingSubscription?.planName) {
    return normalizePlanName(billingSubscription.planName);
  }

  const [legacySubscription] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, 'active'),
        inArray(subscriptions.plan, LEGACY_PREMIUM_PLANS),
        gt(subscriptions.endDate, sql`now()`)
      )
    )
    .limit(1);

  if (legacySubscription?.plan) {
    return normalizePlanName(legacySubscription.plan);
  }

  return 'basic';
}

/** Whether the plan tier unlocks premium-only profile features (e.g. oxy color). */
export function isPremiumSubscriptionPlan(plan: SubscriptionPlanTier): boolean {
  return PREMIUM_PLANS.has(plan);
}
