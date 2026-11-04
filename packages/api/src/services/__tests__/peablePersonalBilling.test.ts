import {
  cancelOwnedPeableSubscription,
  PEABLE_ONE_READINESS,
  personalFinalInvoiceSchema,
  validatePersonalInvoiceForAction,
} from '../peablePersonalBilling.service';
import type { Peable } from '@peable.to/sdk';
/** Peable instants are integer Unix seconds (ADR 0014). */
const unix = (iso: string) => Date.parse(iso) / 1000;
const owned = {
  payerAccountId: 'payer',
  providerSubscriptionId: 'sub_test',
  providerCustomerId: 'cus_test',
  providerPriceId: 'price_test',
  storeId: 'store',
  planId: 'one-v1',
  livemode: false,
};
const subscription = {
  provider_subscription_id: owned.providerSubscriptionId,
  provider_customer_id: owned.providerCustomerId,
  provider_price_id: owned.providerPriceId,
  store_id: owned.storeId,
  plan_id: owned.planId,
  livemode: owned.livemode,
  status: 'active',
  cancel_at_period_end: false,
  current_period_start: unix('2026-10-01T00:00:00Z'),
  current_period_end: unix('2026-11-01T00:00:00Z'),
};
function fixture() {
  let current = subscription;
  const retrieveSubscription = jest.fn(async () => current);
  const cancelAtPeriodEnd = jest.fn(async () => {
    current = { ...subscription, cancel_at_period_end: true };
    return current;
  });
  return {
    client: { billing: { retrieveSubscription, cancelAtPeriodEnd } } as unknown as Pick<
      Peable,
      'billing'
    >,
    retrieveSubscription,
    cancelAtPeriodEnd,
  };
}
it('verifies payer and exact Peable ownership before cancellation', async () => {
  const f = fixture();
  await expect(cancelOwnedPeableSubscription(f.client, 'other', owned, 'action_1')).rejects.toThrow(
    'payer',
  );
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
  f.retrieveSubscription.mockResolvedValue({ ...subscription, store_id: 'another' });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'ownership',
  );
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});
it('schedules existing period with stable replay key and never extends it', async () => {
  const f = fixture();
  expect(
    (await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1'))
      .cancel_at_period_end,
  ).toBe(true);
  expect(f.cancelAtPeriodEnd).toHaveBeenCalledWith(
    'sub_test',
    {},
    { idempotencyKey: expect.stringMatching(/^oxy-one-cancel:[a-f0-9]{64}$/) },
  );
  f.retrieveSubscription.mockResolvedValue(subscription);
  f.cancelAtPeriodEnd.mockResolvedValue({
    ...subscription,
    cancel_at_period_end: true,
    current_period_end: unix('2026-12-01T00:00:00Z'),
  });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'period differs',
  );
  f.retrieveSubscription.mockResolvedValue({ ...subscription, cancel_at_period_end: true });
  f.cancelAtPeriodEnd.mockClear();
  await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1');
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});
const context = {
  payer_account_id: 'payer',
  beneficiary_account_id: 'payer',
  provider_subscription_id: 'sub_test',
  offer_id: 'one',
  offer_version: 1,
  period_start: unix('2026-10-01T00:00:00Z'),
  period_end: unix('2026-11-01T00:00:00Z'),
  mode: 'test' as const,
  environment: 'development' as const,
};
const invoice = {
  context,
  platform: 'peable',
  currency: 'USD',
  gross_minor_units: 2999,
  net_minor_units: 2500,
  tax_minor_units: 499,
  merchant_fee_minor_units: 0,
  tax_treatment: 'inclusive',
  seller_id: 'seller',
  invoice_issuer_id: 'issuer',
  tax_quote_id: 'tax',
  customer_location_evidence_id: 'location',
  tax_rate_evidence_id: 'rate',
  issued_at: unix('2026-10-05T00:00:00Z'),
  expires_at: unix('2026-10-05T00:05:00Z'),
};
it('requires inclusive final invoice evidence without added fees or assumed zero tax', () => {
  expect(personalFinalInvoiceSchema.safeParse(invoice).success).toBe(true);
  for (const changed of [
    { tax_minor_units: 0 },
    { merchant_fee_minor_units: 1 },
    { gross_minor_units: 3000 },
    { tax_quote_id: undefined },
    { seller_id: undefined },
    { expires_at: invoice.issued_at },
    // A signed instant is whole seconds; an ISO string is the retired shape.
    { issued_at: invoice.issued_at + 0.5 },
    { expires_at: '2026-10-05T00:05:00Z' },
  ])
    expect(personalFinalInvoiceSchema.safeParse({ ...invoice, ...changed }).success).toBe(false);
  expect(
    personalFinalInvoiceSchema.safeParse({
      ...invoice,
      faircoin_quote: {
        id: 'fx',
        amount_base_units: '1',
        quoted_at: invoice.issued_at,
        expires_at: unix('2026-10-05T00:06:00Z'),
        rounding_evidence_id: 'rounding',
      },
    }).success,
  ).toBe(false);
});
it('does not substitute one-off Faircoin for recurring purchase', () => {
  expect(PEABLE_ONE_READINESS.platform).toBe('peable');
  expect(PEABLE_ONE_READINESS.purchase).toBe('unavailable');
  expect(PEABLE_ONE_READINESS.blockers).toContain(
    'configured_watch_only_merchant_and_verified_chain_access',
  );
});

it('rejects invalid provider period snapshots before financial calls', async () => {
  const f = fixture();
  f.retrieveSubscription.mockResolvedValue({ ...subscription, current_period_end: 1.5 });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'period unavailable',
  );
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});

it('separates historical parsing from action-time ownership and expiry', () => {
  const now = new Date('2026-10-05T00:01:00Z');
  expect(validatePersonalInvoiceForAction(invoice, context, 'card', now)).toMatchObject({
    gross_minor_units: 2999,
  });
  expect(() => validatePersonalInvoiceForAction(invoice, context, 'faircoin', now)).toThrow(
    'Faircoin quote',
  );
  for (const changed of [
    { payer_account_id: 'other' },
    { offer_version: 2 },
    { environment: 'production' as const },
    { period_end: unix('2026-12-01T00:00:00Z') },
  ])
    expect(() =>
      validatePersonalInvoiceForAction(invoice, { ...context, ...changed }, 'card', now),
    ).toThrow('context');
  expect(personalFinalInvoiceSchema.safeParse(invoice).success).toBe(true);
  expect(() =>
    validatePersonalInvoiceForAction(invoice, context, 'card', new Date(invoice.expires_at * 1000)),
  ).toThrow();
  expect(() =>
    validatePersonalInvoiceForAction(invoice, context, 'card', new Date('2026-10-04T00:00:00Z')),
  ).toThrow();
});
it('cannot accept cached success after external resume', async () => {
  const f = fixture();
  f.retrieveSubscription.mockResolvedValue(subscription);
  f.cancelAtPeriodEnd.mockResolvedValue({ ...subscription, cancel_at_period_end: true });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'reconciliation required',
  );
});

it('requires a current Faircoin quote rather than accepting future or expired FX evidence', () => {
  const now = new Date('2026-10-05T00:01:00Z');
  const quote = {
    id: 'synthetic_fx',
    amount_base_units: '1234',
    quoted_at: invoice.issued_at,
    expires_at: invoice.expires_at,
    rounding_evidence_id: 'synthetic_rounding',
  };
  expect(
    validatePersonalInvoiceForAction(
      { ...invoice, faircoin_quote: quote },
      context,
      'faircoin',
      now,
    ).faircoin_quote?.id,
  ).toBe('synthetic_fx');
  expect(() =>
    validatePersonalInvoiceForAction(
      { ...invoice, faircoin_quote: { ...quote, quoted_at: unix('2026-10-05T00:02:00Z') } },
      context,
      'faircoin',
      now,
    ),
  ).toThrow();
  expect(() =>
    validatePersonalInvoiceForAction(
      { ...invoice, faircoin_quote: { ...quote, expires_at: now.getTime() / 1000 } },
      context,
      'faircoin',
      now,
    ),
  ).toThrow();
});

it.each(['past_due', 'unpaid'])(
  'allows owned %s subscriptions to cancel without granting access',
  async (status) => {
    const f = fixture();
    const canceled = { ...subscription, status, cancel_at_period_end: true };
    f.retrieveSubscription
      .mockResolvedValueOnce({ ...subscription, status })
      .mockResolvedValueOnce(canceled);
    f.cancelAtPeriodEnd.mockResolvedValue(canceled);
    expect(
      (await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1'))
        .cancel_at_period_end,
    ).toBe(true);
  },
);

it('recovers a paid invoice after FX expiry without authorizing a new stale-quote payment', () => {
  const fresh = {
    ...invoice,
    faircoin_quote: {
      id: 'fx',
      amount_base_units: '1234',
      quoted_at: unix('2026-10-05T00:00:00Z'),
      expires_at: unix('2026-10-05T00:01:00Z'),
      rounding_evidence_id: 'round',
    },
  };
  const now = new Date('2026-10-05T00:02:00Z');
  expect(
    validatePersonalInvoiceForAction(
      fresh,
      context,
      'faircoin',
      now,
      new Date('2026-10-05T00:00:30Z'),
    ),
  ).toMatchObject({ faircoin_quote: { id: 'fx' } });
  expect(() => validatePersonalInvoiceForAction(fresh, context, 'faircoin', now)).toThrow('quote');
  expect(() =>
    validatePersonalInvoiceForAction(
      fresh,
      context,
      'faircoin',
      now,
      new Date(fresh.faircoin_quote.expires_at * 1000),
    ),
  ).toThrow('quote');
});
