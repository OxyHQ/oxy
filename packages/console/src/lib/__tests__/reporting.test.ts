import { describe, expect, it } from 'vitest';
import type {
  Budget,
  BudgetAlert,
  LedgerBalanceBucket,
  PendingReservation,
  SettledCharge,
  SpendRow,
  UsageRow,
  UsageUnitTotals,
} from '@/lib/reporting';
import {
  SPEND_DIMENSIONS,
  USAGE_DIMENSIONS,
  budgetScopeDescription,
  budgetUtilizationVariant,
  lastCalendarDays,
  provenanceExplanation,
  provenanceHeadline,
  spendDimensionValue,
  toBudget,
  toBudgetAlert,
  toLedgerBalanceBucket,
  toPendingReservation,
  toSettledCharge,
  toSpendRow,
  toUsageRow,
  usageDimensionValue,
} from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;
const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;

function units(): UsageUnitTotals {
  return {
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 20,
    reasoning_tokens: 0,
    requests: 1,
    images: 0,
    audio_input_milliseconds: 0,
    audio_output_milliseconds: 0,
    video_milliseconds: 0,
    characters: 0,
    embeddings: 0,
  };
}

function usageRow(): UsageRow {
  return {
    day: '2026-08-01',
    applicationId: 'app_1',
    requestCount: 3,
    errorCount: 1,
    units: units(),
  };
}

function spendRow(): SpendRow {
  return {
    day: '2026-08-01',
    applicationId: 'app_1',
    currency: 'USD',
    receiptCount: 3,
    billedAmount: '1.500000000000',
    refundedAmount: '0.000000000000',
    netAmount: '1.500000000000',
  };
}

/*
 * The projections' whole job is to be an ALLOWLIST: a field the API adds that
 * nobody has listed must not reach a component. `Object.assign` is used rather
 * than a cast so the polluted fixture is built without `as any` — the result is
 * still assignable to the row type, which is exactly the situation a widened API
 * response produces at runtime.
 */
describe('projections drop what they do not name', () => {
  it('drops an unlisted field from a usage row', () => {
    const polluted = Object.assign(usageRow(), {
      upstreamWholesaleCost: '0.42',
      internalRouteId: 'route_secret',
    });

    const view = toUsageRow(polluted);

    expect(Object.hasOwn(view, 'upstreamWholesaleCost')).toBe(false);
    expect(Object.hasOwn(view, 'internalRouteId')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('0.42');
    expect(JSON.stringify(view)).not.toContain('route_secret');
    // The positive control: the fields that SHOULD survive did, so a projection
    // that simply returned `{}` would not pass this test.
    expect(view.requestCount).toBe(3);
    expect(view.units.output_tokens).toBe(20);
  });

  it('drops an unlisted field from a spend row', () => {
    const polluted = Object.assign(spendRow(), { upstreamWholesaleCost: '0.42' });

    const view = toSpendRow(polluted);

    expect(Object.hasOwn(view, 'upstreamWholesaleCost')).toBe(false);
    expect(view.netAmount).toBe('1.500000000000');
  });

  it('drops an unlisted field from a settled charge, nested units included', () => {
    const charge: SettledCharge = {
      receiptId: 'rcpt_1',
      requestId: 'req_1',
      applicationId: 'app_1',
      applicationCredentialId: 'cred_1',
      environment: 'production',
      outcome: 'completed',
      usageSource: 'provider_reported',
      resolvedModelReference: 'vendor/model@1',
      servingProvider: 'vendor',
      platformFeeOnly: false,
      billedAmount: '0.010000000000',
      refundedAmount: '0.000000000000',
      netAmount: '0.010000000000',
      currency: 'USD',
      settledAt: '2026-08-01T00:00:00.000Z',
      units: Object.assign(units(), { deploymentId: 'deploy_secret' }),
    };

    const view = toSettledCharge(Object.assign(charge, { upstreamWholesaleCost: '0.001' }));

    expect(Object.hasOwn(view, 'upstreamWholesaleCost')).toBe(false);
    expect(Object.hasOwn(view.units, 'deploymentId')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('deploy_secret');
    expect(view.receiptId).toBe('rcpt_1');
  });

  it('drops an unlisted field from a reservation, a budget and a balance bucket', () => {
    const reservation: PendingReservation = {
      reservationId: 'res_1',
      requestId: 'req_1',
      applicationId: 'app_1',
      applicationCredentialId: 'cred_1',
      environment: 'production',
      reservedAmount: '0.050000000000',
      currency: 'USD',
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:05:00.000Z',
    };
    const budget: Budget = {
      spendingLimitId: 'lim_1',
      accountId: 'acct_1',
      scope: 'application',
      scopeApplicationId: 'app_1',
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
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const bucket: LedgerBalanceBucket = {
      currency: 'USD',
      purchased: '10.000000000000',
      promotional: '5.000000000000',
      reserved: '1.000000000000',
      invoicedOutstanding: '0.000000000000',
      availableToSpend: '15.000000000000',
    };

    expect(
      Object.hasOwn(toPendingReservation(Object.assign(reservation, { secretRef: 'vault:x' })), 'secretRef')
    ).toBe(false);
    expect(
      Object.hasOwn(toBudget(Object.assign(budget, { internalNote: 'x' })), 'internalNote')
    ).toBe(false);
    expect(
      Object.hasOwn(
        toLedgerBalanceBucket(Object.assign(bucket, { wholesaleCost: '1' })),
        'wholesaleCost'
      )
    ).toBe(false);
  });

  it('drops an unlisted field from a budget threshold crossing', () => {
    const alert: BudgetAlert = {
      alertId: 'alert_1',
      spendingLimitId: 'lim_1',
      periodStart: '2026-08-01T00:00:00.000Z',
      thresholdBps: 7500,
      spendAmount: '75.000000000000',
      createdAt: '2026-08-10T00:00:00.000Z',
    };

    const view = toBudgetAlert(Object.assign(alert, { internalRouteId: 'route_secret' }));

    expect(Object.hasOwn(view, 'internalRouteId')).toBe(false);
    expect(view.thresholdBps).toBe(7500);
    expect(view.spendAmount).toBe('75.000000000000');
  });

  it('copies the alert thresholds rather than aliasing the response array', () => {
    const source: Budget = {
      spendingLimitId: 'lim_1',
      accountId: 'acct_1',
      scope: 'account',
      scopeAccountId: 'acct_1',
      period: 'daily',
      limitAmount: '10.00',
      currency: 'USD',
      enforcement: 'soft_stop',
      alertThresholdBps: [5000],
      status: 'active',
      periodStart: '2026-08-01T00:00:00.000Z',
      currentSpend: '0.00',
      remaining: '10.00',
      utilizationBps: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };

    expect(toBudget(source).alertThresholdBps).not.toBe(source.alertThresholdBps);
    expect(toBudget(source).alertThresholdBps).toEqual([5000]);
  });
});

describe('provenance', () => {
  it('says two different things, and only the telemetry one warns off reconciliation', () => {
    expect(provenanceHeadline(LEDGER)).not.toBe(provenanceHeadline(TELEMETRY));
    expect(provenanceHeadline(LEDGER)).toContain('ledger');
    expect(provenanceHeadline(TELEMETRY)).toContain('telemetry');

    expect(provenanceExplanation(TELEMETRY)).toContain('Do not reconcile a bill');
    expect(provenanceExplanation(LEDGER)).not.toContain('Do not reconcile a bill');
    expect(provenanceExplanation(LEDGER)).toContain('authoritative');
  });
});

describe('dimension vocabularies', () => {
  /**
   * The two lists are deliberately not interchangeable: a usage row records the
   * model that was ASKED for, a spend row the one that actually served and was
   * priced. If these ever became one list, a fallback would make the two reports
   * silently claim to be grouped by the same thing.
   */
  it('differ exactly in how they name the model', () => {
    const usageOnly = USAGE_DIMENSIONS.filter(
      (dimension) => !(SPEND_DIMENSIONS as ReadonlyArray<string>).includes(dimension)
    );
    const spendOnly = SPEND_DIMENSIONS.filter(
      (dimension) => !(USAGE_DIMENSIONS as ReadonlyArray<string>).includes(dimension)
    );

    expect(usageOnly).toEqual(['requestedModel']);
    expect(spendOnly).toEqual(['resolvedModel']);
  });

  it('renders an em dash for a dimension the row was not grouped by', () => {
    expect(usageDimensionValue(usageRow(), 'application')).toBe('app_1');
    expect(usageDimensionValue(usageRow(), 'provider')).toBe('—');
    expect(spendDimensionValue(spendRow(), 'day')).toBe('2026-08-01');
    expect(spendDimensionValue(spendRow(), 'resolvedModel')).toBe('—');
  });
});

describe('budget presentation', () => {
  const base: Budget = {
    spendingLimitId: 'lim_1',
    accountId: 'acct_1',
    scope: 'account',
    scopeAccountId: 'acct_1',
    period: 'monthly',
    limitAmount: '100.00',
    currency: 'USD',
    enforcement: 'hard_stop',
    alertThresholdBps: [],
    status: 'active',
    periodStart: '2026-08-01T00:00:00.000Z',
    currentSpend: '0.00',
    remaining: '100.00',
    utilizationBps: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('names the scope by its own target', () => {
    expect(budgetScopeDescription(base)).toContain('acct_1');
    expect(
      budgetScopeDescription({ ...base, scope: 'application', scopeApplicationId: 'app_9' })
    ).toContain('app_9');
    expect(
      budgetScopeDescription({
        ...base,
        scope: 'credential',
        scopeApplicationCredentialId: 'cred_9',
      })
    ).toContain('cred_9');
  });

  it('tones a full budget differently from a disabled one', () => {
    expect(budgetUtilizationVariant(base)).toBe('default');
    expect(budgetUtilizationVariant({ ...base, utilizationBps: 10000 })).toBe('destructive');
    // A disabled budget refuses nothing, whatever its utilisation reads.
    expect(budgetUtilizationVariant({ ...base, status: 'disabled', utilizationBps: 10000 })).toBe(
      'secondary'
    );
  });
});

describe('lastCalendarDays', () => {
  /**
   * UTC on both ends, because the rollups are bucketed in UTC. A range derived
   * from the browser's local day would ask for a window whose edges do not line
   * up with any row, and the missing traffic would read as a quiet day.
   */
  it('is inclusive of today and spans exactly the requested number of days', () => {
    expect(lastCalendarDays(1, new Date('2026-08-15T12:00:00.000Z'))).toEqual({
      from: '2026-08-15',
      to: '2026-08-15',
    });
    expect(lastCalendarDays(7, new Date('2026-08-15T12:00:00.000Z'))).toEqual({
      from: '2026-08-09',
      to: '2026-08-15',
    });
  });

  it('crosses month and year boundaries', () => {
    expect(lastCalendarDays(7, new Date('2026-03-03T00:30:00.000Z'))).toEqual({
      from: '2026-02-25',
      to: '2026-03-03',
    });
    expect(lastCalendarDays(30, new Date('2026-01-05T23:59:00.000Z'))).toEqual({
      from: '2025-12-07',
      to: '2026-01-05',
    });
  });

  it('reads the instant in UTC, not in the local zone', () => {
    // Late-evening UTC is already the next day in some zones and the previous
    // day in others; the answer must not depend on where the browser is.
    expect(lastCalendarDays(1, new Date('2026-08-15T23:59:59.000Z')).to).toBe('2026-08-15');
    expect(lastCalendarDays(1, new Date('2026-08-15T00:00:00.000Z')).to).toBe('2026-08-15');
  });
});
