/**
 * The reporting projections carry their own guarantees (issue #972, workstream 8).
 *
 * Four claims, each with the control that tells you the assertion is measuring
 * something:
 *
 *  1. **A usage row cannot carry money, and no projection can carry Oxy's
 *     upstream wholesale cost.** Every "must be rejected" case is paired with the
 *     same object WITHOUT the offending key, which must parse — otherwise a
 *     fixture that was simply invalid would look like a guard firing.
 *  2. **Provenance is not optional and not swappable.** A usage report stamped
 *     `financial_ledger`, or a spend report stamped `eventual`, is refused.
 *  3. **The unit vocabulary is covered in BOTH directions.** A map that merely
 *     skipped what it did not know would be no gate at all.
 *  4. **Query schemas survive re-parse.** `middleware/validate` replaces
 *     `req.query` and the handler parses it again; if that were not idempotent
 *     every one of these endpoints would 400 on its own validated input.
 */

import { USAGE_UNITS } from '@oxyhq/contracts';
import {
  accountBalanceSchema,
  applicationSpendReportQuery,
  applicationUsageReportQuery,
  chargeExportQuery,
  chargeListQuery,
  LEDGER_AUTHORITATIVE_NOTE,
  pendingReservationsSchema,
  reservationListQuery,
  settledChargesSchema,
  spendingLimitCreateBody,
  spendingLimitUpdateBody,
  spendingLimitsSchema,
  spendReportQuery,
  spendReportSchema,
  usageAggregateRowSchema,
  usageReportQuery,
  usageReportSchema,
  USAGE_EVENTUAL_CONSISTENCY_NOTE,
  usageUnitTotalsSchema,
} from '../inferenceReporting.schemas';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const zeroUnits = Object.fromEntries(USAGE_UNITS.map((unit) => [unit, 0]));

const usageReport = {
  schemaVersion: 1,
  consistency: 'eventual',
  source: 'usage_telemetry_rollups',
  note: USAGE_EVENTUAL_CONSISTENCY_NOTE,
  range: { from: '2026-08-01', to: '2026-08-15' },
  groupBy: ['day'],
  rows: [{ day: '2026-08-01', requestCount: 3, errorCount: 1, units: zeroUnits }],
  truncated: false,
};

const spendReport = {
  schemaVersion: 1,
  consistency: 'authoritative',
  source: 'financial_ledger',
  note: LEDGER_AUTHORITATIVE_NOTE,
  range: { from: '2026-08-01', to: '2026-08-15' },
  groupBy: ['day'],
  rows: [
    {
      day: '2026-08-01',
      currency: 'USD',
      receiptCount: 2,
      billedAmount: '1.500000000000',
      refundedAmount: '0.000000000000',
      netAmount: '1.500000000000',
    },
  ],
  totals: [
    {
      currency: 'USD',
      receiptCount: 2,
      billedAmount: '1.500000000000',
      refundedAmount: '0.000000000000',
      netAmount: '1.500000000000',
    },
  ],
  truncated: false,
};

const accountBalance = {
  schemaVersion: 1,
  consistency: 'authoritative',
  source: 'financial_ledger',
  note: LEDGER_AUTHORITATIVE_NOTE,
  accountId: 'acct_1',
  provisioned: true,
  billingAccountId: 'acct_1',
  billingMode: 'prepaid',
  creditLimit: '0.000000000000',
  balances: [
    {
      currency: 'USD',
      purchased: '10.000000000000',
      promotional: '2.000000000000',
      reserved: '0.500000000000',
      invoicedOutstanding: '0.000000000000',
      availableToSpend: '12.000000000000',
    },
  ],
};

const settledCharges = {
  schemaVersion: 1,
  consistency: 'authoritative',
  source: 'financial_ledger',
  note: LEDGER_AUTHORITATIVE_NOTE,
  range: { from: '2026-08-01', to: '2026-08-15' },
  rows: [
    {
      receiptId: 'rcpt_1',
      requestId: 'req_1',
      applicationId: 'app_1',
      applicationCredentialId: 'cred_1',
      environment: 'production',
      outcome: 'completed',
      usageSource: 'provider_reported',
      resolvedModelReference: 'openai/gpt-x',
      servingProvider: 'openai',
      platformFeeOnly: false,
      billedAmount: '1.000000000000',
      refundedAmount: '0.000000000000',
      netAmount: '1.000000000000',
      currency: 'USD',
      settledAt: '2026-08-01T10:00:00.000Z',
      units: zeroUnits,
    },
  ],
  truncated: false,
};

const pendingReservations = {
  schemaVersion: 1,
  consistency: 'authoritative',
  source: 'financial_ledger',
  note: LEDGER_AUTHORITATIVE_NOTE,
  rows: [
    {
      reservationId: 'res_1',
      requestId: 'req_1',
      applicationId: 'app_1',
      applicationCredentialId: 'cred_1',
      environment: 'production',
      reservedAmount: '2.000000000000',
      currency: 'USD',
      createdAt: '2026-08-01T10:00:00.000Z',
      expiresAt: '2026-08-01T10:05:00.000Z',
    },
  ],
  totals: [{ currency: 'USD', reservationCount: 1, heldAmount: '2.000000000000' }],
  truncated: false,
};

const spendingLimits = {
  schemaVersion: 1,
  consistency: 'authoritative',
  source: 'financial_ledger',
  note: LEDGER_AUTHORITATIVE_NOTE,
  rows: [
    {
      spendingLimitId: 'lim_1',
      accountId: 'acct_1',
      scope: 'account',
      scopeAccountId: 'acct_1',
      period: 'monthly',
      limitAmount: '100.000000000000',
      currency: 'USD',
      enforcement: 'hard_stop',
      alertThresholdBps: [7500],
      status: 'active',
      periodStart: '2026-08-01T00:00:00.000Z',
      currentSpend: '25.000000000000',
      remaining: '75.000000000000',
      utilizationBps: 2500,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  1. Upstream wholesale cost is unreachable                                 */
/* -------------------------------------------------------------------------- */

/**
 * The names a wholesale cost would arrive under.
 *
 * Taken from the columns that actually hold it —
 * `inference_deployments.upstream_wholesale_cost_{amount,currency,unit,per}` —
 * rather than invented, so this list names the real leak rather than a plausible
 * one.
 */
const WHOLESALE_KEYS = [
  'upstreamWholesaleCost',
  'upstreamWholesaleCostAmount',
  'upstreamWholesaleCostCurrency',
  'wholesaleCost',
  'upstreamCost',
] as const;

describe('no customer projection can carry Oxy upstream wholesale cost', () => {
  const projections = [
    ['usage report', usageReportSchema, usageReport],
    ['spend report', spendReportSchema, spendReport],
    ['account balance', accountBalanceSchema, accountBalance],
    ['settled charges', settledChargesSchema, settledCharges],
    ['pending reservations', pendingReservationsSchema, pendingReservations],
    ['spending limits', spendingLimitsSchema, spendingLimits],
  ] as const;

  test.each(projections)('POSITIVE CONTROL: %s parses without one', (_name, schema, fixture) => {
    // Without this, every rejection below would also be produced by a fixture
    // that was simply malformed, and the guard would be untested.
    expect(schema.safeParse(fixture).success).toBe(true);
  });

  test.each(projections)('%s refuses one at the envelope', (_name, schema, fixture) => {
    for (const key of WHOLESALE_KEYS) {
      expect(schema.safeParse({ ...fixture, [key]: '0.01' }).success).toBe(false);
    }
  });

  it('refuses one on a usage ROW, where a per-model cost would actually be put', () => {
    const row = usageReport.rows[0];
    expect(usageAggregateRowSchema.safeParse(row).success).toBe(true);
    for (const key of WHOLESALE_KEYS) {
      expect(usageAggregateRowSchema.safeParse({ ...row, [key]: '0.01' }).success).toBe(false);
    }
  });

  it('refuses one on a settled CHARGE row', () => {
    for (const key of WHOLESALE_KEYS) {
      const poisoned = {
        ...settledCharges,
        rows: [{ ...settledCharges.rows[0], [key]: '0.01' }],
      };
      expect(settledChargesSchema.safeParse(poisoned).success).toBe(false);
    }
  });
});

describe('a usage row carries units, never money', () => {
  it('has no money-shaped field at all', () => {
    const keys = Object.keys(usageAggregateRowSchema.shape);
    // Vacuity floor: the shape was read, and it is the shape we think it is.
    expect(keys).toContain('requestCount');
    expect(keys).toContain('units');
    for (const money of [
      'billedAmount',
      'netAmount',
      'refundedAmount',
      'currency',
      'amount',
      'cost',
      'priceSnapshot',
    ]) {
      expect(keys).not.toContain(money);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Provenance is required and not swappable                               */
/* -------------------------------------------------------------------------- */

describe('a report states where its numbers came from', () => {
  it('refuses a usage report claiming the financial ledger', () => {
    expect(
      usageReportSchema.safeParse({ ...usageReport, source: 'financial_ledger' }).success
    ).toBe(false);
    expect(
      usageReportSchema.safeParse({ ...usageReport, consistency: 'authoritative' }).success
    ).toBe(false);
  });

  it('refuses a spend report claiming eventual consistency', () => {
    expect(
      spendReportSchema.safeParse({ ...spendReport, consistency: 'eventual' }).success
    ).toBe(false);
    expect(
      spendReportSchema.safeParse({ ...spendReport, source: 'usage_telemetry_rollups' }).success
    ).toBe(false);
  });

  it('refuses a report that omits its provenance entirely', () => {
    for (const field of ['schemaVersion', 'consistency', 'source', 'note'] as const) {
      const stripped: Record<string, unknown> = { ...usageReport };
      delete stripped[field];
      expect(usageReportSchema.safeParse(stripped).success).toBe(false);
    }
  });

  it('refuses a rewritten eventual-consistency note', () => {
    expect(
      usageReportSchema.safeParse({ ...usageReport, note: 'usage is always accurate' }).success
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The unit vocabulary is covered in both directions                      */
/* -------------------------------------------------------------------------- */

describe('every metered unit has a reported total', () => {
  it('the reported shape and USAGE_UNITS are the same set', () => {
    const reported = Object.keys(usageUnitTotalsSchema.shape).sort();
    const contract = [...USAGE_UNITS].sort();
    // A floor, so an empty-vs-empty comparison could never pass for free.
    expect(reported.length).toBeGreaterThanOrEqual(11);
    expect(reported).toEqual(contract);
  });

  it('refuses a unit total the contract does not name', () => {
    expect(usageUnitTotalsSchema.safeParse(zeroUnits).success).toBe(true);
    expect(
      usageUnitTotalsSchema.safeParse({ ...zeroUnits, thoughts: 1 }).success
    ).toBe(false);
  });

  it('refuses a usage row missing one unit', () => {
    const partial: Record<string, unknown> = { ...zeroUnits };
    delete partial.output_tokens;
    expect(
      usageAggregateRowSchema.safeParse({ ...usageReport.rows[0], units: partial }).success
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Query schemas survive re-parse                                         */
/* -------------------------------------------------------------------------- */

describe('a query schema parses its own output unchanged', () => {
  const cases: [string, { parse: (value: unknown) => unknown }, Record<string, unknown>][] = [
    ['usage', usageReportQuery, { from: '2026-08-01', to: '2026-08-15', groupBy: 'day,provider' }],
    [
      'spend',
      spendReportQuery,
      { from: '2026-08-01', to: '2026-08-15', groupBy: 'day,resolvedModel' },
    ],
    ['application usage', applicationUsageReportQuery, { from: '2026-08-01', to: '2026-08-15' }],
    ['application spend', applicationSpendReportQuery, { from: '2026-08-01', to: '2026-08-15' }],
    ['reservations', reservationListQuery, { limit: '25', includeDescendants: 'true' }],
    ['charges', chargeListQuery, { from: '2026-08-01', to: '2026-08-15', limit: '10' }],
    ['export', chargeExportQuery, { from: '2026-08-01', to: '2026-08-15' }],
  ];

  test.each(cases)('%s', (_name, schema, raw) => {
    const once = schema.parse(raw);
    const twice = schema.parse(once);
    expect(twice).toEqual(once);
  });
});

describe('grouping and flags are read exactly as written', () => {
  it('splits a comma-separated groupBy and drops duplicates', () => {
    const parsed = usageReportQuery.parse({
      from: '2026-08-01',
      to: '2026-08-02',
      groupBy: 'day, provider ,day',
    });
    expect(parsed.groupBy).toEqual(['day', 'provider']);
  });

  it('defaults to grouping by day', () => {
    const parsed = usageReportQuery.parse({ from: '2026-08-01', to: '2026-08-02' });
    expect(parsed.groupBy).toEqual(['day']);
  });

  it('refuses a dimension it does not serve', () => {
    expect(
      usageReportQuery.safeParse({ from: '2026-08-01', to: '2026-08-02', groupBy: 'latency' })
        .success
    ).toBe(false);
    // `resolvedModel` is a SPEND dimension; a rollup keys on the REQUESTED model.
    expect(
      usageReportQuery.safeParse({
        from: '2026-08-01',
        to: '2026-08-02',
        groupBy: 'resolvedModel',
      }).success
    ).toBe(false);
  });

  it('reads includeDescendants=false as false, not as "a value was sent"', () => {
    const off = usageReportQuery.parse({
      from: '2026-08-01',
      to: '2026-08-02',
      includeDescendants: 'false',
    });
    expect(off.includeDescendants).toBe(false);

    const on = usageReportQuery.parse({
      from: '2026-08-01',
      to: '2026-08-02',
      includeDescendants: 'true',
    });
    expect(on.includeDescendants).toBe(true);

    const absent = usageReportQuery.parse({ from: '2026-08-01', to: '2026-08-02' });
    expect(absent.includeDescendants).toBe(false);

    expect(
      usageReportQuery.safeParse({
        from: '2026-08-01',
        to: '2026-08-02',
        includeDescendants: 'yes',
      }).success
    ).toBe(false);
  });
});

describe('a report window is bounded', () => {
  it('accepts an ordinary month', () => {
    expect(usageReportQuery.safeParse({ from: '2026-08-01', to: '2026-08-31' }).success).toBe(
      true
    );
  });

  it('refuses a backwards range', () => {
    expect(usageReportQuery.safeParse({ from: '2026-08-31', to: '2026-08-01' }).success).toBe(
      false
    );
  });

  it('refuses a range past the ceiling', () => {
    expect(usageReportQuery.safeParse({ from: '2024-01-01', to: '2026-08-01' }).success).toBe(
      false
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Budget bodies                                                          */
/* -------------------------------------------------------------------------- */

describe('a budget body cannot express a contradiction', () => {
  const account = {
    scope: 'account',
    scopeAccountId: 'acct_1',
    period: 'monthly',
    limitAmount: '100',
  };

  it('POSITIVE CONTROL: a well-formed account budget parses', () => {
    const parsed = spendingLimitCreateBody.parse(account);
    expect(parsed.scope).toBe('account');
    expect(parsed.enforcement).toBe('hard_stop');
    expect(parsed.alertThresholdBps).toEqual([]);
  });

  it('refuses an account scope naming an application', () => {
    expect(
      spendingLimitCreateBody.safeParse({ ...account, scopeApplicationId: 'app_1' }).success
    ).toBe(false);
  });

  it('refuses a ceiling of zero, which would refuse every request', () => {
    expect(spendingLimitCreateBody.safeParse({ ...account, limitAmount: '0' }).success).toBe(
      false
    );
    expect(spendingLimitCreateBody.safeParse({ ...account, limitAmount: '0.01' }).success).toBe(
      true
    );
  });

  it('refuses a float or a negative ceiling', () => {
    expect(spendingLimitCreateBody.safeParse({ ...account, limitAmount: 100 }).success).toBe(
      false
    );
    expect(spendingLimitCreateBody.safeParse({ ...account, limitAmount: '-1' }).success).toBe(
      false
    );
  });

  it('refuses an alert threshold outside the closed set, and sorts the rest', () => {
    expect(
      spendingLimitCreateBody.safeParse({ ...account, alertThresholdBps: [3000] }).success
    ).toBe(false);
    const parsed = spendingLimitCreateBody.parse({
      ...account,
      alertThresholdBps: [10000, 5000, 5000],
    });
    expect(parsed.alertThresholdBps).toEqual([5000, 10000]);
  });

  it('refuses an empty edit', () => {
    expect(spendingLimitUpdateBody.safeParse({}).success).toBe(false);
    expect(spendingLimitUpdateBody.safeParse({ status: 'disabled' }).success).toBe(true);
  });

  it('refuses an attempt to re-point a budget by editing its scope', () => {
    expect(
      spendingLimitUpdateBody.safeParse({ scopeApplicationId: 'app_2' }).success
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. A balance keeps its buckets apart                                      */
/* -------------------------------------------------------------------------- */

describe('a balance is never one number', () => {
  it('names purchased, promotional and reserved separately', () => {
    const parsed = accountBalanceSchema.parse(accountBalance);
    const bucket = parsed.balances[0];
    expect(bucket.purchased).toBe('10.000000000000');
    expect(bucket.promotional).toBe('2.000000000000');
    expect(bucket.reserved).toBe('0.500000000000');
    // A single collapsed field would have to be introduced to break this.
    expect(Object.keys(bucket)).not.toContain('balance');
    expect(Object.keys(bucket)).not.toContain('total');
  });

  it('refuses a bucket that omits one of them', () => {
    for (const field of ['purchased', 'promotional', 'reserved'] as const) {
      const bucket: Record<string, unknown> = { ...accountBalance.balances[0] };
      delete bucket[field];
      expect(
        accountBalanceSchema.safeParse({ ...accountBalance, balances: [bucket] }).success
      ).toBe(false);
    }
  });

  it('refuses an unprovisioned account that somehow carries a balance', () => {
    expect(
      accountBalanceSchema.safeParse({
        ...accountBalance,
        provisioned: false,
        billingAccountId: undefined,
      }).success
    ).toBe(false);
  });

  it('POSITIVE CONTROL: an unprovisioned account with no balance parses', () => {
    expect(
      accountBalanceSchema.safeParse({
        schemaVersion: 1,
        consistency: 'authoritative',
        source: 'financial_ledger',
        note: LEDGER_AUTHORITATIVE_NOTE,
        accountId: 'acct_9',
        provisioned: false,
        balances: [],
      }).success
    ).toBe(true);
  });
});
