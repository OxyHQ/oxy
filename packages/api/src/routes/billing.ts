import { Router, type Request, type Response } from 'express';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getStripe } from '../utils/stripeClient';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { getDb } from '../config/postgres';
import { addCredits } from '../db/credits';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import {
  billingTransactions,
  creditPurchaseIdempotencyPredicate,
  subscriptionPeriodIdempotencyPredicate,
} from '../db/schema/billingTransactions';
import { userCredits } from '../db/schema/userCredits';
import { getOrCreateUserCredits } from './credits';
import {
  getOrCreateAccountStripeCustomer,
  handleBalanceTopUpCompleted,
  handleBalanceTopUpPaymentIntent,
  BALANCE_TOP_UP_METADATA_TYPE,
} from '../services/stripeAccountBilling.service';
import {
  type BillingSubscriptionResponse,
  type BillingTransactionResponse,
  toBillingSubscriptionResponse,
  toBillingTransactionResponse,
} from '../utils/billingResponse';
import { logger } from '../utils/logger';
import { isAllowedRedirect } from '../utils/redirectAllowlist';
import { validate } from '../middleware/validate';
import {
  checkoutCreditsSchema,
  checkoutSubscriptionSchema,
  portalSchema,
  transactionsQuerySchema,
} from '../schemas/billing.schemas';

/** The statuses that count as "the user has a live subscription right now". */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

/**
 * How close to a period boundary a `customer.subscription.updated` event must
 * land to be read as a RENEWAL rather than an ordinary edit. Carried across from
 * the Mongo original unchanged; the idempotency index is what actually stops a
 * double grant, this only decides whether to attempt one at all.
 */
const RENEWAL_GRANT_WINDOW_SECONDS = 300;

const INVALID_REDIRECT_RESPONSE = {
  error: 'INVALID_REDIRECT_URL',
  message: 'successUrl/cancelUrl must be on an allowed domain',
} as const;

const INVALID_RETURN_URL_RESPONSE = {
  error: 'INVALID_REDIRECT_URL',
  message: 'returnUrl must be on an allowed domain',
} as const;

const router = Router();

function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required but not configured');
  }
  return secret;
}

/*
 * The Stripe-customer resolver that used to live here is now
 * `getOrCreateAccountStripeCustomer` in `services/stripeAccountBilling.service.ts`
 * (issue #972 section 7.4), and the three call sites below import it directly.
 *
 * `users` IS the account table, so "the Stripe customer for this user" and "the
 * Stripe customer for this account" were always one question. Two resolvers
 * would eventually differ on the "Stripe forgot this customer" branch, and the
 * account that lost its customer id is the account whose payments stop
 * reconciling.
 */

const CREDIT_PACKAGES = [
  { id: 'credits_1000', name: '1,000 Credits', credits: 1000, price: 500, currency: 'usd' },
  { id: 'credits_5000', name: '5,000 Credits', credits: 5000, price: 2000, currency: 'usd' },
  { id: 'credits_10000', name: '10,000 Credits', credits: 10000, price: 3500, currency: 'usd' },
  { id: 'credits_50000', name: '50,000 Credits', credits: 50000, price: 15000, currency: 'usd' },
];

const SUBSCRIPTION_PLANS = [
  { id: 'pro_monthly', name: 'Pro', creditsPerMonth: 10000, price: 2999, stripePriceId: process.env.STRIPE_PRO_PRICE_ID || '', currency: 'usd' },
  { id: 'business_monthly', name: 'Business', creditsPerMonth: 50000, price: 9999, stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID || '', currency: 'usd' },
];

/**
 * List one-time credit packages available for purchase.
 * Public endpoint, no auth needed.
 */
router.get('/packages', async (_req: Request, res: Response) => {
  res.json({ packages: CREDIT_PACKAGES });
});

/**
 * List subscription plans (free, pro, business).
 * Public endpoint, no auth needed.
 */
router.get('/plans', async (_req: Request, res: Response) => {
  res.json({ plans: SUBSCRIPTION_PLANS });
});

/**
 * Create a Stripe checkout session for a one-time credit purchase. Returns
 * a session ID and a hosted-page URL to redirect the user to.
 */
router.post('/checkout/credits', authMiddleware, validate({ body: checkoutCreditsSchema }), async (req: AuthRequest, res: Response) => {
  try {
    const { packageId, successUrl, cancelUrl } = req.body;
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    if (!isAllowedRedirect(successUrl) || !isAllowedRedirect(cancelUrl)) {
      logger.warn('Rejected checkout/credits request with disallowed redirect URL', {
        userId,
        successUrl,
        cancelUrl,
      });
      return res.status(400).json(INVALID_REDIRECT_RESPONSE);
    }

    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid package ID' });

    const email = req.user?.email;
    const customerId = await getOrCreateAccountStripeCustomer(userId, email);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: pkg.currency,
          product_data: { name: pkg.name, description: `${pkg.credits.toLocaleString()} API credits` },
          unit_amount: pkg.price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: pkg.id, credits: pkg.credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    logger.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * Create a Stripe checkout session for a subscription plan. Returns the
 * checkout URL.
 */
router.post('/checkout/subscription', authMiddleware, validate({ body: checkoutSubscriptionSchema }), async (req: AuthRequest, res: Response) => {
  try {
    const { planId, successUrl, cancelUrl } = req.body;
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    if (!isAllowedRedirect(successUrl) || !isAllowedRedirect(cancelUrl)) {
      logger.warn('Rejected checkout/subscription request with disallowed redirect URL', {
        userId,
        successUrl,
        cancelUrl,
      });
      return res.status(400).json(INVALID_REDIRECT_RESPONSE);
    }

    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan || !plan.stripePriceId) return res.status(400).json({ error: 'Invalid plan ID' });

    const email = req.user?.email;
    const customerId = await getOrCreateAccountStripeCustomer(userId, email);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, planId: plan.id },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    logger.error('Error creating subscription checkout:', error);
    res.status(500).json({ error: 'Failed to create subscription checkout' });
  }
});

/**
 * Get the user's current active subscription (or `null`).
 */
router.get('/subscription', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const [row] = await getDb()
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          inArray(billingSubscriptions.status, LIVE_SUBSCRIPTION_STATUSES)
        )
      )
      .limit(1);

    // `null`, not `undefined`: the Mongoose `findOne` returned null and
    // `res.json` emitted `"subscription": null`. Dropping the key entirely is a
    // different shape.
    const subscription: BillingSubscriptionResponse | null = row
      ? toBillingSubscriptionResponse(row)
      : null;

    res.json({ subscription });
  } catch (error) {
    logger.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

/**
 * Cancel the user's current subscription at the end of the billing
 * period. Sets `cancel_at_period_end=true` on the Stripe subscription so
 * the user keeps access until the period closes.
 */
router.post('/subscription/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const db = getDb();
    const [subscription] = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          inArray(billingSubscriptions.status, LIVE_SUBSCRIPTION_STATUSES)
        )
      )
      .limit(1);

    if (!subscription) return res.status(404).json({ error: 'No active subscription found' });

    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Stripe is the authority and has accepted the change; mirror it locally and
    // answer with the row as it now stands, not with the pre-update copy.
    const [updated] = await db
      .update(billingSubscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(billingSubscriptions.id, subscription.id))
      .returning();

    res.json({
      message: 'Subscription will be canceled at end of billing period',
      subscription: toBillingSubscriptionResponse(updated),
    });
  } catch (error) {
    logger.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * Paginated list of the user's billing transactions (one-time purchases
 * and subscription invoices). Default limit 20, max 100.
 */
router.get('/transactions', authMiddleware, validate({ query: transactionsQuerySchema }), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const db = getDb();
    const [rows, [totals]] = await Promise.all([
      db
        .select()
        .from(billingTransactions)
        .where(eq(billingTransactions.userId, userId))
        .orderBy(desc(billingTransactions.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(billingTransactions)
        .where(eq(billingTransactions.userId, userId)),
    ]);

    const transactions: BillingTransactionResponse[] = rows.map(toBillingTransactionResponse);

    res.json({ transactions, total: totals.value });
  } catch (error) {
    logger.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

/**
 * Open a Stripe customer portal session. Returns the portal URL — redirect
 * the user there to manage payment methods, view invoices, or change their
 * subscription.
 */
router.post('/portal', authMiddleware, validate({ body: portalSchema }), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { returnUrl } = req.body;

    if (!isAllowedRedirect(returnUrl)) {
      logger.warn('Rejected portal request with disallowed return URL', { userId, returnUrl });
      return res.status(400).json(INVALID_RETURN_URL_RESPONSE);
    }

    const email = req.user?.email;
    const customerId = await getOrCreateAccountStripeCustomer(userId, email);

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    logger.error('Error creating portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

/**
 * Stripe webhook receiver. Verifies the `stripe-signature` header against
 * `STRIPE_WEBHOOK_SECRET` and dispatches handled events (subscription
 * created/updated, invoice paid, checkout completed, etc.). No auth.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature' });

  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error('STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Webhook verification failed:', message);
    return res.status(400).json({ error: `Webhook Error: ${message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'payment_intent.succeeded': {
        // The off-session auto-recharge path creates a PaymentIntent directly,
        // so no checkout session ever completes for it. A hosted checkout emits
        // BOTH events; both handlers compose the same idempotency key from the
        // same intent id, so the second one writes nothing.
        const result = await handleBalanceTopUpPaymentIntent(
          event.data.object as Stripe.PaymentIntent
        );
        if (result.status === 'ignored' && result.reason !== 'not-a-balance-top-up') {
          logger.warn('Balance top-up intent ignored', {
            paymentIntentId: (event.data.object as Stripe.PaymentIntent).id,
            reason: result.reason,
          });
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (error) {
    logger.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

/**
 * Grant a one-off credit purchase, EXACTLY ONCE per Stripe charge.
 *
 * Stripe retries `checkout.session.completed` by design — on its own timer, and
 * again whenever a delivery is not acknowledged — and this handler previously
 * had no idempotency guard of any kind: every replay ran `addCredits` again and
 * wrote a second receipt. The account ended up with two, three, N times the
 * credits it paid for, and the only trace was a duplicate row nothing looked at.
 *
 * The fix has two halves, and neither is sufficient alone:
 *
 *   1. **`billing_transactions_payment_intent_key`** — a partial unique index on
 *      `(stripe_payment_intent_id, type)` for `credit_purchase` rows. This is
 *      what makes the claim ATOMIC. A guard written only in JavaScript would be a
 *      read-then-write: two concurrent replays would both find nothing and both
 *      grant, which is precisely the shape Stripe's retry behaviour produces.
 *   2. **The receipt is written FIRST and the grant is conditional on it.**
 *      `onConflictDoNothing().returning()` yields a row only for the caller that
 *      won the index; a replay gets nothing back and returns without granting.
 *      Same shape `handleSubscriptionUpdate` already uses for renewals.
 *
 * Both live inside ONE transaction, so a crash between the claim and the grant
 * cannot leave a receipt with no credits behind it — which would be worse than
 * the bug, since the receipt would then permanently suppress the retry that
 * would have delivered them.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;

  // TWO products complete through this one webhook, and they must never be
  // reachable from one another. `credit_purchase` buys API CREDITS — whole,
  // indivisible counts of a prepaid entitlement. `balance_top_up` funds the
  // account's pay-as-you-go INFERENCE balance, an exact decimal amount in a
  // currency. ADR 0009 and ADR 0014 both turn on keeping the two apart; a
  // top-up that granted credits, or a credit purchase that funded the balance,
  // would merge them in the one place a customer's money actually moves.
  if (metadata?.type === BALANCE_TOP_UP_METADATA_TYPE) {
    const result = await handleBalanceTopUpCompleted(session);
    if (result.status === 'ignored') {
      logger.warn('Balance top-up webhook ignored', {
        sessionId: session.id,
        reason: result.reason,
      });
    }
    return;
  }

  if (!metadata?.userId || metadata.type !== 'credit_purchase') return;

  // Re-validate credits against known packages to prevent metadata manipulation
  const pkg = CREDIT_PACKAGES.find((p) => p.id === metadata.packageId);
  if (!pkg) {
    logger.warn('Webhook checkout: unrecognized packageId in metadata', { packageId: metadata.packageId, sessionId: session.id });
    return;
  }

  const metadataCredits = Number.parseInt(metadata.credits || '0');
  if (metadataCredits !== pkg.credits) {
    logger.warn('Webhook checkout: credits mismatch between metadata and package', {
      metadataCredits,
      packageCredits: pkg.credits,
      packageId: metadata.packageId,
      sessionId: session.id,
    });
    return;
  }

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  if (!paymentIntentId) {
    // No payment intent means no idempotency key, and granting without one is
    // how the original bug paid out twice. Refuse rather than grant unguarded.
    logger.warn('Webhook checkout: no payment intent on the session; refusing to grant credits', {
      sessionId: session.id,
      userId: metadata.userId,
    });
    return;
  }

  const credits = pkg.credits;
  const userId = metadata.userId;
  const db = getDb();

  await db.transaction(async (tx) => {
    await getOrCreateUserCredits(tx, userId);

    const [receipt] = await tx
      .insert(billingTransactions)
      .values({
        userId,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
        stripePaymentIntentId: paymentIntentId,
        type: 'credit_purchase',
        amountMinorUnits: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
        credits,
        status: 'completed',
        description: `Purchased ${credits.toLocaleString()} credits`,
      })
      .onConflictDoNothing({
        target: [billingTransactions.stripePaymentIntentId, billingTransactions.type],
        // The index's own predicate, so Postgres can infer WHICH partial unique
        // index this conflict is against. Shared with the index declaration —
        // see `creditPurchaseIdempotencyPredicate`.
        where: creditPurchaseIdempotencyPredicate(billingTransactions),
      })
      .returning({ id: billingTransactions.id });

    if (!receipt) {
      logger.info('Skipping duplicate credit purchase grant', {
        paymentIntentId,
        sessionId: session.id,
        userId,
      });
      return;
    }

    // The receipt is now the idempotency CLAIM: while it stands, every replay is
    // refused. So a grant that silently failed here would suppress its own
    // retries forever — the customer pays and never receives the credits. Throw
    // instead: the transaction rolls back, the claim is released, and Stripe's
    // next redelivery tries again.
    if (!(await addCredits(tx, userId, credits, 'paid'))) {
      throw new Error(
        `Credit grant did not apply for user ${userId} (payment intent ${paymentIntentId})`
      );
    }
    logger.info(`Added ${credits} credits to user ${userId}`);
  });
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;
  const db = getDb();

  // `user_credits.stripe_customer_id` carries a partial UNIQUE index, so this
  // resolves at most one account — the uniqueness the Mongoose `findOne` assumed
  // without stating.
  const [account] = await db
    .select({ userId: userCredits.userId })
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, customerId))
    .limit(1);
  if (!account) return;

  const subscriptionItem = stripeSubscription.items.data[0];
  const priceId = subscriptionItem.price.id;
  const plan = SUBSCRIPTION_PLANS.find((p) => p.stripePriceId === priceId);
  if (!plan) {
    logger.warn('Unrecognized subscription price ID', {
      priceId,
      subscriptionId: stripeSubscription.id,
      customerId,
    });
    return;
  }

  // The Mongo upsert keyed on `stripeSubscriptionId`, which is the table's
  // unique key here too — so it is one statement, not a read-then-write.
  const mirror = {
    userId: account.userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSubscription.id,
    stripePriceId: priceId,
    status: stripeSubscription.status,
    currentPeriodStart: new Date(subscriptionItem.current_period_start * 1000),
    currentPeriodEnd: new Date(subscriptionItem.current_period_end * 1000),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
    planName: plan.name,
    planCreditsPerMonth: plan.creditsPerMonth,
    planPriceMinorUnits: plan.price,
    planCurrency: plan.currency,
  };
  await db
    .insert(billingSubscriptions)
    .values(mirror)
    .onConflictDoUpdate({
      target: billingSubscriptions.stripeSubscriptionId,
      set: mirror,
    });

  // Add credits on subscription renewal
  if (stripeSubscription.status !== 'active') return;
  const now = Date.now() / 1000;
  if (Math.abs(now - subscriptionItem.current_period_start) >= RENEWAL_GRANT_WINDOW_SECONDS) return;

  const periodStart = new Date(subscriptionItem.current_period_start * 1000);
  await db.transaction(async (tx) => {
    // Same shape as `handleCheckoutCompleted`: the receipt is the idempotency
    // claim, `billing_transactions_subscription_period_key` makes winning it
    // atomic, and the grant is conditional on having won.
    const [receipt] = await tx
      .insert(billingTransactions)
      .values({
        userId: account.userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: stripeSubscription.id,
        stripeSubscriptionPeriodStart: periodStart,
        type: 'subscription_payment',
        amountMinorUnits: plan.price,
        currency: plan.currency,
        credits: plan.creditsPerMonth,
        status: 'completed',
        description: `${plan.name} subscription credits`,
      })
      .onConflictDoNothing({
        // Named rather than left bare: an untargeted DO NOTHING would silently
        // swallow a violation of ANY constraint this table grows later, and a
        // swallowed constraint on a money table is a grant that vanishes without
        // a trace. Shared with the index declaration — see
        // `subscriptionPeriodIdempotencyPredicate`.
        target: [
          billingTransactions.stripeSubscriptionId,
          billingTransactions.stripeSubscriptionPeriodStart,
          billingTransactions.type,
        ],
        where: subscriptionPeriodIdempotencyPredicate(billingTransactions),
      })
      .returning({ id: billingTransactions.id });

    if (!receipt) {
      logger.info('Skipping duplicate subscription credit grant', {
        subscriptionId: stripeSubscription.id,
        periodStart: periodStart.toISOString(),
        userId: account.userId,
      });
      return;
    }

    // Same reasoning as the one-off path: the receipt suppresses every replay,
    // so a silently-failed grant would never be retried.
    if (!(await addCredits(tx, account.userId, plan.creditsPerMonth, 'paid'))) {
      throw new Error(
        `Renewal credit grant did not apply for user ${account.userId} ` +
        `(subscription ${stripeSubscription.id})`
      );
    }
  });
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  await getDb()
    .update(billingSubscriptions)
    .set({ status: 'canceled' })
    .where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscription.id));
}

export default router;
