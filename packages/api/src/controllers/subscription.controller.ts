import type { Response } from 'express';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AuthRequest } from '../middleware/auth';
import { getDb } from '../config/postgres';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import { subscriptions } from '../db/schema/subscriptions';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import userCache from '../utils/userCache';
import { formatSubscriptionResponse } from '../utils/subscriptionResponse';
import { getStripe } from '../utils/stripeClient';

/** The billing statuses that count as a live subscription. */
const LIVE_BILLING_STATUSES = ['active', 'trialing'] as const;

function assertOwnership(req: AuthRequest, userId: string): void {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  if (req.user._id.toString() !== userId) {
    throw new ForbiddenError('You do not have permission to access this subscription');
  }
}

export const getSubscription = async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;
    assertOwnership(req, userId);

    const db = getDb();
    const [[billingSubscription], [legacySubscription]] = await Promise.all([
      db
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.userId, userId),
            inArray(billingSubscriptions.status, LIVE_BILLING_STATUSES)
          )
        )
        .limit(1),
      db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),
    ]);

    res.json(
      formatSubscriptionResponse(billingSubscription ?? null, legacySubscription ?? null)
    );
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
      throw error;
    }
    logger.error('Error fetching subscription:', error);
    res.status(500).json({
      message: 'Error fetching subscription',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export const cancelSubscription = async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;
    assertOwnership(req, userId);

    const db = getDb();
    const [billingSubscription] = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          inArray(billingSubscriptions.status, LIVE_BILLING_STATUSES)
        )
      )
      .limit(1);

    let cancelledBilling = billingSubscription ?? null;
    if (billingSubscription) {
      await getStripe().subscriptions.update(billingSubscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      const [updated] = await db
        .update(billingSubscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(billingSubscriptions.id, billingSubscription.id))
        .returning();
      cancelledBilling = updated;
    }

    // The legacy row is CANCELED, never deleted — the record of what was bought
    // survives its own cancellation, same reason the TTL index was removed.
    const [legacySubscription] = await db
      .update(subscriptions)
      .set({ status: 'canceled' })
      .where(and(eq(subscriptions.userId, userId), ne(subscriptions.status, 'canceled')))
      .returning();

    if (!cancelledBilling && !legacySubscription) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    await db
      .update(users)
      .set({ privacyAnalyticsSharing: false })
      .where(eq(users.id, userId));
    userCache.invalidate(userId);

    res.json(
      formatSubscriptionResponse(cancelledBilling, legacySubscription ?? null)
    );
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
      throw error;
    }
    logger.error('Error canceling subscription:', error);
    res.status(500).json({
      message: 'Error canceling subscription',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
