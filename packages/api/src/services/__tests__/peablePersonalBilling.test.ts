import {
  cancelOwnedPeableSubscription,
  PEABLE_ONE_READINESS,
  personalFinalInvoiceSchema,
  validatePersonalInvoiceForAction,
} from '../peablePersonalBilling.service';
import type { Peable } from '@peable.to/sdk';
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
  ...owned,
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodStart: '2026-10-01T00:00:00Z',
  currentPeriodEnd: '2026-11-01T00:00:00Z',
};
function fixture() {
  let current = subscription;
  const retrieveSubscription = jest.fn(async () => current);
  const cancelAtPeriodEnd = jest.fn(async () => {
    current = { ...subscription, cancelAtPeriodEnd: true };
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
  f.retrieveSubscription.mockResolvedValue({ ...subscription, storeId: 'another' });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'ownership',
  );
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});
it('schedules existing period with stable replay key and never extends it', async () => {
  const f = fixture();
  expect(
    (await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).cancelAtPeriodEnd,
  ).toBe(true);
  expect(f.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_test', {
    idempotencyKey: expect.stringMatching(/^oxy-one-cancel:[a-f0-9]{64}$/),
  });
  f.retrieveSubscription.mockResolvedValue(subscription);
  f.cancelAtPeriodEnd.mockResolvedValue({
    ...subscription,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2026-12-01T00:00:00Z',
  });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'period differs',
  );
  f.retrieveSubscription.mockResolvedValue({ ...subscription, cancelAtPeriodEnd: true });
  f.cancelAtPeriodEnd.mockClear();
  await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1');
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});
const context = {
  payerAccountId: 'payer',
  beneficiaryAccountId: 'payer',
  providerSubscriptionId: 'sub_test',
  offerId: 'one',
  offerVersion: 1,
  periodStart: '2026-10-01T00:00:00Z',
  periodEnd: '2026-11-01T00:00:00Z',
  mode: 'test' as const,
  environment: 'development' as const,
};
const invoice = {
  context,
  platform: 'peable',
  currency: 'USD',
  grossMinorUnits: 2999,
  netMinorUnits: 2500,
  taxMinorUnits: 499,
  merchantFeeMinorUnits: 0,
  taxTreatment: 'inclusive',
  sellerId: 'seller',
  invoiceIssuerId: 'issuer',
  taxQuoteId: 'tax',
  customerLocationEvidenceId: 'location',
  taxRateEvidenceId: 'rate',
  issuedAt: '2026-10-05T00:00:00Z',
  expiresAt: '2026-10-05T00:05:00Z',
};
it('requires inclusive final invoice evidence without added fees or assumed zero tax', () => {
  expect(personalFinalInvoiceSchema.safeParse(invoice).success).toBe(true);
  for (const changed of [
    { taxMinorUnits: 0 },
    { merchantFeeMinorUnits: 1 },
    { grossMinorUnits: 3000 },
    { taxQuoteId: undefined },
    { sellerId: undefined },
    { expiresAt: invoice.issuedAt },
  ])
    expect(personalFinalInvoiceSchema.safeParse({ ...invoice, ...changed }).success).toBe(false);
  expect(
    personalFinalInvoiceSchema.safeParse({
      ...invoice,
      faircoinQuote: {
        id: 'fx',
        amountBaseUnits: '1',
        quotedAt: invoice.issuedAt,
        expiresAt: '2026-10-05T00:06:00Z',
        roundingEvidenceId: 'rounding',
      },
    }).success,
  ).toBe(false);
});
it('does not substitute one-off Faircoin for recurring purchase', () => {
  expect(PEABLE_ONE_READINESS.platform).toBe('peable');
  expect(PEABLE_ONE_READINESS.purchase).toBe('unavailable');
  expect(PEABLE_ONE_READINESS.blockers).toContain(
    'peable_sdk_adoption_and_recurring_observation_delivery',
  );
});

it('rejects invalid provider period snapshots before financial calls', async () => {
  const f = fixture();
  f.retrieveSubscription.mockResolvedValue({ ...subscription, currentPeriodEnd: 'invalid' });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'period unavailable',
  );
  expect(f.cancelAtPeriodEnd).not.toHaveBeenCalled();
});

it('separates historical parsing from action-time ownership and expiry', () => {
  const now = new Date('2026-10-05T00:01:00Z');
  expect(validatePersonalInvoiceForAction(invoice, context, 'card', now)).toMatchObject({
    grossMinorUnits: 2999,
  });
  expect(() => validatePersonalInvoiceForAction(invoice, context, 'faircoin', now)).toThrow(
    'Faircoin quote',
  );
  for (const changed of [
    { payerAccountId: 'other' },
    { offerVersion: 2 },
    { environment: 'production' as const },
    { periodEnd: '2026-12-01T00:00:00Z' },
  ])
    expect(() =>
      validatePersonalInvoiceForAction(invoice, { ...context, ...changed }, 'card', now),
    ).toThrow('context');
  expect(personalFinalInvoiceSchema.safeParse(invoice).success).toBe(true);
  expect(() =>
    validatePersonalInvoiceForAction(invoice, context, 'card', new Date(invoice.expiresAt)),
  ).toThrow();
  expect(() =>
    validatePersonalInvoiceForAction(invoice, context, 'card', new Date('2026-10-04T00:00:00Z')),
  ).toThrow();
});
it('cannot accept cached success after external resume', async () => {
  const f = fixture();
  f.retrieveSubscription.mockResolvedValue(subscription);
  f.cancelAtPeriodEnd.mockResolvedValue({ ...subscription, cancelAtPeriodEnd: true });
  await expect(cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).rejects.toThrow(
    'reconciliation required',
  );
});

it('requires a current Faircoin quote rather than accepting future or expired FX evidence', () => {
  const now = new Date('2026-10-05T00:01:00Z');
  const quote = {
    id: 'synthetic_fx',
    amountBaseUnits: '1234',
    quotedAt: invoice.issuedAt,
    expiresAt: invoice.expiresAt,
    roundingEvidenceId: 'synthetic_rounding',
  };
  expect(
    validatePersonalInvoiceForAction({ ...invoice, faircoinQuote: quote }, context, 'faircoin', now)
      .faircoinQuote?.id,
  ).toBe('synthetic_fx');
  expect(() =>
    validatePersonalInvoiceForAction(
      { ...invoice, faircoinQuote: { ...quote, quotedAt: '2026-10-05T00:02:00Z' } },
      context,
      'faircoin',
      now,
    ),
  ).toThrow();
  expect(() =>
    validatePersonalInvoiceForAction(
      { ...invoice, faircoinQuote: { ...quote, expiresAt: now.toISOString() } },
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
    const canceled = { ...subscription, status, cancelAtPeriodEnd: true };
    f.retrieveSubscription
      .mockResolvedValueOnce({ ...subscription, status })
      .mockResolvedValueOnce(canceled);
    f.cancelAtPeriodEnd.mockResolvedValue(canceled);
    expect(
      (await cancelOwnedPeableSubscription(f.client, 'payer', owned, 'action_1')).cancelAtPeriodEnd,
    ).toBe(true);
  },
);
