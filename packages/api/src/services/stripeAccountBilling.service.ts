/**
 * The Stripe boundary for ACCOUNT-scoped billing.
 *
 * Stripe is a payment and invoicing processor here and nothing else. It never
 * holds a balance this platform reads, it is never asked what an account can
 * spend, and no meter of its is consulted. What it does is take money and tell
 * us it took it; the credit lands through the same
 * `inferenceLedger.service.ts` funding path every other credit does, which is
 * the only code in this package that may move money into a bucket.
 *
 * ## The account is the customer, and the customer link is NOT duplicated
 *
 * `user_credits.stripe_customer_id` already carries a partial unique index and
 * is what `handleSubscriptionUpdate` resolves a webhook back through. `users` IS
 * the account table, so that column is already an ACCOUNT → Stripe customer
 * link, whatever its name suggests. A second column on `billing_profiles` naming
 * the same Stripe customer would be a second authority for one fact, and the
 * failure mode of two Stripe-customer columns that disagree is money credited to
 * the wrong account. So this module reuses it, for organization and project
 * accounts exactly as for personal ones.
 *
 * The cost of reusing it is stated rather than hidden: resolving a customer for
 * an account that has never had one creates its `user_credits` row, which
 * carries the platform's free API-credit tier. That is a PRODUCT entitlement
 * appearing on an account that only wanted to pay for inference. It is harmless
 * — the two are separate balances and `entitlement.service.ts` reports them
 * separately — and it is strictly better than a second customer column.
 *
 * ## Idempotency is the processor's own reference, twice
 *
 * A redelivered `checkout.session.completed` must not credit twice. Two
 * independent guards stand in the way, and they fail differently on purpose:
 * the ledger entry's `idempotency_key` (`stripe:payment_intent:<id>`), and the
 * `(provider, external_ref)` unique on `billing_external_payments`. The first is
 * composed by application code; the second is the processor's own identifier and
 * cannot drift. `stripeAccountBilling.service.test.ts` replays a webhook and
 * asserts one credit, one ledger entry and one payment row.
 *
 * ## What is NOT verified
 *
 * There is no Stripe account behind this in development, so every call into the
 * SDK below is exercised against a fake in the suite and against nothing at all
 * in reality. The shapes are taken from the SDK's own types; the behaviours —
 * that `payment_intent` is a string on a completed checkout session, that an
 * off-session `PaymentIntent` raises `authentication_required` rather than
 * returning it — are read from Stripe's documentation and are UNVERIFIED here.
 */

import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { userCredits } from '../db/schema/userCredits';
import { getOrCreateUserCredits } from '../routes/credits';
import { getStripe } from '../utils/stripeClient';
import { logger } from '../utils/logger';
import {
  exactDecimalToMinorUnits,
  minorUnitExponentFor,
  minorUnitsToExactDecimal,
} from '../utils/minorUnits';
import { recordTopUp, type FundingResult } from './inferenceLedger.service';
import type {
  PaymentProcessorLedger,
  ProcessorLedgerQuery,
  ProcessorPayment,
} from './billingReconciliation.service';

/**
 * The `metadata.type` a balance top-up checkout carries.
 *
 * DISTINCT from `credit_purchase`, which buys API credits — a different product
 * with a different balance. The webhook dispatches on this value, and the two
 * paths must never be reachable from one another: a top-up that granted API
 * credits, or a credit purchase that funded the inference balance, would merge
 * the two products this whole workstream keeps apart.
 */
export const BALANCE_TOP_UP_METADATA_TYPE = 'balance_top_up';

/**
 * The Stripe customer for an ACCOUNT, created on first use.
 *
 * Moved here from `routes/billing.ts` so that the personal-billing routes and
 * the account-billing routes resolve a customer through one function. Two
 * resolvers would eventually differ on the "Stripe forgot this customer" branch
 * below, and the account that lost its customer id is the account whose payments
 * stop reconciling.
 */
export async function getOrCreateAccountStripeCustomer(
  accountId: string,
  email?: string
): Promise<string> {
  const db = getDb();
  const credits = await getOrCreateUserCredits(db, accountId);

  if (credits.stripeCustomerId) {
    try {
      await getStripe().customers.retrieve(credits.stripeCustomerId);
      return credits.stripeCustomerId;
    } catch {
      // Stripe no longer knows this customer; fall through and mint a new one.
    }
  }

  const customer = await getStripe().customers.create({
    email,
    metadata: { accountId },
  });

  await db
    .update(userCredits)
    .set({ stripeCustomerId: customer.id })
    .where(eq(userCredits.userId, accountId));
  logger.info('Created Stripe customer for account', { accountId, customerId: customer.id });

  return customer.id;
}

export interface TopUpCheckoutInput {
  readonly accountId: string;
  /** Exact decimal string. Must divide evenly into the currency's minor unit. */
  readonly amount: string;
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly email?: string;
}

export type TopUpCheckoutResult =
  | { readonly status: 'created'; readonly sessionId: string; readonly url: string | null }
  | { readonly status: 'amount-not-representable'; readonly amount: string };

/**
 * A hosted checkout that funds an account's prepaid balance.
 *
 * The amount is refused when it does not divide evenly into whole minor units.
 * There is no correct rounding of a $20.005 top-up: charging $20.01 takes money
 * the customer did not agree to, and charging $20.00 credits money they asked
 * for and did not get. Both are discrepancies they will find before we do.
 *
 * The account id travels in `metadata`, and the webhook re-validates it against
 * the session's own customer rather than trusting it — metadata is only as
 * trustworthy as whoever created the session, and the webhook is the place that
 * moves money.
 */
export async function createBalanceTopUpCheckout(
  input: TopUpCheckoutInput
): Promise<TopUpCheckoutResult> {
  const exponent = minorUnitExponentFor(input.currency);
  const minorUnits = exactDecimalToMinorUnits(input.amount, exponent);
  if (minorUnits === null || minorUnits <= 0) {
    return { status: 'amount-not-representable', amount: input.amount };
  }

  const customerId = await getOrCreateAccountStripeCustomer(input.accountId, input.email);

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: {
            name: 'Oxy inference balance',
            description: `Adds ${input.amount} ${input.currency} to the account balance`,
          },
          unit_amount: minorUnits,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      accountId: input.accountId,
      type: BALANCE_TOP_UP_METADATA_TYPE,
      currency: input.currency,
    },
  });

  return { status: 'created', sessionId: session.id, url: session.url };
}

/** A hosted portal session for an account's payment methods and invoices. */
export async function createAccountPortalSession(
  accountId: string,
  returnUrl: string,
  email?: string
): Promise<string | null> {
  const customerId = await getOrCreateAccountStripeCustomer(accountId, email);
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

export type BalanceTopUpResult =
  | { readonly status: 'credited'; readonly funding: FundingResult }
  | { readonly status: 'ignored'; readonly reason: string };

/**
 * The fields a completed checkout session is read for, and no others.
 *
 * A `Pick` rather than the whole `Stripe.Checkout.Session`, for two reasons that
 * both matter more than brevity. It DOCUMENTS the dependency — seven fields, all
 * visible at the top of the file — and it makes the handler testable from a
 * plain object literal, so the webhook-redelivery test needs no `as` cast and no
 * Stripe account. Stripe's own type is structurally assignable to it, so the
 * webhook passes the real object unchanged.
 */
export type BalanceTopUpSession = Pick<
  Stripe.Checkout.Session,
  'id' | 'metadata' | 'payment_intent' | 'amount_total' | 'currency' | 'customer' | 'created'
>;

/** The same narrowing for an off-session payment intent. */
export type BalanceTopUpIntent = Pick<
  Stripe.PaymentIntent,
  'id' | 'metadata' | 'status' | 'amount_received' | 'currency' | 'customer' | 'created'
>;

/**
 * Credit an account's balance from a completed checkout session.
 *
 * Called by the Stripe webhook. Everything it refuses, it refuses by returning
 * `ignored` with a reason rather than throwing: a throw would make Stripe retry
 * a session that will never be creditable, forever.
 *
 * The account is taken from metadata and then CHECKED against the session's own
 * customer. Metadata is set by whoever created the session — this platform, in
 * every current path — but the check costs one indexed lookup and closes the
 * gap between "the code that creates sessions today" and "every code path that
 * will ever create one".
 */
export async function handleBalanceTopUpCompleted(
  session: BalanceTopUpSession
): Promise<BalanceTopUpResult> {
  const metadata = session.metadata;
  if (!metadata?.accountId || metadata.type !== BALANCE_TOP_UP_METADATA_TYPE) {
    return { status: 'ignored', reason: 'not-a-balance-top-up' };
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : null;
  if (!paymentIntentId) {
    // No payment intent means no idempotency key, and crediting without one is
    // how a replayed webhook pays out twice. Refuse rather than credit unguarded.
    return { status: 'ignored', reason: 'no-payment-intent' };
  }

  const amountMinorUnits = session.amount_total;
  if (amountMinorUnits === null || amountMinorUnits <= 0) {
    return { status: 'ignored', reason: 'no-amount' };
  }

  const currency = (session.currency ?? metadata.currency ?? 'usd').toUpperCase();
  const customerId = typeof session.customer === 'string' ? session.customer : null;
  const accountId = metadata.accountId;

  const owner = customerId === null ? undefined : await accountOfStripeCustomer(customerId);
  if (owner !== undefined && owner !== accountId) {
    // The session claims one account and its customer belongs to another. This
    // is the one shape that would credit the wrong account's balance, so it is
    // refused loudly in the log and silently to Stripe.
    logger.error('Balance top-up metadata does not match its Stripe customer', {
      sessionId: session.id,
      metadataAccountId: accountId,
      customerAccountId: owner,
    });
    return { status: 'ignored', reason: 'account-customer-mismatch' };
  }

  const exponent = minorUnitExponentFor(currency);
  const funding = await recordTopUp({
    // The processor's own reference, so a redelivery composes the same key.
    idempotencyKey: `stripe:payment_intent:${paymentIntentId}`,
    accountId,
    currency,
    amount: minorUnitsToExactDecimal(amountMinorUnits, exponent),
    externalPayment: {
      provider: 'stripe',
      externalKind: 'payment_intent',
      externalRef: paymentIntentId,
      occurredAt: new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000),
    },
  });

  if (funding.status === 'no-billing-profile') {
    // The money is at Stripe and there is nowhere to put it. Not a throw: a
    // retry would fail identically until somebody provisions a profile, and the
    // next reconciliation pass reports it as `missing_in_ledger`, which is
    // exactly what it is.
    logger.error('Balance top-up for an account with no billing profile', {
      sessionId: session.id,
      accountId,
    });
    return { status: 'ignored', reason: 'no-billing-profile' };
  }

  return { status: 'credited', funding };
}

/**
 * Credit an account's balance from a succeeded payment intent.
 *
 * The off-session auto-recharge path creates a `PaymentIntent` directly, so no
 * `checkout.session.completed` ever fires for it and the hosted-checkout handler
 * above would never see the money.
 *
 * Both handlers compose the SAME idempotency key from the same payment intent
 * id, which makes the overlap a feature rather than a hazard: a hosted checkout
 * emits BOTH events, both handlers run, and the second one writes nothing. That
 * is the property to check when reading this — not that the two paths are
 * disjoint, but that they cannot both credit.
 */
export async function handleBalanceTopUpPaymentIntent(
  intent: BalanceTopUpIntent
): Promise<BalanceTopUpResult> {
  const metadata = intent.metadata;
  if (!metadata?.accountId || metadata.type !== BALANCE_TOP_UP_METADATA_TYPE) {
    return { status: 'ignored', reason: 'not-a-balance-top-up' };
  }
  if (intent.status !== 'succeeded' || intent.amount_received <= 0) {
    return { status: 'ignored', reason: 'not-settled' };
  }

  const accountId = metadata.accountId;
  const currency = intent.currency.toUpperCase();
  const customerId = typeof intent.customer === 'string' ? intent.customer : null;

  const owner = customerId === null ? undefined : await accountOfStripeCustomer(customerId);
  if (owner !== undefined && owner !== accountId) {
    logger.error('Balance top-up intent metadata does not match its Stripe customer', {
      paymentIntentId: intent.id,
      metadataAccountId: accountId,
      customerAccountId: owner,
    });
    return { status: 'ignored', reason: 'account-customer-mismatch' };
  }

  const exponent = minorUnitExponentFor(currency);
  const funding = await recordTopUp({
    idempotencyKey: `stripe:payment_intent:${intent.id}`,
    accountId,
    currency,
    amount: minorUnitsToExactDecimal(intent.amount_received, exponent),
    externalPayment: {
      provider: 'stripe',
      externalKind: 'payment_intent',
      externalRef: intent.id,
      occurredAt: new Date(intent.created * 1000),
    },
  });

  if (funding.status === 'no-billing-profile') {
    logger.error('Balance top-up intent for an account with no billing profile', {
      paymentIntentId: intent.id,
      accountId,
    });
    return { status: 'ignored', reason: 'no-billing-profile' };
  }

  return { status: 'credited', funding };
}

async function accountOfStripeCustomer(customerId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ userId: userCredits.userId })
    .from(userCredits)
    .where(eq(userCredits.stripeCustomerId, customerId))
    .limit(1);
  return row?.userId;
}

export type AutoRechargeChargeResult =
  | { readonly status: 'charged'; readonly externalRef: string }
  | { readonly status: 'no-payment-method' }
  | { readonly status: 'declined'; readonly failureCode: string };

/**
 * Charge an account's saved card off-session for an automatic top-up.
 *
 * The CALLER must already hold a `claimed` auto-recharge attempt — this function
 * has no idempotency of its own and will happily charge twice if called twice.
 * That is deliberate rather than an omission: an idempotency guard here would be
 * a second one beside `billing_auto_recharge_attempts`, and two guards for one
 * fact is how the wrong one ends up being the one somebody trusts.
 *
 * It credits nothing. The balance moves when Stripe's webhook confirms the
 * charge, through the same `handleBalanceTopUpCompleted` path a hosted checkout
 * takes — so a balance is only ever credited by the processor's own
 * confirmation, never by this optimistic call returning.
 */
export async function chargeAutoRecharge(input: {
  readonly accountId: string;
  readonly amount: string;
  readonly currency: string;
}): Promise<AutoRechargeChargeResult> {
  const exponent = minorUnitExponentFor(input.currency);
  const minorUnits = exactDecimalToMinorUnits(input.amount, exponent);
  if (minorUnits === null || minorUnits <= 0) {
    // Unreachable through the configured path — the column CHECK requires a
    // positive amount and the profile's currency is the balance's — but an
    // unrepresentable amount must never become a rounded charge.
    return { status: 'declined', failureCode: 'amount_not_representable' };
  }

  const customerId = await getOrCreateAccountStripeCustomer(input.accountId);
  const stripe = getStripe();

  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  const paymentMethod = methods.data[0];
  if (paymentMethod === undefined) {
    return { status: 'no-payment-method' };
  }

  try {
    const intent = await stripe.paymentIntents.create({
      customer: customerId,
      payment_method: paymentMethod.id,
      amount: minorUnits,
      currency: input.currency.toLowerCase(),
      off_session: true,
      confirm: true,
      metadata: {
        accountId: input.accountId,
        type: BALANCE_TOP_UP_METADATA_TYPE,
        currency: input.currency,
      },
    });
    return { status: 'charged', externalRef: intent.id };
  } catch (error) {
    // Stripe raises rather than returns on an off-session decline. The CODE is
    // kept and the message is discarded — a processor's free-form message is
    // where a card number or a customer's name eventually ends up in an export.
    const code = stripeDeclineCode(error);
    return { status: 'declined', failureCode: code };
  }
}

/**
 * The processor's own decline code, or a stable stand-in.
 *
 * Narrowed by property presence rather than by `instanceof Stripe.errors.*`: the
 * SDK's error classes are not reliably identifiable across a `catch` boundary
 * when more than one copy of the package is resolvable, and a failed
 * `instanceof` here would erase the reason for every decline.
 */
function stripeDeclineCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { decline_code?: unknown; code?: unknown };
    if (typeof candidate.decline_code === 'string') return candidate.decline_code.slice(0, 64);
    if (typeof candidate.code === 'string') return candidate.code.slice(0, 64);
  }
  return 'processor_error';
}

/**
 * Stripe as a {@link PaymentProcessorLedger} — the reconciliation adapter.
 *
 * Reads SUCCEEDED payment intents only. A `requires_payment_method` or
 * `canceled` intent moved no money, and counting one would manufacture a
 * `missing_in_ledger` finding on every abandoned checkout.
 *
 * `created` is bounded on both sides. Stripe's list is newest-first and paged;
 * the loop follows `starting_after` until Stripe says there is no more, with a
 * hard page ceiling so a reconciliation cannot become an unbounded scan of the
 * whole account history if a filter is ever dropped.
 */
export function stripePaymentProcessorLedger(): PaymentProcessorLedger {
  return {
    provider: 'stripe',
    async listSettledPayments(query: ProcessorLedgerQuery): Promise<ProcessorPayment[]> {
      const stripe = getStripe();
      const currency = query.currency.toUpperCase();
      const payments: ProcessorPayment[] = [];
      let startingAfter: string | undefined;

      for (let page = 0; page < MAX_RECONCILIATION_PAGES; page += 1) {
        const batch = await stripe.paymentIntents.list({
          limit: 100,
          created: {
            gte: Math.floor(query.periodStart.getTime() / 1000),
            lt: Math.floor(query.periodEnd.getTime() / 1000),
          },
          ...(query.customerRef === undefined ? {} : { customer: query.customerRef }),
          ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
        });

        for (const intent of batch.data) {
          if (intent.status !== 'succeeded') continue;
          if (intent.currency.toUpperCase() !== currency) continue;
          payments.push({
            externalKind: 'payment_intent',
            externalRef: intent.id,
            amountMinorUnits: intent.amount_received,
            currency,
            occurredAt: new Date(intent.created * 1000),
            customerRef: typeof intent.customer === 'string' ? intent.customer : null,
          });
        }

        if (!batch.has_more || batch.data.length === 0) break;
        startingAfter = batch.data[batch.data.length - 1].id;
      }

      return payments;
    },
  };
}

/**
 * Pages a single reconciliation pass may read.
 *
 * 100 pages of 100 is 10,000 payments in one window, far past anything a
 * daily or monthly pass should see. It is a CEILING against an unbounded scan,
 * not a tuning knob: reaching it means the window or the filter is wrong.
 */
const MAX_RECONCILIATION_PAGES = 100;
