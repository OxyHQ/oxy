/**
 * Stripe webhook replay — against a REAL Postgres, through the REAL route.
 *
 * Stripe retries `checkout.session.completed` by design, and
 * `handleCheckoutCompleted` had NO idempotency guard of any kind: every replay
 * granted the credits again and wrote another receipt. This suite is the
 * assertion that the fix holds, and it is deliberately written as a REPLAY —
 * the same event POSTed to `/billing/webhook` twice — rather than as a unit test
 * of a helper, because the bug lived in the handler's control flow and not in
 * any single statement.
 *
 * The two paths that grant credits are both covered, because they fail the same
 * way: a one-off purchase keyed on `stripe_payment_intent_id`, and a
 * subscription renewal keyed on `(stripe_subscription_id, period_start)`.
 *
 * Only the Stripe SDK is stubbed. Signature verification is Stripe's own code
 * over a secret this suite has no reason to hold; everything downstream of it —
 * the route, the handler, the transaction, the partial unique indexes, the
 * guarded credit grant — is the real thing.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

/** The event the stubbed `constructEvent` will return for the next request. */
let nextEvent: unknown = null;

jest.mock('../../utils/stripeClient', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: () => nextEvent,
    },
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingTransactions } from '../../db/schema/billingTransactions';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';

const WEBHOOK_SECRET = 'whsec_test_secret';
const PRO_PRICE_ID = 'price_test_pro';

/**
 * `routes/billing.ts` reads `STRIPE_PRO_PRICE_ID` into its plan catalogue at
 * MODULE LOAD, so the env has to be set before the module is first required.
 * `import` statements are hoisted above every top-level statement, hence the
 * lazy load here rather than a static import.
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
  process.env.STRIPE_PRO_PRICE_ID = PRO_PRICE_ID;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** POST one already-verified Stripe event at the real webhook route. */
async function postWebhook(event: unknown): Promise<number> {
  nextEvent = event;

  const app = express();
  // The real server mounts a raw body parser for this route; `constructEvent` is
  // stubbed, so any body reaches the handler intact.
  app.use('/billing', express.raw({ type: '*/*' }), await loadBillingRoutes());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=stub' },
      body: '{}',
    });
    return response.status;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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

async function receiptCount(userId: string, type: 'credit_purchase' | 'subscription_payment') {
  const rows = await getDb()
    .select({ id: billingTransactions.id })
    .from(billingTransactions)
    .where(and(eq(billingTransactions.userId, userId), eq(billingTransactions.type, type)));
  return rows.length;
}

function checkoutEvent(userId: string, paymentIntentId: string) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
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
      },
    },
  };
}

describe('checkout.session.completed replay', () => {
  it('grants the credits exactly once no matter how often Stripe redelivers', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, `pi_${userId}`);

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(1000);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(1);

    // The replay. Byte-identical event, exactly as Stripe redelivers it.
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(1000);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(1);

    // And again, because a retry schedule is not two attempts.
    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(1000);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(1);
  });

  it('does not let CONCURRENT redeliveries both grant', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, `pi_concurrent_${userId}`);

    // A JavaScript-only guard — read, decide, write — passes the sequential case
    // above and fails HERE: both requests would find no receipt and both grant.
    // The partial unique index is what makes the claim atomic.
    const statuses = await Promise.all([
      postWebhook(event),
      postWebhook(event),
      postWebhook(event),
    ]);

    expect(statuses.every((status) => status === 200 || status === 500)).toBe(true);
    expect(await paidBalance(userId)).toBe(1000);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(1);
  });

  it('grants separately for two DIFFERENT purchases by the same account', async () => {
    const userId = await account();

    expect(await postWebhook(checkoutEvent(userId, `pi_first_${userId}`))).toBe(200);
    expect(await postWebhook(checkoutEvent(userId, `pi_second_${userId}`))).toBe(200);

    // The guard keys on the payment intent, so it must not collapse two real
    // charges into one — which is the failure mode of an over-broad guard.
    expect(await paidBalance(userId)).toBe(2000);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(2);
  });

  it('refuses to grant when the session carries no payment intent', async () => {
    const userId = await account();
    const event = checkoutEvent(userId, 'unused');
    event.data.object.payment_intent = null as unknown as string;

    expect(await postWebhook(event)).toBe(200);
    // No idempotency key means no way to recognise a replay, and granting
    // unguarded is exactly the original bug. Nothing is granted.
    expect(await paidBalance(userId)).toBe(0);
    expect(await receiptCount(userId, 'credit_purchase')).toBe(0);
  });
});

describe('customer.subscription.updated replay', () => {
  function subscriptionEvent(subscriptionId: string, periodStart: number) {
    return {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subscriptionId,
          customer: `cus_${subscriptionId}`,
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: PRO_PRICE_ID },
                current_period_start: periodStart,
                current_period_end: periodStart + 30 * 24 * 60 * 60,
              },
            ],
          },
        },
      },
    };
  }

  it('grants the renewal credits exactly once per billing period', async () => {
    const subscriptionId = `sub_${Date.now()}`;
    const userId = await account(`cus_${subscriptionId}`);
    const periodStart = Math.floor(Date.now() / 1000);
    const event = subscriptionEvent(subscriptionId, periodStart);

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(10_000);
    expect(await receiptCount(userId, 'subscription_payment')).toBe(1);

    expect(await postWebhook(event)).toBe(200);
    expect(await paidBalance(userId)).toBe(10_000);
    expect(await receiptCount(userId, 'subscription_payment')).toBe(1);
  });
});
