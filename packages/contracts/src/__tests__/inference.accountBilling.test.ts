/**
 * The account-billing and entitlement contracts (ADR 0014).
 *
 * Every case here asserts that a WRONG value is refused, not merely that a right
 * one is accepted. A schema test that only parses valid fixtures passes just as
 * happily against `z.any()`.
 *
 * The four properties, in the order they cost money if broken:
 *
 *  1. A grant and a purchase are never summed — the balance carries no total,
 *     and `.strict()` refuses one being added.
 *  2. Money is an exact decimal STRING; a JSON number is refused outright.
 *  3. An allowance is an integer COUNT and lives in a different shape from
 *     money, so the two cannot meet in one field.
 *  4. A setting that would silently do nothing (an enabled auto-recharge with no
 *     amount) is unrepresentable rather than merely discouraged.
 */

import {
  accountBalanceSchema,
  autoRechargeSchema,
  billingProfileSchema,
  costCenterSchema,
  planAllowanceSchema,
  productEntitlementSchema,
  reconciliationDiscrepancySchema,
  spendingLimitSchema,
  SPENDING_ALERT_THRESHOLDS_BPS,
} from '../index';

const BALANCE = {
  accountId: 'acc_1',
  currency: 'USD',
  purchasedBalance: '412.180000000000',
  promotionalBalance: '25.000000000000',
  reservedBalance: '0.045000000000',
  invoicedOutstanding: '0',
  availableToSpend: '437.180000000000',
};

const PROFILE = {
  schemaVersion: 1,
  accountId: 'acc_1',
  currency: 'USD',
  billingMode: 'prepaid',
  status: 'active',
  creditLimit: '0',
  autoRecharge: { enabled: false },
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

describe('a grant and a purchase are never one number', () => {
  it('parses the four buckets separately', () => {
    const parsed = accountBalanceSchema.parse(BALANCE);
    expect(parsed.purchasedBalance).toBe('412.180000000000');
    expect(parsed.promotionalBalance).toBe('25.000000000000');
  });

  it('refuses a total somebody tried to add', () => {
    // `.strict()`, not `.passthrough()`: a STRIPPED total is the more dangerous
    // outcome, because it vanishes here and survives in the producer, where it
    // is the number somebody eventually renders as withdrawable money.
    expect(
      accountBalanceSchema.safeParse({ ...BALANCE, totalBalance: '437.180000000000' }).success
    ).toBe(false);
  });

  it('declares no field that could hold a combined figure', () => {
    expect(Object.keys(accountBalanceSchema.shape).sort()).toEqual([
      'accountId',
      'availableToSpend',
      'currency',
      'invoicedOutstanding',
      'promotionalBalance',
      'purchasedBalance',
      'reservedBalance',
    ]);
  });
});

describe('money is an exact decimal string', () => {
  it('refuses a JSON number', () => {
    expect(accountBalanceSchema.safeParse({ ...BALANCE, purchasedBalance: 412.18 }).success).toBe(
      false
    );
  });

  it('refuses an exponent form, which survives no cache key or log grep intact', () => {
    expect(accountBalanceSchema.safeParse({ ...BALANCE, promotionalBalance: '2.5e1' }).success).toBe(
      false
    );
  });

  it('refuses a negative amount, because direction is carried by the SHAPE', () => {
    expect(
      accountBalanceSchema.safeParse({ ...BALANCE, invoicedOutstanding: '-1.000000000000' }).success
    ).toBe(false);
  });
});

describe('an enabled auto-recharge must be able to fire', () => {
  it('accepts a fully configured recharge', () => {
    expect(
      autoRechargeSchema.safeParse({
        enabled: true,
        threshold: '10.000000000000',
        amount: '50.000000000000',
      }).success
    ).toBe(true);
  });

  it('accepts amounts configured while the feature is off', () => {
    // An IMPLICATION, not a biconditional: a customer may set the amounts before
    // switching it on, and refusing that would be a worse surface than the bug.
    expect(
      autoRechargeSchema.safeParse({ enabled: false, threshold: '10.000000000000' }).success
    ).toBe(true);
  });

  it('refuses an enabled recharge with no amount — a setting that reads as on and never fires', () => {
    expect(autoRechargeSchema.safeParse({ enabled: true, threshold: '10.000000000000' }).success).toBe(
      false
    );
    expect(autoRechargeSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});

describe('a spending limit names exactly the scope target its discriminant declares', () => {
  const BASE = {
    schemaVersion: 1,
    id: 'slim_1',
    accountId: 'acc_1',
    period: 'monthly',
    limitAmount: '500.000000000000',
    currency: 'USD',
    enforcement: 'hard_stop',
    alertThresholdBps: [7500],
    status: 'active',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };

  it('accepts an application-scoped limit', () => {
    expect(
      spendingLimitSchema.safeParse({
        ...BASE,
        scope: 'application',
        scopeApplicationId: 'app_1',
      }).success
    ).toBe(true);
  });

  it('refuses a limit claiming one scope and pointing at another', () => {
    expect(
      spendingLimitSchema.safeParse({ ...BASE, scope: 'application', scopeAccountId: 'acc_2' })
        .success
    ).toBe(false);
  });

  it('refuses a limit naming two scope targets at once', () => {
    expect(
      spendingLimitSchema.safeParse({
        ...BASE,
        scope: 'application',
        scopeApplicationId: 'app_1',
        scopeAccountId: 'acc_2',
      }).success
    ).toBe(false);
  });

  it('refuses an alert threshold outside the closed set', () => {
    expect(
      spendingLimitSchema.safeParse({
        ...BASE,
        scope: 'application',
        scopeApplicationId: 'app_1',
        alertThresholdBps: [8123],
      }).success
    ).toBe(false);
    expect(SPENDING_ALERT_THRESHOLDS_BPS).toEqual([2500, 5000, 7500, 9000, 10000]);
  });
});

describe('an allowance is a count and can never be an amount', () => {
  it('refuses a fractional allowance', () => {
    expect(planAllowanceSchema.safeParse({ key: 'api_credits_free', included: 10.5 }).success).toBe(
      false
    );
  });

  it('refuses an allowance expressed as money', () => {
    expect(
      planAllowanceSchema.safeParse({ key: 'api_credits_free', included: '10.000000000000' })
        .success
    ).toBe(false);
  });

  it('keeps allowances and money in disjoint sections of the entitlement', () => {
    const entitlement = productEntitlementSchema.parse({
      schemaVersion: 1,
      accountId: 'acc_1',
      plan: null,
      allowances: [{ key: 'api_credits_free', included: 1000, remaining: 640 }],
      payAsYouGo: {
        billingAccountId: 'acc_1',
        currency: 'USD',
        billingMode: 'prepaid',
        purchasedBalance: '412.180000000000',
        promotionalBalance: '25.000000000000',
        availableToSpend: '437.180000000000',
        canSpend: true,
      },
      costCenter: null,
      resolvedAt: '2026-08-15T09:41:03.100Z',
    });

    expect(typeof entitlement.allowances[0].included).toBe('number');
    expect(typeof entitlement.payAsYouGo?.purchasedBalance).toBe('string');
    // No key on the entitlement is both.
    expect(Object.keys(entitlement).sort()).toEqual([
      'accountId',
      'allowances',
      'costCenter',
      'payAsYouGo',
      'plan',
      'resolvedAt',
      'schemaVersion',
    ]);
  });

  it('distinguishes an absent pay-as-you-go position from a zero one', () => {
    // `null` means "nobody has decided who pays for this account yet"; a zero
    // balance means "spent everything". A consumer reading them alike would
    // either refuse an unprovisioned customer or serve an uncharageable one.
    const absent = productEntitlementSchema.parse({
      schemaVersion: 1,
      accountId: 'acc_1',
      plan: null,
      allowances: [],
      payAsYouGo: null,
      costCenter: null,
      resolvedAt: '2026-08-15T09:41:03.100Z',
    });
    expect(absent.payAsYouGo).toBeNull();
  });
});

describe('a reconciliation finding carries the evidence that makes it actionable', () => {
  const BASE = {
    schemaVersion: 1,
    id: 'bdis_1',
    runId: 'brun_1',
    currency: 'USD',
    createdAt: '2026-08-15T01:00:06.000Z',
  };

  it('accepts a missing_in_ledger finding with the processor side', () => {
    expect(
      reconciliationDiscrepancySchema.safeParse({
        ...BASE,
        kind: 'missing_in_ledger',
        externalRef: 'pi_1',
        externalAmount: '50.000000000000',
      }).success
    ).toBe(true);
  });

  it('refuses a kind outside the closed set', () => {
    expect(
      reconciliationDiscrepancySchema.safeParse({ ...BASE, kind: 'probably_fine' }).success
    ).toBe(false);
  });
});

describe('the profile and cost-centre shapes are strict', () => {
  it('refuses an unknown field on a billing profile', () => {
    expect(billingProfileSchema.safeParse({ ...PROFILE, stripeCustomerId: 'cus_1' }).success).toBe(
      false
    );
  });

  it('refuses a cost-centre slug that could not be stored', () => {
    const base = {
      schemaVersion: 1,
      accountId: 'acc_1',
      label: 'Codea',
      status: 'active',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    expect(costCenterSchema.safeParse({ ...base, slug: 'codea' }).success).toBe(true);
    // The same grammar the column CHECK holds, so a slug cannot be storable and
    // unserialisable or the reverse.
    expect(costCenterSchema.safeParse({ ...base, slug: 'Codea' }).success).toBe(false);
    expect(costCenterSchema.safeParse({ ...base, slug: '-codea' }).success).toBe(false);
  });
});
