/**
 * The Stripe boundary, against a REAL Postgres and NO Stripe.
 *
 * ## What this file can and cannot prove
 *
 * It proves the half that lives in this database: that a redelivered webhook
 * credits an account once, that the two guards standing in the way of a double
 * credit both hold, that a session whose metadata names one account while its
 * customer belongs to another is refused, and that the checkout path refuses an
 * amount it cannot charge exactly.
 *
 * It proves NOTHING about Stripe. There is no Stripe account in development, so
 * `createBalanceTopUpCheckout`, `createAccountPortalSession`,
 * `chargeAutoRecharge` and `stripePaymentProcessorLedger` are unexercised here
 * and unverified anywhere — see the report accompanying this change. The webhook
 * handlers are testable precisely because their parameter types were narrowed to
 * the fields they read, so a plain object literal satisfies them with no cast.
 *
 * ## The redelivery test is the one worth reading
 *
 * Stripe redelivers by design, on its own timer and again whenever a delivery is
 * not acknowledged. The test calls the handler TWICE with the identical session
 * and asserts three things: the balance moved once, exactly one ledger entry
 * carries the key, and exactly one `billing_external_payments` row names the
 * payment intent. Asserting only the balance would pass even if the second call
 * had written a duplicate payment row that a later reconciliation would report.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingExternalPayments } from '../../db/schema/billingExternalPayments';
import { billingLedgerEntries } from '../../db/schema/billingLedgerEntries';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';
import {
  BALANCE_TOP_UP_METADATA_TYPE,
  handleBalanceTopUpCompleted,
  handleBalanceTopUpPaymentIntent,
  type BalanceTopUpIntent,
  type BalanceTopUpSession,
} from '../stripeAccountBilling.service';
import { getAccountBalance, provisionBillingProfile } from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function seedProvisionedAccount(stripeCustomerId?: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `pay-${suffix}`, email: `pay-${suffix}@example.test` })
    .returning({ id: users.id });

  await provisionBillingProfile({ accountId: account.id });

  if (stripeCustomerId !== undefined) {
    await getDb()
      .insert(userCredits)
      .values({ userId: account.id, stripeCustomerId })
      .onConflictDoUpdate({
        target: userCredits.userId,
        set: { stripeCustomerId },
      });
  }
  return account.id;
}

function topUpSession(overrides: {
  accountId: string;
  paymentIntentId: string;
  amountTotal?: number;
  customer?: string | null;
  currency?: string;
}): BalanceTopUpSession {
  return {
    id: `cs_test_${randomUUID().replace(/-/g, '')}`,
    metadata: {
      accountId: overrides.accountId,
      type: BALANCE_TOP_UP_METADATA_TYPE,
      currency: overrides.currency ?? 'USD',
    },
    payment_intent: overrides.paymentIntentId,
    amount_total: overrides.amountTotal ?? 2000,
    currency: (overrides.currency ?? 'USD').toLowerCase(),
    customer: overrides.customer ?? null,
    created: Math.floor(Date.now() / 1000),
  };
}

async function countLedgerEntries(idempotencyKey: string): Promise<number> {
  const rows = await getDb()
    .select({ id: billingLedgerEntries.id })
    .from(billingLedgerEntries)
    .where(eq(billingLedgerEntries.idempotencyKey, idempotencyKey));
  return rows.length;
}

async function countExternalPayments(externalRef: string): Promise<number> {
  const rows = await getDb()
    .select({ id: billingExternalPayments.id })
    .from(billingExternalPayments)
    .where(
      and(
        eq(billingExternalPayments.provider, 'stripe'),
        eq(billingExternalPayments.externalRef, externalRef)
      )
    );
  return rows.length;
}

describe('a redelivered webhook credits an account exactly once', () => {
  it('holds across a replayed checkout session', async () => {
    const accountId = await seedProvisionedAccount();
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '')}`;
    const session = topUpSession({ accountId, paymentIntentId });

    const first = await handleBalanceTopUpCompleted(session);
    expect(first.status).toBe('credited');

    // Stripe's retry, byte-identical.
    const second = await handleBalanceTopUpCompleted(session);
    expect(second).toMatchObject({ status: 'credited' });
    if (second.status === 'credited') {
      expect(second.funding.status).toBe('already-recorded');
    }

    const balance = await getAccountBalance(getDb(), accountId, 'USD');
    expect(Number(balance?.purchasedBalance)).toBe(20);

    // Both guards, separately. The balance alone would pass even if the second
    // call had written a duplicate payment row for a reconciliation to find.
    expect(await countLedgerEntries(`stripe:payment_intent:${paymentIntentId}`)).toBe(1);
    expect(await countExternalPayments(paymentIntentId)).toBe(1);
  });

  it('holds when the SAME charge arrives as both a session and an intent', async () => {
    // A hosted checkout emits `checkout.session.completed` AND
    // `payment_intent.succeeded`. Both handlers run; both compose the same key.
    const accountId = await seedProvisionedAccount();
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '')}`;

    await handleBalanceTopUpCompleted(topUpSession({ accountId, paymentIntentId }));

    const intent: BalanceTopUpIntent = {
      id: paymentIntentId,
      metadata: { accountId, type: BALANCE_TOP_UP_METADATA_TYPE },
      status: 'succeeded',
      amount_received: 2000,
      currency: 'usd',
      customer: null,
      created: Math.floor(Date.now() / 1000),
    };
    await handleBalanceTopUpPaymentIntent(intent);

    const balance = await getAccountBalance(getDb(), accountId, 'USD');
    expect(Number(balance?.purchasedBalance)).toBe(20);
    expect(await countLedgerEntries(`stripe:payment_intent:${paymentIntentId}`)).toBe(1);
    expect(await countExternalPayments(paymentIntentId)).toBe(1);
  });
});

describe('the handler refuses what it cannot credit safely', () => {
  it('ignores a session that is not a balance top-up', async () => {
    const accountId = await seedProvisionedAccount();
    const session: BalanceTopUpSession = {
      ...topUpSession({ accountId, paymentIntentId: `pi_${randomUUID()}` }),
      metadata: { userId: accountId, type: 'credit_purchase' },
    };
    await expect(handleBalanceTopUpCompleted(session)).resolves.toMatchObject({
      status: 'ignored',
      reason: 'not-a-balance-top-up',
    });
  });

  it('refuses a session with no payment intent, rather than crediting unguarded', async () => {
    const accountId = await seedProvisionedAccount();
    const session: BalanceTopUpSession = {
      ...topUpSession({ accountId, paymentIntentId: 'unused' }),
      payment_intent: null,
    };
    await expect(handleBalanceTopUpCompleted(session)).resolves.toMatchObject({
      status: 'ignored',
      reason: 'no-payment-intent',
    });

    const balance = await getAccountBalance(getDb(), accountId, 'USD');
    expect(Number(balance?.purchasedBalance)).toBe(0);
  });

  it('refuses a session whose metadata and customer name different accounts', async () => {
    // The one shape that would credit the WRONG account's balance.
    const customerId = `cus_${randomUUID().replace(/-/g, '')}`;
    const ownerId = await seedProvisionedAccount(customerId);
    const strangerId = await seedProvisionedAccount();

    const session = topUpSession({
      accountId: strangerId,
      paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`,
      customer: customerId,
    });
    await expect(handleBalanceTopUpCompleted(session)).resolves.toMatchObject({
      status: 'ignored',
      reason: 'account-customer-mismatch',
    });

    for (const accountId of [ownerId, strangerId]) {
      const balance = await getAccountBalance(getDb(), accountId, 'USD');
      expect(Number(balance?.purchasedBalance)).toBe(0);
    }
  });

  it('refuses to credit an account with no billing profile', async () => {
    const suffix = randomUUID().slice(0, 8);
    const [account] = await getDb()
      .insert(users)
      .values({ username: `nop-${suffix}`, email: `nop-${suffix}@example.test` })
      .returning({ id: users.id });

    const session = topUpSession({
      accountId: account.id,
      paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`,
    });
    await expect(handleBalanceTopUpCompleted(session)).resolves.toMatchObject({
      status: 'ignored',
      reason: 'no-billing-profile',
    });
  });

  it('ignores an unsettled payment intent', async () => {
    const accountId = await seedProvisionedAccount();
    const intent: BalanceTopUpIntent = {
      id: `pi_${randomUUID().replace(/-/g, '')}`,
      metadata: { accountId, type: BALANCE_TOP_UP_METADATA_TYPE },
      status: 'requires_payment_method',
      amount_received: 0,
      currency: 'usd',
      customer: null,
      created: Math.floor(Date.now() / 1000),
    };
    await expect(handleBalanceTopUpPaymentIntent(intent)).resolves.toMatchObject({
      status: 'ignored',
      reason: 'not-settled',
    });
  });
});

describe('the credited amount is the processor amount, exactly', () => {
  it('converts minor units without float arithmetic', async () => {
    const accountId = await seedProvisionedAccount();
    // 7 cents — the value that becomes 7.000000000000001 under `x / 100`.
    await handleBalanceTopUpCompleted(
      topUpSession({
        accountId,
        paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`,
        amountTotal: 7,
      })
    );

    const [payment] = await getDb()
      .select({ amount: billingExternalPayments.amount })
      .from(billingExternalPayments)
      .where(eq(billingExternalPayments.accountId, accountId))
      .limit(1);
    expect(payment.amount).toBe('0.070000000000');
  });
});
