import {
  exactDecimalSchema,
  INFERENCE_MONEY_SCALE,
  normalizedUsageReportSchema,
  priceVersionSchema,
  safeParseContract,
  unitPriceSchema,
  usageQuantitySchema,
  usageReceiptSchema,
  usageRefundSchema,
  usageReservationRequestSchema,
  usageReservationSchema,
  USAGE_UNITS,
} from '../index';

const attribution = {
  principal: {
    billing: { accountId: 'acc_1' },
    applicationId: 'app_1',
    credentialId: 'cred_1',
    environment: 'production' as const,
    inferenceScopes: ['inference:invoke'],
  },
  requestId: 'req_1',
};

const priceSnapshot = {
  priceVersionId: 'pv_1',
  currency: 'USD',
  unitPrices: [{ unit: 'output_tokens', amount: '15.00', per: 1000000, currency: 'USD' }],
};

const reservation = {
  schemaVersion: 1 as const,
  reservationId: 'res_1',
  idempotencyKey: 'idem_1',
  attribution,
  status: 'held' as const,
  reservedAmount: '0.024360000000',
  currency: 'USD',
  ceilingPriceVersionId: 'pv_1',
  createdAt: '2026-08-15T09:41:00.000Z',
  expiresAt: '2026-08-15T09:56:00.000Z',
};

const report = {
  schemaVersion: 1 as const,
  requestId: 'req_1',
  attribution,
  outcome: 'completed' as const,
  units: [{ unit: 'output_tokens', quantity: 204 }],
  usageSource: 'provider_reported' as const,
  resolvedModelReference: 'openai/gpt-5@2026-06-01',
  servingProvider: 'openai',
  routeSwitches: 0,
  startedAt: '2026-08-15T09:41:00.000Z',
  completedAt: '2026-08-15T09:41:02.000Z',
};

const receipt = {
  schemaVersion: 1 as const,
  receiptId: 'rcpt_1',
  reservationId: 'res_1',
  idempotencyKey: 'idem_1',
  attribution,
  outcome: 'completed' as const,
  units: [{ unit: 'output_tokens', quantity: 204 }],
  usageSource: 'provider_reported' as const,
  priceSnapshot,
  billedAmount: '0.003060000000',
  currency: 'USD',
  platformFeeOnly: false,
  resolvedModelReference: 'openai/gpt-5@2026-06-01',
  servingProvider: 'openai',
  settledAt: '2026-08-15T09:41:03.000Z',
};

const refund = {
  schemaVersion: 1 as const,
  refundId: 'rfnd_1',
  idempotencyKey: 'idem_1:release',
  attribution,
  subject: { kind: 'reservation' as const, reservationId: 'res_1' },
  reason: 'unused_reservation' as const,
  amount: '0.021300000000',
  currency: 'USD',
  createdAt: '2026-08-15T09:41:03.100Z',
};

describe('money is exact', () => {
  it('declares one scale for every amount and price', () => {
    // ADR 0009: money is exact NUMERIC with sub-minor-unit precision, NOT
    // integer minor units — rounding per request would make a bill depend on
    // how a client chunked its work.
    expect(INFERENCE_MONEY_SCALE).toBe(12);
    expect(exactDecimalSchema.safeParse('0.000003000000').success).toBe(true);
    expect(exactDecimalSchema.safeParse('0.0000030000001').success).toBe(false);
  });

  it('refuses a JavaScript number as an amount at all', () => {
    expect(exactDecimalSchema.safeParse(1806).success).toBe(false);
    expect(exactDecimalSchema.safeParse(18.06).success).toBe(false);
    expect(usageReceiptSchema.safeParse({ ...receipt, billedAmount: 3 }).success).toBe(false);
  });

  it('carries amounts and prices as exact decimal strings with one spelling', () => {
    expect(exactDecimalSchema.safeParse('0.0000015').success).toBe(true);
    expect(exactDecimalSchema.safeParse('15').success).toBe(true);
    expect(exactDecimalSchema.safeParse('015').success).toBe(false);
    expect(exactDecimalSchema.safeParse('-1.5').success).toBe(false);
    expect(exactDecimalSchema.safeParse('1.5e-3').success).toBe(false);
    expect(exactDecimalSchema.safeParse(1.5).success).toBe(false);
  });

  it('keeps unit counts free of money and money free of units', () => {
    expect(Object.keys(usageQuantitySchema.shape)).toEqual(['unit', 'quantity']);
    expect(
      usageQuantitySchema.safeParse({ unit: 'output_tokens', quantity: 1, currency: 'USD' })
        .success,
    ).toBe(false);
    expect(usageQuantitySchema.safeParse({ unit: 'output_tokens', quantity: 1.5 }).success).toBe(
      false,
    );
  });

  it('meters time in integer milliseconds, so no quantity is ever fractional', () => {
    expect(USAGE_UNITS).toContain('audio_input_milliseconds');
    expect(USAGE_UNITS).not.toContain('audio_seconds');
    expect(
      usageQuantitySchema.safeParse({ unit: 'audio_input_milliseconds', quantity: 12500 }).success,
    ).toBe(true);
  });

  it('quotes a unit price per a stated quantity of units', () => {
    expect(safeParseContract(unitPriceSchema, priceSnapshot.unitPrices[0])).toEqual(
      priceSnapshot.unitPrices[0],
    );
    expect(
      unitPriceSchema.safeParse({ ...priceSnapshot.unitPrices[0], per: 0 }).success,
    ).toBe(false);
  });
});

describe('usageReservationRequestSchema', () => {
  it('sizes the hold from known units, the output ceiling and the route ceiling', () => {
    expect(
      usageReservationRequestSchema.safeParse({
        schemaVersion: 1,
        idempotencyKey: 'idem_1',
        attribution,
        knownUnits: [{ unit: 'input_tokens', quantity: 812 }],
        maxOutputTokens: 1024,
        ceilingPriceVersionId: 'pv_1',
        maxAmount: '0.024360000000',
        currency: 'USD',
        expiresInSeconds: 900,
      }).success,
    ).toBe(true);
  });

  it('requires an idempotency key so a retry cannot hold twice', () => {
    expect(
      usageReservationRequestSchema.safeParse({
        schemaVersion: 1,
        attribution,
        ceilingPriceVersionId: 'pv_1',
        maxAmount: '0.024360000000',
        currency: 'USD',
        expiresInSeconds: 900,
      }).success,
    ).toBe(false);
  });
});

describe('usageReservationSchema', () => {
  it('parses a live hold', () => {
    expect(usageReservationSchema.safeParse(reservation).success).toBe(true);
  });

  it('ties a settled hold to the receipt that settled it', () => {
    expect(usageReservationSchema.safeParse({ ...reservation, status: 'settled' }).success).toBe(
      false,
    );
    expect(
      usageReservationSchema.safeParse({
        ...reservation,
        status: 'settled',
        settledReceiptId: 'rcpt_1',
      }).success,
    ).toBe(true);
    expect(
      usageReservationSchema.safeParse({ ...reservation, settledReceiptId: 'rcpt_1' }).success,
    ).toBe(false);
  });
});

describe('normalizedUsageReportSchema', () => {
  it('reports units and route, never money', () => {
    const keys = Object.keys(normalizedUsageReportSchema.innerType().shape);
    expect(keys).toContain('units');
    expect(keys).toContain('resolvedModelReference');
    for (const money of ['billedAmount', 'amount', 'currency', 'upstreamCost', 'priceSnapshot']) {
      expect(keys).not.toContain(money);
    }
  });

  it('marks an estimate as an estimate', () => {
    const estimated = normalizedUsageReportSchema.parse({
      ...report,
      usageSource: 'estimated',
    });
    expect(estimated.usageSource).toBe('estimated');
    expect(
      normalizedUsageReportSchema.safeParse({ ...report, usageSource: 'probably' }).success,
    ).toBe(false);
  });

  it('rejects a request that completed before it started', () => {
    expect(
      normalizedUsageReportSchema.safeParse({
        ...report,
        completedAt: '2026-08-15T09:40:59.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects a unit reported twice instead of totalled', () => {
    expect(
      normalizedUsageReportSchema.safeParse({
        ...report,
        units: [
          { unit: 'output_tokens', quantity: 100 },
          { unit: 'output_tokens', quantity: 104 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('usageReceiptSchema', () => {
  it('settles against a copied price snapshot, not just a price version id', () => {
    const parsed = usageReceiptSchema.parse(receipt);
    expect(parsed.priceSnapshot.unitPrices).toHaveLength(1);
    expect(parsed.priceSnapshot.priceVersionId).toBe('pv_1');
  });

  it('refuses to settle in a currency it was not priced in', () => {
    expect(usageReceiptSchema.safeParse({ ...receipt, currency: 'EUR' }).success).toBe(false);
  });

  it('refuses a float amount', () => {
    expect(usageReceiptSchema.safeParse({ ...receipt, billedAmount: 3.5 }).success).toBe(false);
  });

  it('marks a BYOK settlement as a platform fee rather than a model charge', () => {
    const byok = usageReceiptSchema.parse({ ...receipt, platformFeeOnly: true });
    expect(byok.platformFeeOnly).toBe(true);
    const { platformFeeOnly, ...withoutFlag } = receipt;
    expect(platformFeeOnly).toBe(false);
    expect(usageReceiptSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('requires the units the charge was computed from', () => {
    expect(usageReceiptSchema.safeParse({ ...receipt, units: [] }).success).toBe(false);
  });
});

describe('usageRefundSchema', () => {
  it('releases an unused hold against the reservation', () => {
    expect(usageRefundSchema.safeParse(refund).success).toBe(true);
  });

  it('reverses a settled charge against the receipt, never the reservation', () => {
    expect(
      usageRefundSchema.safeParse({
        ...refund,
        reason: 'billing_correction',
        subject: { kind: 'receipt', receiptId: 'rcpt_1' },
      }).success,
    ).toBe(true);

    expect(usageRefundSchema.safeParse({ ...refund, reason: 'duplicate_charge' }).success).toBe(
      false,
    );

    expect(
      usageRefundSchema.safeParse({
        ...refund,
        subject: { kind: 'receipt', receiptId: 'rcpt_1' },
      }).success,
    ).toBe(false);
  });

  it('carries a non-negative amount whose direction is the record itself', () => {
    expect(usageRefundSchema.safeParse({ ...refund, amount: '-0.021300000000' }).success).toBe(
      false,
    );
  });

  it('is keyed so a redelivered refund releases the same money once', () => {
    const { idempotencyKey, ...withoutKey } = refund;
    expect(idempotencyKey).toBe('idem_1:release');
    expect(usageRefundSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe('priceVersionSchema', () => {
  const priceVersion = {
    schemaVersion: 1 as const,
    priceVersionId: 'pv_1',
    status: 'active' as const,
    modelReference: 'openai/gpt-5@2026-06-01',
    provider: 'openai',
    currency: 'USD',
    unitPrices: priceSnapshot.unitPrices,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-07-28T00:00:00.000Z',
  };

  it('parses the current price for a route', () => {
    expect(priceVersionSchema.safeParse(priceVersion).success).toBe(true);
  });

  it('rejects a unit priced twice', () => {
    expect(
      priceVersionSchema.safeParse({
        ...priceVersion,
        unitPrices: [...priceSnapshot.unitPrices, ...priceSnapshot.unitPrices],
      }).success,
    ).toBe(false);
  });

  it('rejects a unit price quoted in another currency', () => {
    expect(
      priceVersionSchema.safeParse({
        ...priceVersion,
        unitPrices: [{ ...priceSnapshot.unitPrices[0], currency: 'EUR' }],
      }).success,
    ).toBe(false);
  });

  it('requires a superseded version to record when it stopped applying', () => {
    expect(priceVersionSchema.safeParse({ ...priceVersion, status: 'superseded' }).success).toBe(
      false,
    );
    expect(
      priceVersionSchema.safeParse({
        ...priceVersion,
        status: 'superseded',
        effectiveUntil: '2026-08-15T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a window that closes before it opens', () => {
    expect(
      priceVersionSchema.safeParse({
        ...priceVersion,
        effectiveUntil: '2026-07-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    // The same instant spelled two ways is still the same instant.
    expect(
      priceVersionSchema.safeParse({ ...priceVersion, effectiveUntil: '2026-08-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});
