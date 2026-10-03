/**
 * Stripe webhooks and checkout — against a REAL Postgres, through the REAL route.
 *
 * Stripe retries a webhook by design, delivers events out of order, and a first
 * delivery can arrive long after the fact. Every grant path is therefore written
 * as a REPLAY here — the same event POSTed at `/billing/webhook` more than once —
 * rather than as a unit test of a helper, because the failures lived in the
 * handlers' control flow and not in any single statement.
 *
 * Covered (issue #1524):
 *   - one-off credit purchase, keyed on `stripe_payment_intent_id`;
 *   - renewal credits, granted on a PAID INVOICE (`invoice.paid`) and keyed on
 *     `(stripe_subscription_id, period_start)` — including a first delivery long
 *     after the period started, which the old five-minute window never granted;
 *   - failed invoices, reconciliation mismatches, refunds and cancellation grant
 *     nothing; a crash between receipt and grant leaves nothing and is retried;
 *   - the subscription mirror is read from the provider, so out-of-order and
 *     concurrent events cannot roll it back;
 *   - every delivery is recorded in `billing_stripe_events`;
 *   - checkout accepts an `Idempotency-Key`, so a timed-out client's retry gets
 *     the session that was already created instead of a second one.
 *
 * Only Stripe (a third-party network call), the auth middleware and the Stripe
 * customer resolver are stubbed. Signature verification is Stripe's own code
 * over a secret this suite has no reason to hold; everything downstream of it —
 * the route, the handlers, the transactions, the partial unique indexes, the
 * guarded credit grant — is the real thing. No real money moves: the Stripe
 * stub never leaves the process.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from 'drizzle-orm';


import express from "express";


/** Stripe's side of every subscription, as `subscriptions.retrieve` answers it. */
const invoiceLinePages = new Map<string, Array<{ data: Record<string, unknown>[]; has_more: boolean }>>();
const invoiceLineCalls: Array<{ id: string; cursor?: string }> = [];
const currentInvoices = new Map<string, Record<string, unknown>>();
const invoiceRetrieveCalls: string[] = [];
const productPrices = new Map<string, Record<string, unknown>>();
const currentCharges = new Map<string, Record<string, unknown>>();
const invoicePayments = new Map<string, Record<string, unknown>>();
let failNextInvoiceRetrieve = false;

let invalidNextCancellationSnapshot = false;
const subscriptionUpdateCalls: string[] = [];
const stripeSubscriptions = new Map<string, Record<string, unknown>>();
/** When set, the NEXT `subscriptions.retrieve` waits for this before answering. */
let holdNextRetrieve: Promise<void> | null = null;

/** Stripe's idempotency store for checkout sessions: key -> (params, session). */
const checkoutSessionsByKey = new Map<string, { params: string; session: { id: string; url: string } }>();
const checkoutCreateCalls: Array<{ params: unknown; options: unknown }> = [];
let checkoutCreateDelayMs = 0;
let sessionCounter = 0;

jest.mock('../../utils/stripeClient', () => ({
  getStripe: () => ({
    prices: {
			retrieve: async (id: string) => {
				const price = productPrices.get(id);
				if (!price) throw new Error("fixture price missing");
				return structuredClone(price);
			},
		},
		accounts: { retrieve: async () => ({ id: 'acct_synthetic_billing' }) },
    charges: { retrieve: async (id: string) => structuredClone(currentCharges.get(id) ?? { id, livemode: false, payment_intent: null }) },
    invoicePayments: { list: async (params: { invoice?: string; payment?: { payment_intent?: string } }) => ({ has_more: false, data: [...invoicePayments.values()].filter(p => params.invoice ? p.invoice === params.invoice : (p.payment as { payment_intent: string }).payment_intent === params.payment?.payment_intent) }) },
    webhooks: {
      constructEvent: (body: Buffer) => JSON.parse(body.toString()),
    },
    subscriptions: {
      update: async (id: string, params: { cancel_at_period_end: boolean }) => {
				subscriptionUpdateCalls.push(id);
				const current = stripeSubscriptions.get(id);
				if (!current) throw new Error("No such subscription");
				const updated = {
					...current,
					cancel_at_period_end: params.cancel_at_period_end,
				};
				stripeSubscriptions.set(id, updated);
				if (invalidNextCancellationSnapshot) { invalidNextCancellationSnapshot = false; return { ...structuredClone(updated), items: { has_more: true, data: [] } }; }
				return structuredClone(updated);
			},
			retrieve: async (id: string) => {
        const hold = holdNextRetrieve;
        holdNextRetrieve = null;
        // Snapshot BEFORE waiting: a held read answers with the state at the
        // moment it reached Stripe, which is what makes it stale.
        const state = stripeSubscriptions.get(id);
        if (hold) await hold;
        if (!state) throw Object.assign(new Error(`No such subscription: ${id}`), { type: 'StripeInvalidRequestError' });
        return structuredClone(state);
      },
		},
		invoices: {
      list: async (params: { subscription: string }) => ({ has_more: false, data: [...currentInvoices.values()].filter(invoice => (invoice.parent as { subscription_details?: { subscription?: string } })?.subscription_details?.subscription === params.subscription && invoice.status === 'paid') }),
      retrieve: async (id: string) => {
        invoiceRetrieveCalls.push(id);
        if (failNextInvoiceRetrieve) {
          failNextInvoiceRetrieve = false;
          throw new Error('invoice retrieval timed out');
        }
        const invoice = currentInvoices.get(id);
        if (!invoice) throw new Error('invoice retrieval unavailable');
        return structuredClone(invoice);
      },
      listLineItems: async (id: string, params: { starting_after?: string }) => {
        invoiceLineCalls.push({ id, cursor: params.starting_after });
        const pages = invoiceLinePages.get(id);
        if (!pages?.length) throw new Error('invoice pagination failed');
        return structuredClone(pages.shift());
      },
    },
		checkout: {
      sessions: {
        create: async (params: unknown, options?: { idempotencyKey?: string }) => {
          checkoutCreateCalls.push({ params, options });
          if (checkoutCreateDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, checkoutCreateDelayMs));
          }
          const key = options?.idempotencyKey;
          const serialized = JSON.stringify(params);
          if (key) {
            const existing = checkoutSessionsByKey.get(key);
            if (existing) {
              if (existing.params !== serialized) {
                throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
                  type: 'StripeIdempotencyError',
                });
              }
              return existing.session;
            }
          }
          sessionCounter += 1;
          const session = { id: `cs_test_${sessionCounter}`, url: `https://checkout.stripe.test/${sessionCounter}` };
          if (key) checkoutSessionsByKey.set(key, { params: serialized, session });
          return session;
        },
      },
    },
  }),
}));

/** When true, the next credit grant reports that it did not apply. */
let failNextGrant = false;

jest.mock('../../db/credits', () => {
  const actual = jest.requireActual('../../db/credits');
  return {
    ...actual,
    addCredits: (...args: unknown[]) => {
      if (failNextGrant) {
        failNextGrant = false;
        return Promise.resolve(false);
      }
      return actual.addCredits(...args);
    },
  };
});

jest.mock('../../services/subscriptionCreditLedger.service', () => {
  const actual = jest.requireActual('../../services/subscriptionCreditLedger.service');
  return { ...actual, grantSubscriptionCredits: (...args: unknown[]) => {
    if (failNextGrant) { failNextGrant = false; throw new Error('synthetic grant failure'); }
    return actual.grantSubscriptionCredits(...args);
  } };
});

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: Record<string, string | undefined>; user?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    const userId = req.headers['x-test-user'];
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    req.user = { _id: { toString: () => userId }, email: `${userId}@example.test` };
    next();
  },
}));

jest.mock('../../services/stripeAccountBilling.service', () => ({
  ...jest.requireActual('../../services/stripeAccountBilling.service'),
  getOrCreateAccountStripeCustomer: async (userId: string) => `cus_${userId}`,
}));

import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { deductCredits } from '../../db/credits';
import {
	accessGrants,
	applications,
	accessOfferSegments,
	accessProviderEvents,
	accessProviderPeriods,
	accessSubscriptionSources,
} from "../../db/schema";
import { billingCreditGrants, billingCreditRefundObservations } from '../../db/schema/billingCreditGrants';
import { billingStripeEvents } from "../../db/schema/billingStripeEvents";
import { billingSubscriptions } from "../../db/schema/billingSubscriptions";
import { billingTransactions } from "../../db/schema/billingTransactions";
import { userCredits } from "../../db/schema/userCredits";
import { users } from "../../db/schema/users";
import { productAccessFixture } from "../../services/__fixtures__/productAccessFixtures";
import { readSubjectProductAccess } from "../../services/productAccessPersistence.service";

const WEBHOOK_SECRET = "whsec_test_secret";
const PRO_PRICE_ID = "price_test_pro";
const BUSINESS_PRICE_ID = "price_test_business";
const PRO_PRICE = 2999;
const PRO_CREDITS = 10_000;
const BUSINESS_PRICE = 9999;
const BUSINESS_CREDITS = 50_000;
const HOUR = 60 * 60;
const MONTH = 30 * 24 * HOUR;

/**
 * `routes/billing.ts` reads the price ids into its plan catalogue at MODULE
 * LOAD, so the env has to be set before the module is first required. `import`
 * statements are hoisted above every top-level statement, hence the lazy load.
 */
let billingRoutes: express.Router | null = null;
async function loadBillingRoutes(): Promise<express.Router> {
  if (!billingRoutes) {
    billingRoutes = (await import('../billing')).default;
  }
  return billingRoutes;
}

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_fixture';
  process.env.STRIPE_PRO_PRICE_ID = PRO_PRICE_ID;
  process.env.STRIPE_BUSINESS_PRICE_ID = BUSINESS_PRICE_ID;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  invalidNextCancellationSnapshot = false;
  subscriptionUpdateCalls.length = 0;
  failNextGrant = false;
  invoiceLinePages.clear();
  invoiceLineCalls.length = 0;
  currentInvoices.clear();
  currentCharges.clear();
  invoicePayments.clear();
  invoiceRetrieveCalls.length = 0;
  failNextInvoiceRetrieve = false;
  holdNextRetrieve = null;
  checkoutCreateDelayMs = 0;
  checkoutCreateCalls.length = 0;
});

let eventCounter = 0;
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A Stripe event envelope. Each call is a NEW event unless an id is given. */
function envelope(type: string, object: unknown, options: { id?: string; created?: number } = {}) {
  eventCounter += 1;
  return {
    id: options.id ?? `evt_${Date.now()}_${eventCounter}`,
    type,
    livemode: false,
    created: options.created ?? nowSeconds(),
    data: { object },
  };
}

async function withApp<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  // The real server mounts a raw body parser for the webhook; `constructEvent`
  // is stubbed, so any body reaches the handler intact.
  app.use('/billing/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/billing', await loadBillingRoutes());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** POST one already-verified Stripe event at the real webhook route. */
async function postWebhook(event: unknown): Promise<number> {
  return withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=stub' },
      body: JSON.stringify(event),
    });
    return response.status;
  });
}

/** An account with a credit row and a known Stripe customer id. */
async function account(stripeCustomerId?: string): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  await getDb()
    .insert(userCredits)
    .values({ userId: user.id, creditsFree: 0, creditsPaid: 0, stripeCustomerId });
  return user.id;
}

async function paidBalance(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ paid: userCredits.creditsPaid })
    .from(userCredits)
    .where(eq(userCredits.userId, userId));
  return row.paid;
}

async function receipts(userId: string, type: 'credit_purchase' | 'subscription_payment') {
  return getDb()
    .select()
    .from(billingTransactions)
    .where(and(eq(billingTransactions.userId, userId), eq(billingTransactions.type, type)));
}

async function eventRow(eventId: string) {
  const [row] = await getDb()
    .select()
    .from(billingStripeEvents)
    .where(eq(billingStripeEvents.stripeEventId, eventId));
  return row;
}

async function mirrorOf(subscriptionId: string) {
  const [row] = await getDb()
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId));
  return row;
}

// ---------------------------------------------------------------------------
// One-off credit purchases
// ---------------------------------------------------------------------------

function checkoutEvent(userId: string, paymentIntentId: string) {
  return envelope('checkout.session.completed', {
    id: `cs_${paymentIntentId}`,
    customer: 'cus_test',
    payment_intent: paymentIntentId,
    amount_total: 500,
    currency: 'usd',
    metadata: {
      userId,
      type: 'credit_purchase',
      packageId: 'credits_1000',
      credits: '1000',
    },
  });
}

describe('checkout.session.completed replay', () => {
  it('grants the credits exactly once no matter how often Stripe redelivers', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, `pi_${userId}`);

    for (let delivery = 0; delivery < 3; delivery += 1) {
      expect(await postWebhook(event)).toBe(200);
      expect(await paidBalance(userId)).toBe(1000);
      expect(await receipts(userId, 'credit_purchase')).toHaveLength(1);
    }

    const recorded = await eventRow(event.id);
    expect(recorded.attempts).toBe(3);
    expect(recorded.outcome).toBe('processed');
  });

  it('does not let CONCURRENT redeliveries both grant', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, `pi_concurrent_${userId}`);

    // A JavaScript-only guard — read, decide, write — passes the sequential case
    // above and fails HERE: both requests would find no receipt and both grant.
    const statuses = await Promise.all([postWebhook(event), postWebhook(event), postWebhook(event)]);

    expect(statuses.every((status) => status === 200 || status === 500)).toBe(true);
    expect(await paidBalance(userId)).toBe(1000);
    expect(await receipts(userId, 'credit_purchase')).toHaveLength(1);
  });

  it('grants separately for two DIFFERENT purchases by the same account', async () => {
    const userId = await account();

    expect(await postWebhook(checkoutEvent(userId, `pi_first_${userId}`))).toBe(200);
    expect(await postWebhook(checkoutEvent(userId, `pi_second_${userId}`))).toBe(200);

    expect(await paidBalance(userId)).toBe(2000);
    expect(await receipts(userId, 'credit_purchase')).toHaveLength(2);
  });

  it('refuses to grant when the session carries no payment intent', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, 'unused');
    (event.data.object as { payment_intent: unknown }).payment_intent = null;

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(0);
    expect(await receipts(userId, 'credit_purchase')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Subscriptions: the provider-read mirror and invoice-backed renewals
// ---------------------------------------------------------------------------

let subscriptionCounter = 0;

/** A subscriber: an account, a Stripe customer and Stripe's subscription state. */
async function subscriber(options: { priceId?: string; periodStart?: number } = {}) {
  subscriptionCounter += 1;
  const subscriptionId = `sub_${Date.now()}_${subscriptionCounter}`;
  const customerId = `cus_${subscriptionId}`;
  const userId = await account(customerId);
  const periodStart = options.periodStart ?? nowSeconds() - 2 * HOUR;
  setStripeSubscription(subscriptionId, customerId, {
    priceId: options.priceId ?? PRO_PRICE_ID,
    periodStart,
    status: 'active',
  });
  return { userId, subscriptionId, customerId, periodStart };
}

function setStripeSubscription(
  subscriptionId: string,
  customerId: string,
  state: { priceId?: string; periodStart: number; status: string; cancelAtPeriodEnd?: boolean }
) {
  stripeSubscriptions.set(subscriptionId, {
    id: subscriptionId,
    livemode: false,
    customer: customerId,
    status: state.status,
    cancel_at_period_end: state.cancelAtPeriodEnd ?? false,
    items: {
      has_more: false,
      data: [
        {
          price: { id: state.priceId ?? PRO_PRICE_ID },
          current_period_start: state.periodStart,
          current_period_end: state.periodStart + MONTH,
        },
      ],
    },
  });
}

/** A subscription event. Its payload is deliberately NOT what the handler mirrors. */
function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
  subscriptionId: string,
  customerId: string,
  payload: { status?: string; created?: number } = {}
) {
  return envelope(
    type,
    {
      id: subscriptionId,
      customer: customerId,
      status: payload.status ?? 'active',
      cancel_at_period_end: false,
      items: { data: [{ price: { id: PRO_PRICE_ID }, current_period_start: 0, current_period_end: 1 }] },
    },
    { created: payload.created }
  );
}

let invoiceCounter = 0;

function invoiceEvent(
  sub: { subscriptionId: string; customerId: string; periodStart: number },
  options: {
    type?: 'invoice.paid' | 'invoice.payment_failed';
    invoiceId?: string;
    status?: string;
    billingReason?: string;
    priceId?: string;
    currency?: string;
    amountPaid?: number;
    periodStart?: number;
  } = {}
) {
  invoiceCounter += 1;
  const periodStart = options.periodStart ?? sub.periodStart;
  const event = envelope(options.type ?? 'invoice.paid', {
    id: options.invoiceId ?? `in_${Date.now()}_${invoiceCounter}`,
    object: 'invoice', livemode: false, status_transitions: { paid_at: nowSeconds() },
    customer: sub.customerId,
    status: options.status ?? 'paid',
    billing_reason: options.billingReason ?? 'subscription_cycle',
    currency: options.currency ?? 'usd',
    amount_paid: options.amountPaid ?? PRO_PRICE,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: sub.subscriptionId },
    },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${invoiceCounter}`,
          amount: options.amountPaid ?? PRO_PRICE,
          currency: options.currency ?? 'usd',
          quantity: 1,
          parent: { type: 'subscription_item_details', subscription_item_details: {
            subscription: sub.subscriptionId, subscription_item: 'si_test', proration: false,
          } },
          period: { start: periodStart, end: periodStart + MONTH },
          pricing: {
            type: 'price_details',
            price_details: { price: options.priceId ?? PRO_PRICE_ID, product: 'prod_test' },
          },
        },
      ],
    },
  });
  const object = event.data.object; currentInvoices.set(object.id, object);
  return event;
}

describe('invoice.paid — renewal credits on the evidence of payment', () => {
  it('grants on a FIRST delivery that arrives hours after the period started', async () => {
    // The old path granted only within five minutes of the period start, so this
    // delivery — a webhook backlog, an outage, a retry schedule — granted nothing.
    const sub = await subscriber({ periodStart: nowSeconds() - 6 * HOUR });
    const event = invoiceEvent(sub);

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);

    const [receipt] = await receipts(sub.userId, 'subscription_payment');
    expect(receipt).toMatchObject({
      stripeSubscriptionId: sub.subscriptionId,
      stripeInvoiceId: (event.data.object as { id: string }).id,
      amountMinorUnits: PRO_PRICE,
      currency: 'usd',
      credits: PRO_CREDITS,
    });
    expect(receipt.stripeSubscriptionPeriodStart?.getTime()).toBe(sub.periodStart * 1000);
    expect((await eventRow(event.id)).outcome).toBe('granted');
  });

  it('grants once per period across replays, a re-sent invoice event and concurrency', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub, { invoiceId: `in_replay_${sub.subscriptionId}` });

    expect(await postWebhook(event)).toBe(200);
    expect(await postWebhook(event)).toBe(200);
    // The same invoice under a NEW event id — Stripe can resend an object.
    const resent = invoiceEvent(sub, { invoiceId: `in_replay_${sub.subscriptionId}` });
    const statuses = await Promise.all([postWebhook(resent), postWebhook(resent)]);
    expect(statuses.every((status) => status === 200 || status === 500)).toBe(true);

    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('grants each NEW period once', async () => {
    const sub = await subscriber({ periodStart: nowSeconds() - MONTH - HOUR });

    expect(await postWebhook(invoiceEvent(sub, { billingReason: 'subscription_create' }))).toBe(200);
    expect(await postWebhook(invoiceEvent(sub, { periodStart: sub.periodStart + MONTH }))).toBe(200);

    expect(await paidBalance(sub.userId)).toBe(2 * PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(2);
  });

  it('a crash between receipt and grant leaves nothing behind, and the redelivery grants once', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);

    failNextGrant = true;
    expect(await postWebhook(event)).toBe(500);
    expect(await paidBalance(sub.userId)).toBe(0);
    // The receipt rolled back with the failed grant, so it cannot suppress the retry.
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
    expect(await eventRow(event.id)).toMatchObject({ outcome: 'failed', attempts: 1 });

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await eventRow(event.id)).toMatchObject({ outcome: 'granted', attempts: 2 });
  });

  it('does not grant a period that the previous path already granted', async () => {
    // Deploy transition: a period granted from `customer.subscription.updated`
    // before this change has a receipt without an invoice id. Its paid invoice,
    // arriving afterwards, must recognise the period and grant nothing more.
    const sub = await subscriber();
    await getDb().insert(billingTransactions).values({
      userId: sub.userId,
      stripeCustomerId: sub.customerId,
      stripeSubscriptionId: sub.subscriptionId,
      stripeSubscriptionPeriodStart: new Date(sub.periodStart * 1000),
      type: 'subscription_payment',
      amountMinorUnits: PRO_PRICE,
      currency: 'usd',
      credits: PRO_CREDITS,
      status: 'completed',
    });

    const event = invoiceEvent(sub);
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
    expect((await eventRow(event.id)).outcome).toBe('duplicate');
  });

  it.each([
    ['a failed payment', { type: 'invoice.payment_failed' as const, status: 'open' }, 'invoice payment failed'],
    ['an invoice that is not paid', { status: 'open' }, 'invoice status is open'],
    ['a currency that is not the plan currency', { currency: 'eur' }, 'invoice currency eur'],
    ['an invoice that collected nothing', { amountPaid: 0 }, 'zero-amount invoice without a declared promotion'],
    ['a price this API does not sell', { priceId: 'price_unknown' }, 'no invoice line'],
  ])('grants nothing for %s, and records why', async (_label, options, reason) => {
    const sub = await subscriber();
    const event = invoiceEvent(sub, options);

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);

    const recorded = await eventRow(event.id);
    expect(recorded.outcome).toBe('not_granted');
    expect(recorded.outcomeDetail).toContain(reason);
  });

  it('resending a refused event after the cause is fixed grants it — once', async () => {
    // The runbook's recovery path: the customer was not linked to an account
    // when Stripe delivered, so the invoice was refused; once the link exists,
    // resending the SAME event re-evaluates it.
    const sub = await subscriber();
    await getDb()
      .update(userCredits)
      .set({ stripeCustomerId: null })
      .where(eq(userCredits.userId, sub.userId));
    const event = invoiceEvent(sub);

    expect(await postWebhook(event)).toBe(200);
    expect(await eventRow(event.id)).toMatchObject({ outcome: 'not_granted' });
    expect(await paidBalance(sub.userId)).toBe(0);

    await getDb()
      .update(userCredits)
      .set({ stripeCustomerId: sub.customerId })
      .where(eq(userCredits.userId, sub.userId));
    expect(await postWebhook(event)).toBe(200);
    expect(await postWebhook(event)).toBe(200);

    expect(await eventRow(event.id)).toMatchObject({ outcome: 'granted', attempts: 3 });
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('records what the invoice COLLECTED, and keeps a catalogue difference visible', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub, { amountPaid: 1500 });

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    const [receipt] = await receipts(sub.userId, 'subscription_payment');
    expect(receipt.amountMinorUnits).toBe(1500);
    expect((await eventRow(event.id)).outcomeDetail).toContain('differs from plan price');
  });

  it('an unassociated charge leaves credits unchanged and cannot reopen the period', async () => {
    const sub = await subscriber();
    const paid = invoiceEvent(sub);
    expect(await postWebhook(paid)).toBe(200);

    const refund = envelope('charge.refunded', { id: `ch_${sub.subscriptionId}`, amount_refunded: PRO_PRICE });
    expect(await postWebhook(refund)).toBe(200);
    expect((await eventRow(refund.id)).outcome).toBe('ignored');

    // A late replay of the paid invoice after the refund must not grant again.
    expect(await postWebhook(paid)).toBe(200);
    expect(await postWebhook(invoiceEvent(sub))).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('keeps two subscriptions of one account independent', async () => {
    const pro = await subscriber();
    const business = await subscriber({ priceId: BUSINESS_PRICE_ID });
    // Same account for both: move the business customer onto the pro account.
    await getDb().delete(userCredits).where(eq(userCredits.userId, business.userId));
    const businessState = stripeSubscriptions.get(business.subscriptionId);
    if (!businessState) throw new Error('fixture subscription unavailable');
    businessState.customer = pro.customerId;
    const businessOnPro = { ...business, customerId: pro.customerId };

    expect(await postWebhook(invoiceEvent(pro))).toBe(200);
    expect(
      await postWebhook(
        invoiceEvent(businessOnPro, { priceId: BUSINESS_PRICE_ID, amountPaid: BUSINESS_PRICE })
      )
    ).toBe(200);
    expect(await paidBalance(pro.userId)).toBe(PRO_CREDITS + BUSINESS_CREDITS);

    // Both mirrored, then ONE is cancelled at Stripe: the other is untouched.
    expect(await postWebhook(subscriptionEvent('customer.subscription.created', pro.subscriptionId, pro.customerId))).toBe(200);
    expect(
      await postWebhook(subscriptionEvent('customer.subscription.created', business.subscriptionId, pro.customerId))
    ).toBe(200);
    setStripeSubscription(business.subscriptionId, pro.customerId, {
      priceId: BUSINESS_PRICE_ID,
      periodStart: business.periodStart,
      status: 'canceled',
    });
    expect(
      await postWebhook(subscriptionEvent('customer.subscription.deleted', business.subscriptionId, pro.customerId))
    ).toBe(200);

    expect((await mirrorOf(business.subscriptionId)).status).toBe('canceled');
    expect((await mirrorOf(pro.subscriptionId)).status).toBe('active');
    expect(await paidBalance(pro.userId)).toBe(PRO_CREDITS + BUSINESS_CREDITS);
  });
});

describe('customer.subscription.* — the mirror follows the provider, never grants', () => {
  it('no longer grants from a subscription event at the period start', async () => {
    const sub = await subscriber({ periodStart: nowSeconds() });

    expect(await postWebhook(subscriptionEvent('customer.subscription.updated', sub.subscriptionId, sub.customerId))).toBe(200);

    // The mirror moved; no payment was evidenced, so no credits.
    expect((await mirrorOf(sub.subscriptionId)).status).toBe('active');
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
  });

  it('an OLDER event arriving after a newer one cannot roll the mirror back', async () => {
    const sub = await subscriber();

    // Stripe's current truth: cancelled.
    setStripeSubscription(sub.subscriptionId, sub.customerId, {
      periodStart: sub.periodStart,
      status: 'canceled',
    });
    const newer = subscriptionEvent('customer.subscription.deleted', sub.subscriptionId, sub.customerId, {
      status: 'canceled',
    });
    const older = subscriptionEvent('customer.subscription.updated', sub.subscriptionId, sub.customerId, {
      status: 'active',
      created: newer.created - 60,
    });

    expect(await postWebhook(newer)).toBe(200);
    expect(await postWebhook(older)).toBe(200);

    // The late `active` payload is never mirrored: the state is Stripe's.
    expect((await mirrorOf(sub.subscriptionId)).status).toBe('canceled');
  });

  it('a slow provider read that started first cannot overwrite a later one', async () => {
    const sub = await subscriber();
    expect(await postWebhook(subscriptionEvent('customer.subscription.created', sub.subscriptionId, sub.customerId))).toBe(200);

    // Delivery A reads Stripe while the subscription is still active, then stalls.
    let release!: () => void;
    holdNextRetrieve = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = postWebhook(subscriptionEvent('customer.subscription.updated', sub.subscriptionId, sub.customerId));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Meanwhile it is cancelled, and delivery B reads and mirrors that.
    setStripeSubscription(sub.subscriptionId, sub.customerId, {
      periodStart: sub.periodStart,
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    const fastEvent = subscriptionEvent('customer.subscription.updated', sub.subscriptionId, sub.customerId);
    expect(await postWebhook(fastEvent)).toBe(200);
    expect((await mirrorOf(sub.subscriptionId)).cancelAtPeriodEnd).toBe(true);

    // A finally answers with its older read — and must not win.
    release();
    expect(await slow).toBe(200);
    expect((await mirrorOf(sub.subscriptionId)).cancelAtPeriodEnd).toBe(true);
  });

  it('cancellation at period end keeps access until Stripe ends it, and grants nothing', async () => {
    const sub = await subscriber();
    expect(await postWebhook(invoiceEvent(sub))).toBe(200);

    setStripeSubscription(sub.subscriptionId, sub.customerId, {
      periodStart: sub.periodStart,
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(await postWebhook(subscriptionEvent('customer.subscription.updated', sub.subscriptionId, sub.customerId))).toBe(200);
    expect(await mirrorOf(sub.subscriptionId)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });

    setStripeSubscription(sub.subscriptionId, sub.customerId, {
      periodStart: sub.periodStart,
      status: 'canceled',
      cancelAtPeriodEnd: true,
    });
    expect(await postWebhook(subscriptionEvent('customer.subscription.deleted', sub.subscriptionId, sub.customerId))).toBe(200);
    expect((await mirrorOf(sub.subscriptionId)).status).toBe('canceled');

    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('a deletion still reaches the mirror when the price is no longer in the catalogue', async () => {
    const sub = await subscriber();
    expect(await postWebhook(subscriptionEvent('customer.subscription.created', sub.subscriptionId, sub.customerId))).toBe(200);

    setStripeSubscription(sub.subscriptionId, sub.customerId, {
      priceId: 'price_retired',
      periodStart: sub.periodStart,
      status: 'canceled',
    });
    const event = subscriptionEvent('customer.subscription.deleted', sub.subscriptionId, sub.customerId);
    expect(await postWebhook(event)).toBe(200);

    // A frozen `active` here would keep granting premium to someone who left.
    expect(await mirrorOf(sub.subscriptionId)).toMatchObject({ status: 'canceled', planName: 'Pro' });
    expect((await eventRow(event.id)).outcome).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// Checkout idempotency
// ---------------------------------------------------------------------------

async function postCheckout(
  userId: string,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string; timeoutMs?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> } | 'timed-out'> {
  return withApp(async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/billing/checkout/subscription`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user': userId,
          ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') {
        // Let the server finish the request the client gave up on.
        await new Promise((resolve) => setTimeout(resolve, checkoutCreateDelayMs + 100));
        return 'timed-out';
      }
      throw error;
    }
  });
}

const CHECKOUT_BODY = {
	planId: "pro_monthly",
	successUrl: "https://oxy.so/billing/success",
	cancelUrl: "https://oxy.so/billing/cancel",
};

describe('POST /billing/checkout/subscription — Idempotency-Key', () => {
  it('a retry after a client timeout returns the session already created, not a second one', async () => {
    const userId = await account();
    checkoutCreateDelayMs = 300;

    const first = await postCheckout(userId, CHECKOUT_BODY, { idempotencyKey: 'retry-1', timeoutMs: 50 });
    expect(first).toBe('timed-out');
    const sessionsAfterTimeout = new Set([...checkoutSessionsByKey.values()].map((entry) => entry.session.id));

    checkoutCreateDelayMs = 0;
    const retry = await postCheckout(userId, CHECKOUT_BODY, { idempotencyKey: 'retry-1' });
    expect(retry).not.toBe('timed-out');
    if (retry === 'timed-out') return;
    expect(retry.status).toBe(200);
    expect(sessionsAfterTimeout.has(retry.body.sessionId as string)).toBe(true);

    // Both calls reached Stripe under ONE account-scoped key.
    const keys = checkoutCreateCalls.map((call) => (call.options as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual([
      `oxy:checkout:subscription:${userId}:retry-1`,
      `oxy:checkout:subscription:${userId}:retry-1`,
    ]);
  });

  it('the same key with different parameters is a conflict, not a second session', async () => {
    const userId = await account();
    const first = await postCheckout(userId, CHECKOUT_BODY, { idempotencyKey: 'conflict-1' });
    expect(first).toMatchObject({ status: 200 });

    const conflicting = await postCheckout(
      userId,
      { ...CHECKOUT_BODY, successUrl: 'https://oxy.so/elsewhere' },
      { idempotencyKey: 'conflict-1' }
    );
    expect(conflicting).toMatchObject({ status: 409, body: { error: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('one account cannot replay another account\'s key', async () => {
    const alice = await account();
    const bob = await account();

    const a = await postCheckout(alice, CHECKOUT_BODY, { idempotencyKey: 'shared' });
    const b = await postCheckout(bob, CHECKOUT_BODY, { idempotencyKey: 'shared' });
    if (a === 'timed-out' || b === 'timed-out') throw new Error('unexpected timeout');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.sessionId).not.toBe(b.body.sessionId);
  });

  it('rejects a malformed key, and stays non-idempotent without one', async () => {
    const userId = await account();
    const malformed = await postCheckout(userId, CHECKOUT_BODY, { idempotencyKey: 'x'.repeat(151) });
    expect(malformed).toMatchObject({ status: 400, body: { error: 'INVALID_IDEMPOTENCY_KEY' } });

    const plain = await postCheckout(userId, CHECKOUT_BODY);
    expect(plain).toMatchObject({ status: 200 });
    expect(checkoutCreateCalls.at(-1)?.options).toBeUndefined();
  });
});

describe('historical invoice.paid API shape recovery', () => {
  async function historicalFixture() {
    const sub = await subscriber();
    const modern = invoiceEvent(sub);
    const current = { ...modern.data.object, object: 'invoice', livemode: false };
    currentInvoices.set(current.id, current);
    const legacy = {
      ...modern, livemode: false,
      data: { object: {
        ...modern.data.object, parent: undefined, subscription: sub.subscriptionId,
        lines: { has_more: false, data: [{ id: 'il_legacy', price: { id: PRO_PRICE_ID },
          subscription: sub.subscriptionId, type: 'subscription', proration: false }] },
      } },
    };
    return { sub, current, legacy };
  }

  it('retrieves historical evidence in the current API shape and grants exactly once across old/current replays', async () => {
    const { sub, legacy, current } = await historicalFixture();
    expect(await postWebhook(legacy)).toBe(200);
    expect(await postWebhook(legacy)).toBe(200);
    expect(await postWebhook(envelope('invoice.paid', current))).toBe(200);
    expect(invoiceRetrieveCalls).toEqual([current.id]);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('retries a timed-out provider read without a receipt or grant', async () => {
    const { sub, legacy } = await historicalFixture();
    failNextInvoiceRetrieve = true;
    expect(await postWebhook(legacy)).toBe(500);
    expect((await eventRow(legacy.id)).outcome).toBe('failed');
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
    expect(await postWebhook(legacy)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it.each(['id', 'mode', 'customer', 'subscription'] as const)('refuses contradictory retrieved %s, then allows the corrected redelivery', async (kind) => {
    const { sub, legacy, current } = await historicalFixture();
    const changed = structuredClone(current);
    if (kind === 'id') changed.id = 'in_other';
    if (kind === 'mode') changed.livemode = true;
    if (kind === 'customer') changed.customer = 'cus_other';
    if (kind === 'subscription') changed.parent.subscription_details.subscription = 'sub_other';
    currentInvoices.set(current.id, changed);
    expect(await postWebhook(legacy)).toBe(500);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
    currentInvoices.set(current.id, current);
    expect(await postWebhook(legacy)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
  });

  it('uses current event evidence directly', async () => {
    const sub = await subscriber();
    expect(await postWebhook(invoiceEvent(sub))).toBe(200);
    expect(invoiceRetrieveCalls).toEqual([]);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
  });

  it.each([null, 'same-subscription'] as const)('accepts modern delivery with the nullable compatibility subscription field %s without retrieval', async compatibility => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const current = { ...event.data.object, lines: { ...event.data.object.lines,
      data: event.data.object.lines.data.map(line => ({ ...line,
        subscription: compatibility === null ? null : sub.subscriptionId })),
    } };
    const modernEvent = { ...event, data: { object: current } };
    expect(await postWebhook(modernEvent)).toBe(200);
    expect(await postWebhook(modernEvent)).toBe(200);
    expect(invoiceRetrieveCalls).toEqual([]);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it.each([null, 'same-subscription'] as const)('accepts retrieved modern lines retaining compatibility subscription %s', async compatibility => {
    const { sub, legacy, current } = await historicalFixture();
    currentInvoices.set(current.id, { ...current, lines: { ...current.lines,
      data: current.lines.data.map(line => ({ ...line,
        subscription: compatibility === null ? null : sub.subscriptionId })),
    } });
    expect(await postWebhook(legacy)).toBe(200);
    expect(await postWebhook(legacy)).toBe(200);
    expect(invoiceRetrieveCalls).toEqual([current.id]);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  });

  it('ignores a modern non-subscription invoice with nullable parent/pricing without retrieval', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const modernEvent = { ...event, data: { object: { ...event.data.object, parent: null,
      lines: { ...event.data.object.lines, data: [{ ...event.data.object.lines.data[0],
        subscription: null, parent: null, pricing: null }] },
    } } };
    expect(await postWebhook(modernEvent)).toBe(200);
    expect(invoiceRetrieveCalls).toEqual([]);
    expect((await eventRow(event.id)).outcome).toBe('ignored');
    expect(await paidBalance(sub.userId)).toBe(0);
  });
});

describe('invoice.paid complete recurring-line reconciliation', () => {
  it('skips a known-price proration before the genuine recurring line', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const invoice = event.data.object;
    const regular = invoice.lines.data[0];
    invoice.lines.data.unshift({ ...regular, id: 'il_proration', period: { start: sub.periodStart + HOUR, end: sub.periodStart + MONTH }, parent: { ...regular.parent, subscription_item_details: { ...regular.parent.subscription_item_details, proration: true } } });
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect((await receipts(sub.userId, 'subscription_payment'))[0].stripeSubscriptionPeriodStart?.getTime()).toBe(sub.periodStart * 1000);
  });
  it('finds the recurring line on the second page', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const invoice = event.data.object;
    const regular = invoice.lines.data[0];
    invoice.lines.data = [{ ...regular, id: 'il_extra', parent: { type: 'invoice_item_details' } } as typeof regular];
    invoice.lines.has_more = true;
    invoiceLinePages.set(invoice.id, [{ data: [regular], has_more: false }]);
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
    expect(invoiceLineCalls).toEqual([{ id: invoice.id, cursor: 'il_extra' }]);
  });
  it('refuses differing recurring periods hidden beyond the first page', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const invoice = event.data.object;
    invoice.lines.has_more = true;
    const regular = invoice.lines.data[0];
    invoiceLinePages.set(invoice.id, [{ data: [{ ...regular, id: 'il_wrong_period', period: { start: sub.periodStart - MONTH, end: sub.periodStart } }], has_more: false }]);
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect((await eventRow(event.id)).outcomeDetail).toMatch(/ambiguous/);
  });
  it.each(['proration', 'unrelated', 'quantity', 'period', 'line_currency'])('rejects invalid recurring evidence: %s', async (kind) => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const line = event.data.object.lines.data[0];
    if (kind === 'proration') line.parent.subscription_item_details.proration = true;
    if (kind === 'unrelated') line.parent.subscription_item_details.subscription = 'sub_other';
    if (kind === 'quantity') line.quantity = 2;
    if (kind === 'period') line.period.end = line.period.start;
    if (kind === 'line_currency') line.currency = 'eur';
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
  });
  it('pagination failure is retryable and leaves no grant', async () => {
    const sub = await subscriber();
    const event = invoiceEvent(sub);
    const invoice = event.data.object;
    invoice.lines.has_more = true;
    expect(await postWebhook(event)).toBe(500);
    expect(await paidBalance(sub.userId)).toBe(0);
    expect((await eventRow(event.id)).outcome).toBe('failed');
    invoiceLinePages.set(invoice.id, [{ data: [], has_more: false }]);
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
  });
});

function upgradeInvoice(sub: { subscriptionId: string; customerId: string; periodStart: number }, day: number, invoiceId: string) {
  const event = invoiceEvent(sub, { invoiceId, billingReason: 'subscription_update', amountPaid: 6000 });
  const original = event.data.object.lines.data[0];
  const remaining = { start: sub.periodStart + day * 86_400, end: sub.periodStart + MONTH };
  event.data.object.status_transitions.paid_at = remaining.start;
  event.data.object.lines.data = [
    { ...structuredClone(original), id: `${original.id}_old`, amount: -1000, period: remaining,
      parent: { ...original.parent, subscription_item_details: { ...original.parent.subscription_item_details, proration: true } } },
    { ...structuredClone(original), id: `${original.id}_new`, amount: 7000, period: remaining,
      pricing: { ...original.pricing, price_details: { ...original.pricing.price_details, price: BUSINESS_PRICE_ID } },
      parent: { ...original.parent, subscription_item_details: { ...original.parent.subscription_item_details, proration: true } } },
  ];
  currentInvoices.set(event.data.object.id, event.data.object);
  return event;
}
function refundEventFor(paid: ReturnType<typeof invoiceEvent>, amountRefunded: number) {
  const invoice = paid.data.object; const intentId = `pi_${invoice.id}`; const chargeId = `ch_${invoice.id}`;
  const charge = { id: chargeId, object: 'charge', livemode: false, payment_intent: intentId, customer: invoice.customer,
    amount: invoice.amount_paid, currency: invoice.currency, amount_refunded: amountRefunded, paid: true, captured: true };
  currentCharges.set(chargeId, charge);
  invoicePayments.set(`ip_${invoice.id}`, { id: `ip_${invoice.id}`, invoice: invoice.id, livemode: false, status: 'paid',
    amount_paid: invoice.amount_paid, currency: invoice.currency, payment: { type: 'payment_intent', payment_intent: intentId } });
  return envelope('charge.refunded', structuredClone(charge));
}

describe('approved P1/P2/P3 through actual webhook transactions', () => {
  it('upgrades before a late base reserve it, match the opposite delivery order, and never grant a second invoice receipt', async () => {
    for (const reverse of [false, true]) {
      const sub = await subscriber(); const base = invoiceEvent(sub);
      const upgrade = upgradeInvoice(sub, 10, `in_upgrade_${sub.subscriptionId}`);
      const events = reverse ? [base, upgrade] : [upgrade, base];
      expect(await postWebhook(events[0])).toBe(200);
      expect(await paidBalance(sub.userId)).toBe(reverse ? 10_000 : 26_666);
      expect(await postWebhook(events[1])).toBe(200);
      expect(await paidBalance(sub.userId)).toBe(36_666);
      expect(await postWebhook(envelope('invoice.paid', upgrade.data.object))).toBe(200);
      expect(await paidBalance(sub.userId)).toBe(36_666);
      expect(await receipts(sub.userId, 'subscription_proration')).toHaveLength(1);
    }
  });
  it('inverted distinct upgrades use canonical cap assignments and base arrives last', async () => {
    const sub = await subscriber(); const base = invoiceEvent(sub);
    const a = upgradeInvoice(sub, 1, `in_a_${sub.subscriptionId}`);
    const b = upgradeInvoice(sub, 2, `in_b_${sub.subscriptionId}`);
    expect(await postWebhook(b)).toBe(200); expect(await paidBalance(sub.userId)).toBe(1_334);
    expect(await postWebhook(a)).toBe(200); expect(await postWebhook(base)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(50_000);
    const rows = await receipts(sub.userId, 'subscription_proration');
    expect(rows.map(row => row.credits).sort((x,y) => x-y)).toEqual([1_334, 38_666]);
  });
  it('backdated provider evidence that would change a frozen grant refuses before receipts or credits change', async () => {
    const sub = await subscriber(); invoiceEvent(sub);
    const b = upgradeInvoice(sub, 2, `in_b_${sub.subscriptionId}`);
    upgradeInvoice(sub, 3, `in_c_${sub.subscriptionId}`);
    expect(await postWebhook(b)).toBe(200);
    const before = await paidBalance(sub.userId); const beforeRows = await receipts(sub.userId, 'subscription_proration');
    const a = upgradeInvoice(sub, 1, `in_a_${sub.subscriptionId}`);
    expect(await postWebhook(a)).toBe(500);
    expect(await paidBalance(sub.userId)).toBe(before);
    expect(await receipts(sub.userId, 'subscription_proration')).toEqual(beforeRows);
    expect((await eventRow(a.id)).outcomeDetail).toContain('frozen');
  });
  it('missing paid base and mismatched quantities refuse incomplete evidence with no balance changes', async () => {
    const sub = await subscriber(); const upgrade = upgradeInvoice(sub, 10, `in_upgrade_${sub.subscriptionId}`);
    expect(await postWebhook(upgrade)).toBe(500); expect(await paidBalance(sub.userId)).toBe(0);
    invoiceEvent(sub); upgrade.data.object.lines.data[0].quantity = 2;
    expect(await postWebhook(upgrade)).toBe(500); expect(await paidBalance(sub.userId)).toBe(0);
    expect(await receipts(sub.userId, 'subscription_proration')).toHaveLength(0);
  });
  it('refund clawback touches only unconsumed attributable grants, preserves purchase balance and handles reversed deliveries', async () => {
    const sub = await subscriber(); const paid = invoiceEvent(sub);
    await getDb().update(userCredits).set({ creditsPaid: 5000 }).where(eq(userCredits.userId, sub.userId));
    expect(await postWebhook(paid)).toBe(200); expect(await deductCredits(getDb(), sub.userId, 800)).toBe(true);
    const partial = refundEventFor(paid, 1000); expect(await postWebhook(partial)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(10_866);
    const full = refundEventFor(paid, PRO_PRICE); expect(await postWebhook(full)).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(5000);
    expect(await postWebhook(partial)).toBe(200); expect(await postWebhook(full)).toBe(200);
    const [grant] = await getDb().select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, sub.userId));
    expect(grant).toMatchObject({ granted: 10_000, consumed: 800, clawed: 9200 });
    expect(await paidBalance(sub.userId)).toBe(5000);
  });
  it('refund before first grant stores the cumulative snapshot and awards the same rounded net amount', async () => {
    const sub = await subscriber(); const paid = invoiceEvent(sub); const refund = refundEventFor(paid, 1000);
    expect(await postWebhook(refund)).toBe(200); expect(await paidBalance(sub.userId)).toBe(0);
    expect(await postWebhook(paid)).toBe(200); expect(await paidBalance(sub.userId)).toBe(6666);
    const [grant] = await getDb().select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, sub.userId));
    expect(grant).toMatchObject({ granted: 10_000, consumed: 0, clawed: 3334 });
    expect(await postWebhook(refund)).toBe(200); expect(await paidBalance(sub.userId)).toBe(6666);
  });
  it('multiple payment allocations reject rather than debiting an unrelated grant', async () => {
    const sub = await subscriber(); const paid = invoiceEvent(sub); expect(await postWebhook(paid)).toBe(200);
    const refund = refundEventFor(paid, PRO_PRICE);
    const allocation = invoicePayments.get(`ip_${paid.data.object.id}`);
    if (!allocation) throw new Error('fixture payment missing');
    invoicePayments.set('ip_other', { ...allocation, id: 'ip_other' });
    expect(await postWebhook(refund)).toBe(500); expect(await paidBalance(sub.userId)).toBe(10_000);
    expect(await getDb().select().from(billingCreditRefundObservations).where(eq(billingCreditRefundObservations.userId, sub.userId))).toHaveLength(0);
  });
  it('paid downgrade and undeclared zero-amount promotion grant nothing and never claw back a period', async () => {
    const sub = await subscriber(); const base = invoiceEvent(sub); expect(await postWebhook(base)).toBe(200);
    expect(await postWebhook(invoiceEvent(sub, { billingReason: 'subscription_update', amountPaid: 0 }))).toBe(200);
    expect(await postWebhook(invoiceEvent(sub, { amountPaid: 0 }))).toBe(200);
    expect(await paidBalance(sub.userId)).toBe(10_000); expect(await receipts(sub.userId, 'subscription_promotional_grant')).toHaveLength(0);
  });
});

it('a new delivery of an old upgrade invoice recognizes the frozen receipt after current renewal and cancellation', async () => {
  const sub = await subscriber(); invoiceEvent(sub); const upgrade = upgradeInvoice(sub, 10, `in_${sub.subscriptionId}_old`);
  expect(await postWebhook(upgrade)).toBe(200);
  setStripeSubscription(sub.subscriptionId, sub.customerId, { periodStart: sub.periodStart + MONTH, status: 'canceled', priceId: BUSINESS_PRICE_ID });
  expect(await postWebhook(envelope('invoice.paid', upgrade.data.object))).toBe(200);
  expect(await paidBalance(sub.userId)).toBe(26_666);
  expect(await receipts(sub.userId, 'subscription_proration')).toHaveLength(1);
});
it('a purchased/auto-recharge charge without invoice allocation is ignored rather than retried or clawed back', async () => {
  const userId = await account();
  await getDb().update(userCredits).set({ creditsPaid: 5000 }).where(eq(userCredits.userId, userId));
  const charge = { id: `ch_${userId}`, livemode: false, payment_intent: `pi_${userId}` };
  currentCharges.set(charge.id, charge);
  const event = envelope('charge.refunded', charge);
  expect(await postWebhook(event)).toBe(200); expect((await eventRow(event.id)).outcome).toBe('ignored');
  expect(await paidBalance(userId)).toBe(5000);
});

it('concurrent new upgrade invoice deliveries serialize real financial writers under the same cap', async () => {
  const sub = await subscriber(); const base = invoiceEvent(sub);
  const a = upgradeInvoice(sub, 1, `in_a_${sub.subscriptionId}`); const b = upgradeInvoice(sub, 2, `in_b_${sub.subscriptionId}`);
  expect(await Promise.all([postWebhook(a), postWebhook(b), postWebhook(base)])).toEqual([200,200,200]);
  expect(await paidBalance(sub.userId)).toBe(50_000);
  expect((await receipts(sub.userId, 'subscription_proration')).map(row => row.credits).sort((x,y) => x-y)).toEqual([1334,38666]);
});

it('first late paid upgrade delivery uses its historical base period even after current renewal and cancellation', async () => {
  const sub = await subscriber(); const base = invoiceEvent(sub);
  const upgrade = upgradeInvoice(sub, 10, `in_${sub.subscriptionId}_late`);
  setStripeSubscription(sub.subscriptionId, sub.customerId, { periodStart: sub.periodStart + MONTH, status: 'canceled', priceId: BUSINESS_PRICE_ID });
  expect(await postWebhook(upgrade)).toBe(200); expect(await paidBalance(sub.userId)).toBe(26_666);
  expect((await mirrorOf(sub.subscriptionId)).status).toBe('canceled');
  expect((await mirrorOf(sub.subscriptionId)).currentPeriodStart.getTime()).toBe((sub.periodStart + MONTH) * 1000);
  expect(await postWebhook(base)).toBe(200); expect(await paidBalance(sub.userId)).toBe(36_666);
  expect((await mirrorOf(sub.subscriptionId)).status).toBe('canceled');
});

async function withProductCatalogue(
	run: (
		data: Awaited<ReturnType<typeof productAccessFixture>>,
	) => Promise<void>,
) {
	const f = await productAccessFixture();
	const dir = await mkdtemp(join(tmpdir(), "oxy-i07-catalogue-fixture-"));
	const previous = {
		key: process.env.STRIPE_SECRET_KEY,
		environment: process.env.BILLING_PROCESSOR_ENVIRONMENT,
		file: process.env.BILLING_PRODUCT_CATALOGUE_FILE,
	};
	const catalogue = {
		schemaVersion: 1,
		products: f.products,
		offers: f.offers,
		subscriptions: [],
		prices: [
			{
				priceId: PRO_PRICE_ID,
				providerAccountId: "acct_synthetic_billing",
				mode: "live",
				environment: "production",
				offerId: f.offers[0].id,
				offerVersion: f.offers[0].version,
				offerKind: f.offers[0].kind,
				kind: "existing_product",
				validFrom: "2000-01-01T00:00:00Z",
				validUntil: null,
				currency: "usd",
				amountMinorUnits: PRO_PRICE,
			},
		],
	};
	await writeFile(join(dir, "catalogue.json"), JSON.stringify(catalogue), {
		mode: 0o600,
	});
	process.env.STRIPE_SECRET_KEY = "sk_live_SYNTHETIC_NO_NETWORK";
	process.env.BILLING_PROCESSOR_ENVIRONMENT = "production";
	process.env.BILLING_PRODUCT_CATALOGUE_FILE = join(dir, "catalogue.json");
	productPrices.set(PRO_PRICE_ID, {
		id: PRO_PRICE_ID,
		active: true,
		livemode: true,
		type: "recurring",
		currency: "usd",
		unit_amount: PRO_PRICE,
	});
	try {
		await run(f);
	} finally {
		for (const [key, value] of Object.entries({
			STRIPE_SECRET_KEY: previous.key,
			BILLING_PROCESSOR_ENVIRONMENT: previous.environment,
			BILLING_PRODUCT_CATALOGUE_FILE: previous.file,
		})) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		productPrices.clear();
		await rm(dir, { recursive: true });
	}
}
function makeProductEvidenceLive(
	event: ReturnType<typeof invoiceEvent>,
	subscriptionId: string,
) {
	event.livemode = true;
	event.data.object.livemode = true;
	const state = stripeSubscriptions.get(subscriptionId);
	if (!state) throw new Error("fixture subscription missing");
	state.livemode = true;
}
it("combined product and credit award rollback both halves after a credit-ledger failure, then replay creates each once", async () =>
	withProductCatalogue(async (f) => {
		const sub = await subscriber();
		const paid = invoiceEvent(sub);
		makeProductEvidenceLive(paid, sub.subscriptionId);
		failNextGrant = true;
		expect(await postWebhook(paid)).toBe(500);
		expect(await paidBalance(sub.userId)).toBe(0);
		expect(await receipts(sub.userId, "subscription_payment")).toHaveLength(0);
		expect(
			await getDb()
				.select()
				.from(accessSubscriptionSources)
				.where(
					eq(
						accessSubscriptionSources.providerSubscriptionId,
						sub.subscriptionId,
					),
				),
		).toHaveLength(0);
		expect(
			await getDb()
				.select()
				.from(accessGrants)
				.where(eq(accessGrants.beneficiaryAccountId, sub.userId)),
		).toHaveLength(0);
		expect(
			await getDb()
				.select()
				.from(accessProviderPeriods)
				.where(eq(accessProviderPeriods.invoiceId, paid.data.object.id)),
		).toHaveLength(0);
		expect(await postWebhook(paid)).toBe(200);
		expect(await postWebhook(envelope("invoice.paid", paid.data.object))).toBe(
			500,
		);
		// That envelope deliberately has test mode: a contradictory delivery must fail.
		const replay = {
			...envelope("invoice.paid", paid.data.object),
			livemode: true,
		};
		expect(await postWebhook(replay)).toBe(200);
		expect(await paidBalance(sub.userId)).toBe(10_000);
		for (const product of f.products)
			expect(
				(await readSubjectProductAccess(sub.userId, product.id)).capabilities,
			).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(accessGrants)
				.where(eq(accessGrants.beneficiaryAccountId, sub.userId)),
		).toHaveLength(2);
		expect(
			await getDb()
				.select()
				.from(accessProviderPeriods)
				.where(eq(accessProviderPeriods.invoiceId, paid.data.object.id)),
		).toHaveLength(1);
	}));
it("first historical paid product invoice after renewal/cancellation keeps current access empty while granting credits once", async () =>
	withProductCatalogue(async (f) => {
		const sub = await subscriber({ periodStart: nowSeconds() - MONTH - HOUR });
		const paid = invoiceEvent(sub);
		setStripeSubscription(sub.subscriptionId, sub.customerId, {
			periodStart: sub.periodStart + MONTH,
			status: "canceled",
		});
		makeProductEvidenceLive(paid, sub.subscriptionId);
		expect(await postWebhook(paid)).toBe(200);
		expect(await paidBalance(sub.userId)).toBe(10_000);
		const [source] = await getDb()
			.select()
			.from(accessSubscriptionSources)
			.where(
				eq(
					accessSubscriptionSources.providerSubscriptionId,
					sub.subscriptionId,
				),
			);
		expect(source.status).toBe("canceled");
		expect(source.periodStart.getTime()).toBe((sub.periodStart + MONTH) * 1000);
		for (const product of f.products)
			expect(
				(await readSubjectProductAccess(sub.userId, product.id)).capabilities,
			).toEqual([]);
		const replay = {
			...envelope("invoice.paid", paid.data.object),
			livemode: true,
		};
		expect(await postWebhook(replay)).toBe(200);
		expect(await paidBalance(sub.userId)).toBe(10_000);
		expect(
			await getDb()
				.select()
				.from(accessOfferSegments)
				.where(eq(accessOfferSegments.subscriptionId, source.id)),
		).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(accessGrants)
				.where(eq(accessGrants.beneficiaryAccountId, sub.userId)),
		).toHaveLength(2);
		expect(await receipts(sub.userId, "subscription_payment")).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(accessProviderEvents)
				.where(eq(accessProviderEvents.sourceId, source.id)),
		).toHaveLength(2);
	}));

it("self-service lists multiple product sources and named cancellation preserves the other source and grants", async () =>
	withProductCatalogue(async () => {
		const first = await subscriber();
		const second = await subscriber();
		await getDb()
			.update(userCredits)
			.set({ stripeCustomerId: first.customerId })
			.where(eq(userCredits.userId, first.userId));
		const paid = invoiceEvent(first);
		makeProductEvidenceLive(paid, first.subscriptionId);
		expect(await postWebhook(paid)).toBe(200);
		const otherInvoice = invoiceEvent({
			...second,
			userId: first.userId,
			customerId: first.customerId,
		});
		const remote = stripeSubscriptions.get(second.subscriptionId);
		if (!remote) throw new Error("fixture subscription missing");
		stripeSubscriptions.set(second.subscriptionId, {
			...remote,
			customer: first.customerId,
		});
		makeProductEvidenceLive(otherInvoice, second.subscriptionId);
		expect(await postWebhook(otherInvoice)).toBe(200);
		for (const id of [first.subscriptionId, second.subscriptionId]) {
			const sync = envelope(
				"customer.subscription.updated",
				stripeSubscriptions.get(id),
			);
			sync.livemode = true;
			expect(await postWebhook(sync)).toBe(200);
		}
		await withApp(async (base) => {
			const headers = {
				"x-test-user": first.userId,
				"content-type": "application/json",
			};
			const read = await fetch(`${base}/billing/product-subscriptions`, {
				headers,
			});
			expect(read.status).toBe(200);
			expect(read.headers.get("cache-control")).toBe("no-store");
			const body = (await read.json()) as {
				subscriptions: Array<{ sourceId: string; canCancel: boolean }>;
			};
			expect(body.subscriptions).toHaveLength(2);
			expect(body.subscriptions.every((value) => value.canCancel)).toBe(true);
			const selected = body.subscriptions[0].sourceId;
			const [target] = await getDb()
				.select()
				.from(accessSubscriptionSources)
				.where(eq(accessSubscriptionSources.id, selected));
			const denied = await fetch(
				`${base}/billing/product-subscriptions/cancel`,
				{
					method: "POST",
					headers: { ...headers, "x-test-user": second.userId },
					body: JSON.stringify({ sourceId: selected }),
				},
			);
			expect(denied.status).toBe(404);
			const canceled = await fetch(
				`${base}/billing/product-subscriptions/cancel`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ sourceId: selected }),
				},
			);
			expect(canceled.status).toBe(200);
			const sources = await getDb()
				.select()
				.from(accessSubscriptionSources)
				.where(eq(accessSubscriptionSources.payerAccountId, first.userId));
			expect(
				sources
					.filter((value) => value.cancelAtPeriodEnd)
					.map((value) => value.id),
			).toEqual([selected]);
			expect(
				stripeSubscriptions.get(target.providerSubscriptionId)
					?.cancel_at_period_end,
			).toBe(true);
			expect(
				await getDb()
					.select()
					.from(accessGrants)
					.where(eq(accessGrants.beneficiaryAccountId, first.userId)),
			).toHaveLength(4);
			const grantRead = await fetch(`${base}/billing/credit-grants`, {
				headers,
			});
			expect(grantRead.status).toBe(200);
			const grants = (await grantRead.json()) as {
				grants: Array<{ remaining: number }>;
			};
			expect(grants.grants).toHaveLength(2);
			expect(grants.grants.map((value) => value.remaining)).toEqual([
				PRO_CREDITS,
				PRO_CREDITS,
			]);
			const foreign = await fetch(`${base}/billing/credit-grants`, {
				headers: { ...headers, "x-test-user": second.userId },
			});
			expect(await foreign.json()).toEqual({ grants: [] });
			const scalar = await fetch(`${base}/billing/subscription`, { headers });
			expect(scalar.status).toBe(409);
			const ambiguousCancel = await fetch(
				`${base}/billing/subscription/cancel`,
				{ method: "POST", headers },
			);
			expect(ambiguousCancel.status).toBe(409);
			const plural = await fetch(`${base}/billing/subscriptions`, { headers });
			expect(plural.status).toBe(200);
			expect(
				((await plural.json()) as { subscriptions: unknown[] }).subscriptions,
			).toHaveLength(2);
		});
	}));

it('product-only lifecycle uses a fresh authenticated read and never revives externally canceled access from an old event', async () => withProductCatalogue(async f => {
  const path = process.env.BILLING_PRODUCT_CATALOGUE_FILE; if (!path) throw new Error('fixture catalogue missing');
  const catalogue = JSON.parse(await readFile(path, 'utf8'));
  const priceId = 'price_SYNTHETIC_PRODUCT_ONLY'; catalogue.prices[0].priceId = priceId;
  catalogue.displayNames = { products: Object.fromEntries(f.products.map((product, index) => [product.id, `Fixture product ${index + 1}`])), offers: { [`${f.offers[0].id}@1`]: 'Fixture bundle' } };
  await writeFile(path, JSON.stringify(catalogue), { mode: 0o600 });
  productPrices.set(priceId, { id: priceId, livemode: true, type: 'recurring', currency: 'usd', unit_amount: PRO_PRICE });
  const sub = await subscriber({ priceId }); const paid = invoiceEvent(sub, { priceId }); makeProductEvidenceLive(paid, sub.subscriptionId);
  expect(await postWebhook(paid)).toBe(200); expect(await paidBalance(sub.userId)).toBe(0);
  const old = envelope('customer.subscription.updated', { id: sub.subscriptionId, status: 'active' }); old.livemode = true;
  const current = stripeSubscriptions.get(sub.subscriptionId); if (!current) throw new Error('fixture subscription missing');
  stripeSubscriptions.set(sub.subscriptionId, { ...current, status: 'canceled', cancel_at_period_end: true });
  const deleted = envelope('customer.subscription.deleted', { id: sub.subscriptionId, status: 'canceled' }); deleted.livemode = true;
  expect(await postWebhook(deleted)).toBe(200); expect(await postWebhook(old)).toBe(200);
  const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerSubscriptionId, sub.subscriptionId));
  expect(source.status).toBe('canceled'); expect(source.cancelAtPeriodEnd).toBe(true);
  expect((await readSubjectProductAccess(sub.userId, f.products[0].id)).capabilities).toEqual([]);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(2);
  expect(await getDb().select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, sub.subscriptionId))).toHaveLength(0);
  expect(await getDb().select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, sub.userId))).toHaveLength(0);
  await withApp(async base => {
    const read = await fetch(`${base}/billing/product-subscriptions`, { headers: { 'x-test-user': sub.userId } }); expect(read.status).toBe(200);
    const body = await read.json() as { subscriptions: Array<{ offers: Array<{ displayName: string; current: boolean; period: { start: string; end: string } }> }> };
    expect(body.subscriptions[0].offers[0]).toMatchObject({ displayName: 'Fixture bundle', current: false, period: { start: new Date(sub.periodStart * 1000).toISOString(), end: new Date((sub.periodStart + MONTH) * 1000).toISOString() } });
  });
}));


it.each(['empty', 'capability', 'quota', 'owner', 'application'] as const)('rejects complete catalogue %s mismatch before either award, then exact configuration retries once', async variant => withProductCatalogue(async f => {
  const path = process.env.BILLING_PRODUCT_CATALOGUE_FILE; if (!path) throw new Error('fixture catalogue missing');
  const original = await readFile(path, 'utf8'); const changed = JSON.parse(original);
  if (variant === 'empty') changed.offers[0].benefits = [];
  if (variant === 'capability') changed.offers[0].benefits[0].key = 'different';
  if (variant === 'quota') changed.offers[0].benefits[0] = { kind: 'quota', productId: f.products[0].id, key: 'storage', unit: 'byte', included: 100, combination: 'maximum' };
  if (variant === 'owner') changed.products[0].ownerAccountId = f.payer;
  if (variant === 'application') changed.products[0].applicationId = 'different-application';
  await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
  const sub = await subscriber(); const paid = invoiceEvent(sub); makeProductEvidenceLive(paid, sub.subscriptionId);
  expect(await postWebhook(paid)).toBe(500);
  expect(await paidBalance(sub.userId)).toBe(0); expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(0);
  expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerSubscriptionId, sub.subscriptionId))).toHaveLength(0);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(0);
  expect(await getDb().select().from(accessProviderPeriods).where(eq(accessProviderPeriods.invoiceId, paid.data.object.id))).toHaveLength(0);
  await writeFile(path, original, { mode: 0o600 });
  expect(await postWebhook(paid)).toBe(200); expect(await postWebhook(paid)).toBe(200);
  expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS); expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(2);
}));

it('financial cancellation and fresh lifecycle recover after application transfer without granting transferred access', async () => withProductCatalogue(async f => {
  const sub = await subscriber(); const paid = invoiceEvent(sub); makeProductEvidenceLive(paid, sub.subscriptionId); expect(await postWebhook(paid)).toBe(200);
  const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerSubscriptionId, sub.subscriptionId));
  await getDb().update(applications).set({ ownerAccountId: f.payer }).where(eq(applications.id, f.app.id));
  await withApp(async base => {
    const response = await fetch(`${base}/billing/product-subscriptions/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': sub.userId }, body: JSON.stringify({ sourceId: source.id }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ sourceId: source.id, cancelAtPeriodEnd: true });
  });
  expect(subscriptionUpdateCalls).toEqual([sub.subscriptionId]);
  const event = envelope('customer.subscription.updated', { id: sub.subscriptionId, status: 'active' }); event.livemode = true;
  expect(await postWebhook(event)).toBe(200);
  const [current] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id));
  expect(current.cancelAtPeriodEnd).toBe(true); expect(current.payerAccountId).toBe(sub.userId);
  await expect(readSubjectProductAccess(sub.userId, f.products[0].id)).rejects.toThrow('configuration');
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(2);
  expect(await paidBalance(sub.userId)).toBe(PRO_CREDITS);
}));

it('confirmed remote cancellation returns pending after SQL failure and webhook recovery changes no grants', async () => withProductCatalogue(async () => {
  const sub = await subscriber(); const paid = invoiceEvent(sub); makeProductEvidenceLive(paid, sub.subscriptionId); expect(await postWebhook(paid)).toBe(200);
  const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerSubscriptionId, sub.subscriptionId));
  await getDb().execute(sql`CREATE FUNCTION i07_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cancel_at_period_end THEN RAISE EXCEPTION 'fixture persist failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
  await getDb().execute(sql`CREATE TRIGGER i07_cancel_failure BEFORE UPDATE ON access_subscription_sources FOR EACH ROW EXECUTE FUNCTION i07_cancel_failure()`);
  try {
    await withApp(async base => {
      const response = await fetch(`${base}/billing/product-subscriptions/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': sub.userId }, body: JSON.stringify({ sourceId: source.id }) });
      expect(response.status).toBe(202); expect(await response.json()).toEqual({ sourceId: source.id, reconciliationPending: true });
    });
    expect(stripeSubscriptions.get(sub.subscriptionId)?.cancel_at_period_end).toBe(true);
    const [local] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id)); expect(local.cancelAtPeriodEnd).toBe(false);
  } finally { await getDb().execute(sql`DROP TRIGGER i07_cancel_failure ON access_subscription_sources`); await getDb().execute(sql`DROP FUNCTION i07_cancel_failure()`); }
  const event = envelope('customer.subscription.updated', { id: sub.subscriptionId, status: 'active' }); event.livemode = true;
  expect(await postWebhook(event)).toBe(200); expect(await postWebhook(event)).toBe(200);
  const [local] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id)); expect(local.cancelAtPeriodEnd).toBe(true);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(2);
  expect(await receipts(sub.userId, 'subscription_payment')).toHaveLength(1);
}));

it('reports pending when provider confirms the cancellation effect but returns an unprojectable updated snapshot', async () => withProductCatalogue(async () => {
  const sub = await subscriber(); const paid = invoiceEvent(sub); makeProductEvidenceLive(paid, sub.subscriptionId); expect(await postWebhook(paid)).toBe(200);
  const [source] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.providerSubscriptionId, sub.subscriptionId));
  invalidNextCancellationSnapshot = true;
  await withApp(async base => {
    const response = await fetch(`${base}/billing/product-subscriptions/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': sub.userId }, body: JSON.stringify({ sourceId: source.id }) });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ sourceId: source.id, reconciliationPending: true });
  });
  expect(stripeSubscriptions.get(sub.subscriptionId)?.cancel_at_period_end).toBe(true);
  const [before] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id)); expect(before.cancelAtPeriodEnd).toBe(false);
  const event = envelope('customer.subscription.updated', { id: sub.subscriptionId, status: 'active' }); event.livemode = true;
  expect(await postWebhook(event)).toBe(200);
  const [after] = await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, source.id)); expect(after.cancelAtPeriodEnd).toBe(true);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, sub.userId))).toHaveLength(2);
}));
