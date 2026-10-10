/** Synthetic persisted rows only; financial/provider calls remain local. */
import { randomUUID } from 'node:crypto';
export async function seedPreserved(require, getDb, person) {
  const { userCredits } = require('./src/db/schema/userCredits.ts');
  const { billingTransactions } = require('./src/db/schema/billingTransactions.ts');
  const ledger = require('./src/services/subscriptionCreditLedger.service.ts');
  await getDb().insert(userCredits).values({ userId: person.id, creditsPaid: 0, creditsFree: 0 });
  const g = {
    userId: person.id,
    transactionId: randomUUID(),
    providerAccountRef: 'synthetic-rollback-account',
    invoiceId: `in_${randomUUID()}`,
    subscriptionId: `sub_${randomUUID()}`,
    sourceType: 'subscription_payment',
    periodStart: new Date('2026-10-01T00:00:00Z'),
    periodEnd: new Date('2026-11-01T00:00:00Z'),
    currency: 'usd',
    amountPaid: 1000,
    granted: 10000,
    promotionId: null,
    oncePerAccountPromotionId: null,
  };
  await getDb().transaction(async (tx) => {
    await ledger.lockSubscriptionCreditAccount(tx, person.id);
    await tx.insert(billingTransactions).values({
      id: g.transactionId,
      userId: person.id,
      stripeInvoiceId: g.invoiceId,
      stripeSubscriptionId: g.subscriptionId,
      stripeSubscriptionPeriodStart: g.periodStart,
      type: g.sourceType,
      amountMinorUnits: g.amountPaid,
      currency: g.currency,
      credits: g.granted,
      status: 'completed',
    });
    await ledger.grantSubscriptionCredits(tx, g);
  });
  await ledger.spendSubscriptionTrackedCredits(getDb(), person.id, 1000, 'rollback-owned-spend');
  await ledger.recordCreditRefundSnapshot(getDb(), {
    userId: person.id,
    providerAccountRef: g.providerAccountRef,
    invoiceId: g.invoiceId,
    eventId: `evt_${randomUUID()}`,
    chargeId: `ch_${randomUUID()}`,
    currency: g.currency,
    amountPaid: g.amountPaid,
    amountRefunded: 200,
  });
  const f =
    await require('./src/services/__fixtures__/productAccessFixtures.ts').productAccessFixture();
  const offer = f.offers[0];
  const raw = f.input(offer);
  const { id, ...subscription } = raw.source;
  await require('./src/services/productProviderEvidence.service.ts').recordProductProviderPeriod({
    binding: f.providerBinding,
    subscription,
    offer: { offerId: offer.id, offerVersion: offer.version, origin: offer.kind },
    paidLine: {
      invoiceId: `in_${randomUUID()}`,
      lineId: `il_${randomUUID()}`,
      priceId: `price_${randomUUID()}`,
      quantity: 1,
      period: f.period,
    },
    event: { id: `evt_${randomUUID()}`, createdAt: f.now.toISOString() },
    providerObservedAt: f.now,
  });
  const {
    inferenceProviderCostAttempts: attempts,
    inferenceProviderCostFeedCursors: cursors,
  } = require('./src/db/schema/inferenceProviderCostAttempts.ts');
  await getDb().insert(cursors).values({ feed: 'rollback-synthetic', cursor: 'owned-cursor' });
  await getDb()
    .insert(attempts)
    .values({
      requestId: randomUUID(),
      attemptIndex: 0,
      provider: 'fixture',
      keyId: 'owned-handle',
      keyClass: 'platform',
      deploymentId: 'owned-fixture',
      modelReference: 'fixture-model',
      costSource: 'unknown',
      costAmount: null,
      costCurrency: null,
      costComplete: false,
      served: false,
      occurredAt: new Date(),
      unitsMeasured: false,
      feedPosition: 'owned-cursor',
      factsDigest: 'a'.repeat(64),
    });
  return [
    'billing_credit_invoices',
    'billing_credit_grants',
    'billing_credit_spends',
    'billing_credit_consumptions',
    'billing_credit_refund_observations',
    'billing_transactions',
    'user_credits',
    'access_provider_periods',
    'access_provider_events',
    'access_subscription_sources',
    'access_offer_segments',
    'access_grants',
    'inference_provider_cost_attempts',
    'inference_provider_cost_feed_cursors',
  ];
}
