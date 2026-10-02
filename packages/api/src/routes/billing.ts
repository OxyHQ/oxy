import { Router, type Request, type Response } from 'express';
import { and, count, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
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
  type StripeEventResult,
  recordStripeEventOutcome,
  recordStripeEventReceived,
} from '../services/stripeWebhookEvents.service';
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

const INVALID_REDIRECT_RESPONSE = {
  error: 'INVALID_REDIRECT_URL',
  message: 'successUrl/cancelUrl must be on an allowed domain',
} as const;

const INVALID_RETURN_URL_RESPONSE = {
  error: 'INVALID_REDIRECT_URL',
  message: 'returnUrl must be on an allowed domain',
} as const;

const INVALID_IDEMPOTENCY_KEY_RESPONSE = {
  error: 'INVALID_IDEMPOTENCY_KEY',
  message: 'Idempotency-Key must be 1-150 visible ASCII characters',
} as const;

const IDEMPOTENCY_KEY_REUSED_RESPONSE = {
  error: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used with different parameters',
} as const;

/**
 * Visible ASCII, bounded so the scoped key below stays inside Stripe's 255-char
 * limit with a 36-char account id in it.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,150}$/;

/**
 * The Stripe idempotency key for a checkout request, from the caller's
 * `Idempotency-Key` header.
 *
 * A client that timed out does not know whether its checkout was created.
 * Retrying with the same key makes Stripe return the session it already created
 * instead of a second one — and a second subscription session is a second
 * subscription. The key is scoped by checkout kind and account, so one account's
 * key can never answer with another account's session. Absent header: the
 * request is not idempotent, as before. Stripe keeps keys for 24 hours.
 *
 * Returns `undefined` with no header, `null` for a malformed one.
 */
function checkoutIdempotencyKey(
  req: Request,
  kind: 'credits' | 'subscription',
  userId: string
): string | null | undefined {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) return null;
  return `oxy:checkout:${kind}:${userId}:${raw}`;
}

/** Stripe's answer to a reused key with different parameters. */
function isStripeIdempotencyError(error: unknown): boolean {
  return (error as { type?: unknown } | null)?.type === 'StripeIdempotencyError';
}

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

    const idempotencyKey = checkoutIdempotencyKey(req, 'credits', userId);
    if (idempotencyKey === null) return res.status(400).json(INVALID_IDEMPOTENCY_KEY_RESPONSE);

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
    }, idempotencyKey ? { idempotencyKey } : undefined);

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    if (isStripeIdempotencyError(error)) {
      return res.status(409).json(IDEMPOTENCY_KEY_REUSED_RESPONSE);
    }
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

    const idempotencyKey = checkoutIdempotencyKey(req, 'subscription', userId);
    if (idempotencyKey === null) return res.status(400).json(INVALID_IDEMPOTENCY_KEY_RESPONSE);

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
    }, idempotencyKey ? { idempotencyKey } : undefined);

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    if (isStripeIdempotencyError(error)) {
      return res.status(409).json(IDEMPOTENCY_KEY_REUSED_RESPONSE);
    }
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
 * `STRIPE_WEBHOOK_SECRET`, records the delivery in `billing_stripe_events`, and
 * dispatches handled events. No auth.
 *
 * Every accepted delivery is recorded BEFORE its handler runs and its outcome
 * after, so a renewal that did not grant, or a mirror that did not move, is a
 * queryable row rather than a log line. A handler that throws is recorded as
 * `failed` and answered 500, which is what makes Stripe redeliver it.
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
    if (!(await recordStripeEventReceived(event))) {
      // Already reached a terminal outcome. The grant paths are idempotent on
      // their own, so this only saves a second run; it guards nothing.
      return res.json({ received: true });
    }

    const result = await dispatchStripeEvent(event);
    await recordStripeEventOutcome(event.id, result.outcome, result.detail);
    res.json({ received: true });
  } catch (error) {
    logger.error('Error handling webhook:', error);
    try {
      await recordStripeEventOutcome(
        event.id,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    } catch (recordError) {
      logger.error('Could not record webhook failure', {
        eventId: event.id,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

async function dispatchStripeEvent(event: Stripe.Event): Promise<StripeEventResult> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      return { outcome: 'processed' };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return syncSubscriptionFromProvider(event.data.object as Stripe.Subscription);
    case 'invoice.paid':
      return handleInvoicePaid(event.data.object as Stripe.Invoice);
    case 'invoice.payment_failed':
      // The subscription's own `past_due`/`unpaid` transition arrives as a
      // `customer.subscription.updated` and is mirrored there. A failed invoice
      // is evidence of NO payment, so it grants nothing.
      return { outcome: 'not_granted', detail: 'invoice payment failed' };
    case 'charge.refunded':
      // A refund never grants and never charges. Whether it should claw back
      // credits already granted for the period is a commercial decision that
      // has not been made (issue #1524), so it is recorded and nothing else.
      return { outcome: 'ignored', detail: 'refund recorded; no credit clawback is defined' };
    case 'payment_intent.succeeded': {
      // The off-session auto-recharge path creates a PaymentIntent directly,
      // so no checkout session ever completes for it. A hosted checkout emits
      // BOTH events; both handlers compose the same idempotency key from the
      // same intent id, so the second one writes nothing.
      const result = await handleBalanceTopUpPaymentIntent(
        event.data.object as Stripe.PaymentIntent
      );
      if (result.status === 'ignored') {
        if (result.reason !== 'not-a-balance-top-up') {
          logger.warn('Balance top-up intent ignored', {
            paymentIntentId: (event.data.object as Stripe.PaymentIntent).id,
            reason: result.reason,
          });
        }
        return { outcome: 'ignored', detail: result.reason };
      }
      return { outcome: 'processed' };
    }
    default:
      return { outcome: 'ignored', detail: `no handler for ${event.type}` };
  }
}

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
 *      Same shape `handleInvoicePaid` uses for renewals.
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

/** The account a Stripe customer belongs to, or `null`. */
async function accountForStripeCustomer(customerId: string): Promise<string | null> {
  // `user_credits.stripe_customer_id` carries a partial UNIQUE index, so this
  // resolves at most one account — the uniqueness the Mongoose `findOne` assumed
  // without stating.
  const [account] = await getDb()
    .select({ userId: userCredits.userId })
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, customerId))
    .limit(1);
  return account?.userId ?? null;
}

function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Mirror a subscription into `billing_subscriptions` from a FRESH provider read.
 *
 * Stripe does not deliver webhooks in order. Mirroring the event payload let an
 * older `customer.subscription.updated` arriving late overwrite a newer state —
 * `active` written back over `canceled`, which keeps granting premium to someone
 * who stopped paying. So the payload is only used for its id: the state is read
 * from Stripe now, and the row is overwritten only when that read began after the
 * read the row already holds (`provider_synced_at`). A slow read that started
 * first can therefore never roll back a later one.
 *
 * This GRANTS NOTHING. Credits for a period are granted by `handleInvoicePaid`,
 * on the evidence of a paid invoice — never by a subscription changing state.
 */
async function syncSubscriptionFromProvider(
  eventSubscription: Stripe.Subscription
): Promise<StripeEventResult> {
  // Taken BEFORE the request: whatever Stripe answers is at least as new as this.
  const readStartedAt = new Date();
  const subscription = await getStripe().subscriptions.retrieve(eventSubscription.id);

  const customerId = stripeIdOf(subscription.customer);
  const userId = customerId ? await accountForStripeCustomer(customerId) : null;
  if (!customerId || !userId) {
    return { outcome: 'ignored', detail: 'no account for the Stripe customer' };
  }

  const subscriptionItem = subscription.items.data[0];
  const priceId = subscriptionItem.price.id;
  const plan = SUBSCRIPTION_PLANS.find((p) => p.stripePriceId === priceId);
  const lifecycle = {
    status: subscription.status,
    currentPeriodStart: new Date(subscriptionItem.current_period_start * 1000),
    currentPeriodEnd: new Date(subscriptionItem.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    providerSyncedAt: readStartedAt,
  };
  const heldReadIsOlder = or(
    isNull(billingSubscriptions.providerSyncedAt),
    lte(billingSubscriptions.providerSyncedAt, readStartedAt)
  );
  const db = getDb();

  if (!plan) {
    logger.warn('Unrecognized subscription price ID', {
      priceId,
      subscriptionId: subscription.id,
      customerId,
    });
    // An unknown price must not freeze an EXISTING row's lifecycle: a deletion
    // the mirror never hears about keeps granting premium. Move the lifecycle
    // only, keep the plan snapshot, and create nothing.
    const updated = await db
      .update(billingSubscriptions)
      .set(lifecycle)
      .where(and(eq(billingSubscriptions.stripeSubscriptionId, subscription.id), heldReadIsOlder))
      .returning({ id: billingSubscriptions.id });
    return updated.length > 0
      ? { outcome: 'synced', detail: `lifecycle only; unrecognized price ${priceId}` }
      : { outcome: 'ignored', detail: `unrecognized price ${priceId}` };
  }

  // The Mongo upsert keyed on `stripeSubscriptionId`, which is the table's
  // unique key here too — so it is one statement, not a read-then-write.
  const mirror = {
    userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    ...lifecycle,
    planName: plan.name,
    planCreditsPerMonth: plan.creditsPerMonth,
    planPriceMinorUnits: plan.price,
    planCurrency: plan.currency,
  };
  const written = await db
    .insert(billingSubscriptions)
    .values(mirror)
    .onConflictDoUpdate({
      target: billingSubscriptions.stripeSubscriptionId,
      set: mirror,
      setWhere: heldReadIsOlder,
    })
    .returning({ id: billingSubscriptions.id });

  return written.length > 0
    ? { outcome: 'synced' }
    : { outcome: 'stale', detail: 'the mirror already holds a newer provider read' };
}

/**
 * The invoices whose payment opens a new credit period: the first invoice of a
 * subscription and every renewal. `subscription_update` (a mid-period plan
 * change, prorated) is deliberately absent — what a change of plan grants is a
 * commercial rule nobody has decided, and granting a full month on a proration
 * would be inventing one.
 */
const PERIOD_OPENING_BILLING_REASONS: ReadonlySet<string> = new Set([
  'subscription_create',
  'subscription_cycle',
]);

function linePriceId(line: Stripe.InvoiceLineItem): string | null {
  return stripeIdOf(line.pricing?.price_details?.price);
}

/**
 * Grant a subscription period's credits on the evidence of a PAID invoice,
 * exactly once per period.
 *
 * This replaces granting from `customer.subscription.updated` inside a
 * five-minute window around the period start. That window did not prove a
 * payment — an active subscription is not a paid invoice — and a first delivery
 * that arrived late (a webhook outage, a backlog, Stripe's own retry schedule)
 * fell outside it, so the period was never granted at all.
 *
 * The invoice is reconciled before anything is written: it must be `paid`, open
 * a period (`PERIOD_OPENING_BILLING_REASONS`), carry a line for a plan price this
 * API sells, be in that plan's currency, and have actually collected money. Any
 * failure is recorded as `not_granted` with its reason, never guessed past. The
 * receipt records what the invoice COLLECTED, not the catalogue price, and links
 * the invoice id; a difference from the catalogue price (a coupon, tax) is kept
 * in the event's detail for reconciliation.
 *
 * The idempotency key is unchanged — `(subscription, period_start, type)` — so a
 * period granted by the old path before this deploy is recognised as granted and
 * is not granted again.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<StripeEventResult> {
  const subscriptionId = stripeIdOf(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) {
    return { outcome: 'ignored', detail: 'invoice is not for a subscription' };
  }
  if (invoice.status !== 'paid') {
    return { outcome: 'not_granted', detail: `invoice status is ${invoice.status ?? 'null'}` };
  }
  if (!invoice.billing_reason || !PERIOD_OPENING_BILLING_REASONS.has(invoice.billing_reason)) {
    return {
      outcome: 'not_granted',
      detail: `billing_reason ${invoice.billing_reason ?? 'null'} does not open a credit period`,
    };
  }

  const customerId = stripeIdOf(invoice.customer);
  const userId = customerId ? await accountForStripeCustomer(customerId) : null;
  if (!customerId || !userId) {
    return { outcome: 'not_granted', detail: 'no account for the Stripe customer' };
  }

  if (invoice.amount_paid <= 0) {
    // Zero-amount trials/discounts await a declared commercial rule.
    return { outcome: 'not_granted', detail: 'invoice collected no money' };
  }

  // Stripe embeds only the first page. Inspect every line before accepting a
  // recurring period; an early known-price line may be a proration.
  const lines = [...invoice.lines.data];
  let page = invoice.lines;
  const seenCursors = new Set<string>();
  while (page.has_more) {
    const cursor = page.data.at(-1)?.id;
    if (!cursor || seenCursors.has(cursor) || seenCursors.size >= 100) {
      throw new Error('Invoice line pagination made no progress; refusing incomplete evidence');
    }
    seenCursors.add(cursor);
    page = await getStripe().invoices.listLineItems(invoice.id, { limit: 100, starting_after: cursor });
    lines.push(...page.data);
  }
  const candidates = lines.filter((candidate) => {
    const parent = candidate.parent;
    const details = parent?.subscription_item_details;
    return parent?.type === 'subscription_item_details'
      && details?.subscription === subscriptionId && details.proration === false;
  });
  const planLines = candidates.filter((candidate) => {
    const priceId = linePriceId(candidate);
    return priceId && SUBSCRIPTION_PLANS.some((entry) => entry.stripePriceId === priceId);
  });
  if (planLines.length === 0) {
    return { outcome: 'not_granted', detail: 'no invoice line for a plan price this API sells' };
  }
  // Our checkout sells one recurring item at quantity one. An ambiguous
  // invoice needs a reviewed mapping, never an arbitrary first line.
  if (candidates.length !== 1 || planLines.length !== 1) {
    return { outcome: 'not_granted', detail: 'ambiguous recurring invoice lines or periods' };
  }
  const [line] = planLines;
  const plan = SUBSCRIPTION_PLANS.find((entry) => entry.stripePriceId === linePriceId(line))!;
  if (line.currency !== invoice.currency || line.quantity !== 1 || line.amount <= 0
    || !Number.isSafeInteger(line.period.start) || !Number.isSafeInteger(line.period.end)
    || line.period.start <= 0 || line.period.end <= line.period.start) {
    return { outcome: 'not_granted', detail: 'recurring line currency, quantity, amount or period is invalid' };
  }
  if (invoice.currency !== plan.currency) {
    return {
      outcome: 'not_granted',
      detail: `invoice currency ${invoice.currency} does not match plan currency ${plan.currency}`,
    };
  }


  const periodStart = new Date(line.period.start * 1000);
  const amountDetail =
    invoice.amount_paid === plan.price
      ? undefined
      : `amount_paid ${invoice.amount_paid} differs from plan price ${plan.price} ${plan.currency}`;
  const credits = plan.creditsPerMonth;
  const planName = plan.name;

  return getDb().transaction(async (tx): Promise<StripeEventResult> => {
    // Same shape as `handleCheckoutCompleted`: the receipt is the idempotency
    // claim, `billing_transactions_subscription_period_key` makes winning it
    // atomic, and the grant is conditional on having won.
    const [receipt] = await tx
      .insert(billingTransactions)
      .values({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionPeriodStart: periodStart,
        stripeInvoiceId: invoice.id,
        type: 'subscription_payment',
        amountMinorUnits: invoice.amount_paid,
        currency: invoice.currency,
        credits,
        status: 'completed',
        description: `${planName} subscription credits`,
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
        subscriptionId,
        invoiceId: invoice.id,
        periodStart: periodStart.toISOString(),
        userId,
      });
      return { outcome: 'duplicate', detail: 'the period was already granted' };
    }

    // The receipt suppresses every replay, so a silently-failed grant would
    // never be retried. Throw: the transaction rolls back, the claim is
    // released, and Stripe's redelivery tries again.
    if (!(await addCredits(tx, userId, credits, 'paid'))) {
      throw new Error(`Renewal credit grant did not apply for user ${userId} (invoice ${invoice.id})`);
    }
    return { outcome: 'granted', detail: amountDetail };
  });
}

export default router;
