import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Response } from 'express';
import { getDb } from '../config/postgres';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import { subscriptions } from '../db/schema/subscriptions';
import type { AuthRequest } from '../middleware/auth';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';
import { getBillingStripe } from '../utils/billingStripe';
import { formatSubscriptionResponse } from '../utils/subscriptionResponse';

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
    const [billingRows, [legacySubscription]] = await Promise.all([
      db
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.userId, userId),
            inArray(billingSubscriptions.status, LIVE_BILLING_STATUSES)
          ,
					)
        ,
				)
        .limit(2),
      db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),
    ]);

    if (billingRows.length > 1)
			return res
				.status(409)
				.json({
					message: "Multiple subscriptions require the named plural view",
				});
		const [billingSubscription] = billingRows;
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
    const billingRows = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          inArray(billingSubscriptions.status, LIVE_BILLING_STATUSES)
        ,
				)
      ,
			)
      .limit(2);
		if (billingRows.length > 1)return res
				.status(409)
				.json({ message: "Multiple subscriptions require named cancellation" });
		const [billingSubscription] = billingRows;

    let cancelledBilling = billingSubscription ?? null;
    if (billingSubscription) {
      await (await getBillingStripe()).subscriptions.update(billingSubscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      },
			);
      const [updated] = await db
        .update(billingSubscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(billingSubscriptions.id, billingSubscription.id))
        .returning();
      cancelledBilling = updated;
    }

    // The legacy row is CANCELED, never deleted — the record of what was bought
    // survives its own cancellation, same reason the TTL index was removed.
    const [legacySubscription] = billingSubscription
			? []
			: await db
      .update(subscriptions)
      .set({ status: "canceled" })
      .where(and(eq(subscriptions.userId, userId), ne(subscriptions.status, "canceled"),
						),
					)
      .returning();

    if (!cancelledBilling && !legacySubscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    // Cancelling a plan is a COMMERCIAL act and changes nothing about the
    // account's privacy choices. This used to force `privacyAnalyticsSharing`
    // off as a side effect — a preference the person never touched, flipped by
    // a billing action. The preference changes only through its own setting.

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
