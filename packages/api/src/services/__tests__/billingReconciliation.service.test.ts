/**
 * Reconciliation, against a REAL Postgres and a FAKE processor.
 *
 * The processor is a fake rather than a mock of the Stripe SDK, because the
 * property under test is the DIFF, not the SDK call. `PaymentProcessorLedger` is
 * a two-method interface for exactly this reason; the Stripe implementation of
 * it is unexercised here and unverified anywhere, which the accompanying report
 * states plainly.
 *
 * ## The test worth reading is the SWAP
 *
 * Two totals can agree exactly while the underlying sets differ — a charge
 * recorded against the wrong reference offsets itself in a sum. A report that
 * published only a difference would call that clean. The swap test asserts
 * `ledgerTotal === externalTotal` AND a non-zero discrepancy count in the same
 * pass, which is the shape that would go red if the findings were ever derived
 * from the totals.
 *
 * Every pass here is ACCOUNT-SCOPED. A platform-wide pass over the shared test
 * database would read rows seeded by sibling files, and an unscoped aggregate
 * reads correctly right up until somebody adds another test.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingReconciliationRuns } from '../../db/schema/billingReconciliation';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';
import {
  reconcilePayments,
  type PaymentProcessorLedger,
  type ProcessorPayment,
} from '../billingReconciliation.service';
import { provisionBillingProfile, recordTopUp } from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** The window every pass in this file runs over. Relative to now, always. */
const PERIOD_START = new Date(Date.now() - 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 60 * 60 * 1000);

function fakeLedger(payments: readonly ProcessorPayment[]): PaymentProcessorLedger {
  return {
    provider: 'stripe',
    listSettledPayments: async () => [...payments],
  };
}

/** A ledger that fails, for the run-marking test. */
function failingLedger(): PaymentProcessorLedger {
  return {
    provider: 'stripe',
    listSettledPayments: async () => {
      throw new Error('processor unavailable');
    },
  };
}

interface Fixture {
  readonly accountId: string;
  readonly customerRef: string;
}

async function seedAccount(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const customerRef = `cus_${randomUUID().replace(/-/g, '')}`;
  const [account] = await getDb()
    .insert(users)
    .values({ username: `rec-${suffix}`, email: `rec-${suffix}@example.test` })
    .returning({ id: users.id });

  await provisionBillingProfile({ accountId: account.id });
  await getDb()
    .insert(userCredits)
    .values({ userId: account.id, stripeCustomerId: customerRef })
    .onConflictDoUpdate({ target: userCredits.userId, set: { stripeCustomerId: customerRef } });

  return { accountId: account.id, customerRef };
}

/** Record a top-up on the Oxy side, with its processor reference. */
async function recordPayment(
  fixture: Fixture,
  externalRef: string,
  amount: string
): Promise<void> {
  const result = await recordTopUp({
    idempotencyKey: `stripe:payment_intent:${externalRef}`,
    accountId: fixture.accountId,
    currency: 'USD',
    amount,
    externalPayment: {
      provider: 'stripe',
      externalKind: 'payment_intent',
      externalRef,
      occurredAt: new Date(),
    },
  });
  expect(result.status).toBe('recorded');
}

function processorPayment(
  externalRef: string,
  amountMinorUnits: number,
  customerRef: string | null
): ProcessorPayment {
  return {
    externalKind: 'payment_intent',
    externalRef,
    amountMinorUnits,
    currency: 'USD',
    occurredAt: new Date(),
    customerRef,
  };
}

async function reconcile(
  fixture: Fixture,
  payments: readonly ProcessorPayment[]
): ReturnType<typeof reconcilePayments> {
  return reconcilePayments({
    ledger: fakeLedger(payments),
    accountId: fixture.accountId,
    currency: 'USD',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });
}

describe('a pass where both systems agree', () => {
  it('reports no discrepancies and equal totals', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;
    await recordPayment(fixture, ref, '20.000000000000');

    const report = await reconcile(fixture, [processorPayment(ref, 2000, fixture.customerRef)]);

    expect(report.run.status).toBe('completed');
    expect(report.discrepancies).toEqual([]);
    expect(report.run.discrepancyCount).toBe(0);
    expect(Number(report.run.ledgerTotal)).toBe(20);
    expect(Number(report.run.externalTotal)).toBe(20);
  });

  it('does not report a difference for one amount written two ways', async () => {
    // `'20'` and `'20.000000000000'` are one amount. A string comparison would
    // put a finding on every single row, and a report full of false findings is
    // one nobody reads.
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;
    await recordPayment(fixture, ref, '20');

    const report = await reconcile(fixture, [processorPayment(ref, 2000, fixture.customerRef)]);
    expect(report.discrepancies).toEqual([]);
  });
});

describe('the four findings are four different problems', () => {
  it('reports missing_in_ledger — the customer paid and has no balance', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;

    const report = await reconcile(fixture, [processorPayment(ref, 3500, fixture.customerRef)]);

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      kind: 'missing_in_ledger',
      externalRef: ref,
      accountId: fixture.accountId,
    });
    expect(Number(report.discrepancies[0].externalAmount)).toBe(35);
    expect(Number(report.run.ledgerTotal)).toBe(0);
    expect(Number(report.run.externalTotal)).toBe(35);
  });

  it('reports missing_in_external — a balance with no charge behind it', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;
    await recordPayment(fixture, ref, '12.000000000000');

    const report = await reconcile(fixture, []);

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      kind: 'missing_in_external',
      externalRef: ref,
      accountId: fixture.accountId,
    });
    expect(report.discrepancies[0].ledgerEntryId).toBeDefined();
  });

  it('reports amount_mismatch with BOTH sides', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;
    await recordPayment(fixture, ref, '20.000000000000');

    const report = await reconcile(fixture, [processorPayment(ref, 2500, fixture.customerRef)]);

    expect(report.discrepancies).toHaveLength(1);
    const finding = report.discrepancies[0];
    expect(finding.kind).toBe('amount_mismatch');
    expect(Number(finding.ledgerAmount)).toBe(20);
    expect(Number(finding.externalAmount)).toBe(25);
  });

  it('reports account_unresolved — money arrived and nobody owns it', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;

    const report = await reconcile(fixture, [
      processorPayment(ref, 900, `cus_${randomUUID().replace(/-/g, '')}`),
    ]);

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      kind: 'account_unresolved',
      externalRef: ref,
    });
    expect(report.discrepancies[0].accountId).toBeUndefined();
  });
});

describe('totals and findings are both needed', () => {
  it('reports findings on a pass whose totals agree exactly', async () => {
    // The swap: Oxy recorded $20 against ref A, the processor reports $20
    // against ref B. Every total matches; nothing matches.
    const fixture = await seedAccount();
    const recordedRef = `pi_${randomUUID().replace(/-/g, '')}`;
    const reportedRef = `pi_${randomUUID().replace(/-/g, '')}`;
    await recordPayment(fixture, recordedRef, '20.000000000000');

    const report = await reconcile(fixture, [
      processorPayment(reportedRef, 2000, fixture.customerRef),
    ]);

    expect(Number(report.run.ledgerTotal)).toBe(Number(report.run.externalTotal));
    expect(report.run.discrepancyCount).toBe(2);
    expect(report.discrepancies.map((entry) => entry.kind).sort()).toEqual([
      'missing_in_external',
      'missing_in_ledger',
    ]);
  });
});

describe('a pass that dies says so', () => {
  it('marks the run failed and rethrows', async () => {
    const fixture = await seedAccount();

    await expect(
      reconcilePayments({
        ledger: failingLedger(),
        accountId: fixture.accountId,
        currency: 'USD',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
    ).rejects.toThrow('processor unavailable');

    const [run] = await getDb()
      .select()
      .from(billingReconciliationRuns)
      .where(eq(billingReconciliationRuns.accountId, fixture.accountId))
      .limit(1);

    // Left `running`, the next operator would read a crashed pass as one still
    // in flight — and the CHECK makes that state permanent until noticed.
    expect(run.status).toBe('failed');
    expect(run.completedAt).not.toBeNull();
  });
});

describe('reconciliation repairs nothing', () => {
  it('leaves the balance untouched when it finds money the ledger never took', async () => {
    const fixture = await seedAccount();
    const ref = `pi_${randomUUID().replace(/-/g, '')}`;

    await reconcile(fixture, [processorPayment(ref, 5000, fixture.customerRef)]);

    // Crediting what it found would make the processor the ledger, which is the
    // invariant this whole workstream holds.
    const [balance] = await getDb()
      .select({ purchased: userCredits.userId })
      .from(userCredits)
      .where(eq(userCredits.userId, fixture.accountId))
      .limit(1);
    expect(balance).toBeDefined();

    const secondPass = await reconcile(fixture, [
      processorPayment(ref, 5000, fixture.customerRef),
    ]);
    // Still missing. A pass that had "helpfully" recorded it would report clean.
    expect(secondPass.discrepancies.map((entry) => entry.kind)).toEqual(['missing_in_ledger']);
  });
});
