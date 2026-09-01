import type { billingSubscriptions } from '../db/schema/billingSubscriptions';
import type { subscriptions } from '../db/schema/subscriptions';
import type { SubscriptionPlanTier } from './subscriptionPlan';

/** The six entitlement booleans, reassembled into the object the wire promises. */
export interface SubscriptionFeatures {
  analytics: boolean;
  premiumBadge: boolean;
  unlimitedFollowing: boolean;
  higherUploadLimits: boolean;
  promotedPosts: boolean;
  businessTools: boolean;
}

export interface SubscriptionResponse {
  plan: SubscriptionPlanTier;
  status?: 'active' | 'canceled' | 'expired';
  userId?: string;
  startDate?: string;
  endDate?: string;
  autoRenew?: boolean;
  paymentMethod?: string;
  latestInvoice?: string;
  features?: SubscriptionFeatures;
  createdAt?: string;
  updatedAt?: string;
}

/** The billing columns this serializer reads. */
export type BillingSubscriptionSource = Pick<
  typeof billingSubscriptions.$inferSelect,
  | 'planName'
  | 'status'
  | 'userId'
  | 'currentPeriodStart'
  | 'currentPeriodEnd'
  | 'cancelAtPeriodEnd'
  | 'createdAt'
  | 'updatedAt'
>;

/** The legacy row, whole — every column of it reaches the wire. */
export type LegacySubscriptionSource = typeof subscriptions.$inferSelect;

function normalizePlanName(planName: string | undefined | null): SubscriptionPlanTier {
  const normalized = planName?.trim().toLowerCase();
  if (normalized === 'pro') return 'pro';
  if (normalized === 'business') return 'business';
  return 'basic';
}

function mapBillingStatus(
  status: BillingSubscriptionSource['status'],
): SubscriptionResponse['status'] {
  if (status === 'canceled') return 'canceled';
  if (status === 'active' || status === 'trialing') return 'active';
  return 'active';
}

/**
 * The legacy row's status, with expiry DERIVED rather than trusted.
 *
 * `subscriptions` used to carry a Mongo TTL index on `endDate` that DELETED the
 * row when the period closed — so a lapsed subscription simply vanished from
 * this response and the caller fell through to `{ plan: 'basic' }`. That index
 * was a data-loss bug (it destroyed the record of what was bought) and is gone.
 *
 * Its removal leaves an obligation HERE: the row now survives its own deadline,
 * so a reader that trusted the stored `status` would report `active` for a
 * subscription that ended months ago. `expired` is exactly the projection the
 * schema defines — `status <> 'canceled' and end_date <= now()` — and computing
 * it at read time means this response is correct whether or not the projection
 * job has run.
 *
 * `plan` is deliberately left as STORED. It answers "what did they buy", the
 * client's own gate is `plan !== 'basic' && status === 'active'`, and the
 * authoritative premium gate is `resolveUserSubscriptionPlan`, which filters
 * expiry in SQL.
 */
function deriveLegacyStatus(
  legacy: Pick<LegacySubscriptionSource, 'status' | 'endDate'>,
  now: Date,
): SubscriptionResponse['status'] {
  if (legacy.status === 'canceled') return 'canceled';
  return legacy.endDate.getTime() <= now.getTime() ? 'expired' : legacy.status;
}

function toFeatures(legacy: LegacySubscriptionSource): SubscriptionFeatures {
  return {
    analytics: legacy.featureAnalytics,
    premiumBadge: legacy.featurePremiumBadge,
    unlimitedFollowing: legacy.featureUnlimitedFollowing,
    higherUploadLimits: legacy.featureHigherUploadLimits,
    promotedPosts: legacy.featurePromotedPosts,
    businessTools: legacy.featureBusinessTools,
  };
}

/** Mongoose omitted an unset optional field; a nullable column reads back `null`. */
function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

/**
 * Normalize billing + legacy subscription rows into the legacy
 * `GET /subscription/:userId` response shape consumed by Accounts.
 *
 * Stripe writes to `billing_subscriptions`; the legacy `subscriptions` table may
 * still hold rows from before the billing cutover. Billing wins.
 *
 * @param now Injected so the expiry derivation is testable without clock
 *   manipulation. Defaults to the real clock.
 */
export function formatSubscriptionResponse(
  billing: BillingSubscriptionSource | null,
  legacy: LegacySubscriptionSource | null,
  now: Date = new Date(),
): SubscriptionResponse {
  if (billing) {
    return {
      plan: normalizePlanName(billing.planName),
      status: mapBillingStatus(billing.status),
      userId: billing.userId,
      startDate: billing.currentPeriodStart.toISOString(),
      endDate: billing.currentPeriodEnd.toISOString(),
      autoRenew: !billing.cancelAtPeriodEnd,
      createdAt: billing.createdAt.toISOString(),
      updatedAt: billing.updatedAt.toISOString(),
    };
  }

  if (legacy) {
    return {
      plan: normalizePlanName(legacy.plan),
      status: deriveLegacyStatus(legacy, now),
      userId: legacy.userId,
      startDate: legacy.startDate.toISOString(),
      endDate: legacy.endDate.toISOString(),
      autoRenew: legacy.autoRenew,
      paymentMethod: optional(legacy.paymentMethod),
      latestInvoice: optional(legacy.latestInvoice),
      features: toFeatures(legacy),
      createdAt: legacy.createdAt.toISOString(),
      updatedAt: legacy.updatedAt.toISOString(),
    };
  }

  return { plan: 'basic' };
}
