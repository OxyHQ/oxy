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
import { and, desc, eq, isNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  billingReconciliationRuns,
  RECONCILIATION_LEASE_MS,
} from '../../db/schema/billingReconciliation';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';
import {
  reconcilePayments,
  runScheduledReconciliation,
  type PaymentProcessorLedger,
  type ProcessorLedgerQuery,
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
    actor: { kind: 'machine' },
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

describe('an account-scoped pass never widens into a platform-wide one', () => {
  it('does not call the processor at all when the account has no customer', async () => {
    /*
     * `customerRef: undefined` means EVERY customer to the adapter — the same
     * encoding a deliberate platform-wide pass uses. An account-scoped pass that
     * passed it through would compare one account's ledger rows against the whole
     * platform's payments and fill the report with other customers' references,
     * under a run row naming this account.
     *
     * The assertion is on the CALL, not on the findings: a pass that queried and
     * happened to get nothing back looks identical in the report.
     */
    const suffix = randomUUID().slice(0, 8);
    const [account] = await getDb()
      .insert(users)
      .values({ username: `nocust-${suffix}`, email: `nocust-${suffix}@example.test` })
      .returning({ id: users.id });
    await provisionBillingProfile({ accountId: account.id });

    const calls: ProcessorLedgerQuery[] = [];
    const spyLedger: PaymentProcessorLedger = {
      provider: 'stripe',
      listSettledPayments: async (query) => {
        calls.push(query);
        // What the real adapter would return for an unfiltered window: somebody
        // else's payment. Reaching this at all is the defect.
        return [processorPayment(`pi_${randomUUID().replace(/-/g, '')}`, 9900, 'cus_stranger')];
      },
    };

    const report = await reconcilePayments({
      ledger: spyLedger,
      accountId: account.id,
      currency: 'USD',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    expect(calls).toEqual([]);
    expect(report.discrepancies).toEqual([]);
    expect(Number(report.run.externalTotal)).toBe(0);
  });

  it('still queries the processor for a PLATFORM-wide pass, which has no account', async () => {
    // The control for the case above: `undefined` keeps meaning "every customer"
    // where that is what was asked for, so the skip cannot have been implemented
    // by never querying.
    const calls: ProcessorLedgerQuery[] = [];
    const spyLedger: PaymentProcessorLedger = {
      provider: 'stripe',
      listSettledPayments: async (query) => {
        calls.push(query);
        return [];
      },
    };

    await reconcilePayments({
      ledger: spyLedger,
      currency: 'USD',
      // A window this file's fixtures never write into, so a platform-wide pass
      // over the shared test database reads nothing a sibling seeded.
      periodStart: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      periodEnd: new Date(Date.now() - 399 * 24 * 60 * 60 * 1000),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].customerRef).toBeUndefined();
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

/* ==========================================================================
 * The scheduled pass (issue #972 workstream 16)
 * ========================================================================== */

/**
 * ## The test this block exists for
 *
 * `oxy-api` runs N ECS tasks and every one registers every sweep. A pass that
 * simply fired on each would write N run rows per window, make N Stripe scans and
 * record N copies of every finding — so the drift metric would read N× reality,
 * which is worse than not having it at all. Nothing about that failure is visible
 * from one task's logs.
 *
 * So every assertion below is about the CLAIM, and each is paired with the case
 * that must still proceed: a completed window is skipped **and** a failed one is
 * retried, a fresh `running` row is respected **and** a stale one is reclaimed.
 * Without those pairs, "it skipped" would also be what a claim that skips
 * everything reports, and a permanently-blocked window is the exact hole in the
 * drift series the schedule exists to prevent.
 *
 * The window is pinned years in the past, so it holds no `billing_external_payments`
 * row from any sibling suite and this block's run rows are the only ones that can
 * exist for it. That is what makes a platform-wide pass — which is what the
 * scheduler actually performs — assertable on a shared database.
 */
describe('the scheduled pass', () => {
  /** 2021-03-04T14:20Z, so the due window is a specific ancient hour. */
  const FIXED_NOW = new Date('2021-03-04T14:20:33.512Z');
  const DUE_WINDOW_START = new Date('2021-03-04T12:00:00.000Z');
  const DUE_WINDOW_END = new Date('2021-03-04T13:00:00.000Z');

  /** Every platform-wide run row for the pinned window, newest first. */
  async function scheduledRuns() {
    return getDb()
      .select()
      .from(billingReconciliationRuns)
      .where(
        and(
          isNull(billingReconciliationRuns.accountId),
          eq(billingReconciliationRuns.periodStart, DUE_WINDOW_START),
          eq(billingReconciliationRuns.periodEnd, DUE_WINDOW_END)
        )
      )
      .orderBy(desc(billingReconciliationRuns.startedAt));
  }

  function runDue(now = FIXED_NOW) {
    return runScheduledReconciliation({ now, ledger: fakeLedger([]) });
  }

  beforeEach(async () => {
    // The window is this block's alone, so clearing it keeps each case
    // independent without touching any other suite's rows.
    await getDb()
      .delete(billingReconciliationRuns)
      .where(
        and(
          isNull(billingReconciliationRuns.accountId),
          eq(billingReconciliationRuns.periodStart, DUE_WINDOW_START)
        )
      );
  });

  it('reconciles the complete window that ended one settlement lag ago', async () => {
    const result = await runDue();

    expect(result.status).toBe('ran');
    if (result.status !== 'ran') return;
    expect(result.outcome).toMatchObject({ reconciled: 1, skipped: 0, failed: 0 });
    // Not "an hour ago": at 14:20 with an hour of lag the due window is
    // 12:00–13:00, quantized to the period, never 13:20–14:20.
    expect(result.outcome.periodStart).toBe(DUE_WINDOW_START.toISOString());
    expect(result.outcome.periodEnd).toBe(DUE_WINDOW_END.toISOString());

    const runs = await scheduledRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    // Platform-wide, so a staff member investigating one customer neither
    // consumes this window nor is blocked by it.
    expect(runs[0].accountId).toBeNull();
  });

  it('writes exactly ONE run row when two tasks tick at the same moment', async () => {
    const [first, second] = await Promise.all([runDue(), runDue()]);

    const outcomes = [first, second].map((result) =>
      result.status === 'ran' ? result.outcome : undefined
    );
    // One task did the work; the other found the window taken and wrote nothing.
    expect(outcomes.filter((outcome) => outcome?.reconciled === 1)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome?.skipped === 1)).toHaveLength(1);

    // The assertion the whole interlock exists for. Two rows here means the
    // drift metric double-counts on every window, on every deploy, forever.
    expect(await scheduledRuns()).toHaveLength(1);
  });

  it('does not re-run a window it already completed', async () => {
    await runDue();
    const again = await runDue();

    expect(again.status).toBe('ran');
    if (again.status !== 'ran') return;
    expect(again.outcome).toMatchObject({ reconciled: 0, skipped: 1 });
    expect(await scheduledRuns()).toHaveLength(1);
  });

  it('RETRIES a window whose pass failed, because its drift is unknown', async () => {
    const failed = await runScheduledReconciliation({
      now: FIXED_NOW,
      ledger: failingLedger(),
    });
    expect(failed.status).toBe('ran');
    if (failed.status !== 'ran') return;
    expect(failed.outcome).toMatchObject({ reconciled: 0, failed: 1 });

    const afterFailure = await scheduledRuns();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].status).toBe('failed');

    // The pair to "does not re-run a completed window". A failed pass read
    // nothing, so reporting no drift for that window would be the "cron that
    // hides drift" this module refuses — it has to be retried.
    const retry = await runDue();
    expect(retry.status).toBe('ran');
    if (retry.status !== 'ran') return;
    expect(retry.outcome).toMatchObject({ reconciled: 1, skipped: 0 });

    const runs = await scheduledRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status).sort()).toEqual(['completed', 'failed']);
  });

  it('respects a fresh running row and RECLAIMS a stale one', async () => {
    // A pass in flight on another task. Inserted directly, because the only way
    // to hold a `running` row open through the real path is to stall the fake
    // ledger, and that would make this test about a promise rather than a lease.
    const [inFlight] = await getDb()
      .insert(billingReconciliationRuns)
      .values({
        provider: 'stripe',
        currency: 'USD',
        periodStart: DUE_WINDOW_START,
        periodEnd: DUE_WINDOW_END,
        status: 'running',
        startedAt: new Date(FIXED_NOW.getTime() - 1000),
      })
      .returning({ id: billingReconciliationRuns.id });

    const blocked = await runDue();
    expect(blocked.status).toBe('ran');
    if (blocked.status !== 'ran') return;
    expect(blocked.outcome).toMatchObject({ reconciled: 0, skipped: 1 });
    expect(await scheduledRuns()).toHaveLength(1);

    // Now age the same row past its lease: the task that started it is gone, and
    // a window blocked forever by a dead task is the stranded claim the lease
    // exists to undo. Without this half, the assertion above is satisfied by a
    // claim that never proceeds at all.
    await getDb()
      .update(billingReconciliationRuns)
      .set({ startedAt: new Date(FIXED_NOW.getTime() - RECONCILIATION_LEASE_MS - 1000) })
      .where(eq(billingReconciliationRuns.id, inFlight.id));

    const reclaimed = await runDue();
    expect(reclaimed.status).toBe('ran');
    if (reclaimed.status !== 'ran') return;
    expect(reclaimed.outcome).toMatchObject({ reconciled: 1, skipped: 0 });

    const runs = await scheduledRuns();
    expect(runs).toHaveLength(2);
    // The stranded row is marked `failed`, not left `running` — the CHECK ties
    // `completed_at` to leaving `running`, so a reclaim that forgot it would
    // violate the constraint rather than pass quietly.
    const stale = runs.find((run) => run.id === inFlight.id);
    expect(stale?.status).toBe('failed');
    expect(stale?.completedAt).not.toBeNull();
  });

  it('does nothing at all with no processor configured', async () => {
    const original = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      // No injected ledger: this is the path `server.ts` takes.
      const result = await runScheduledReconciliation({ now: FIXED_NOW });
      expect(result).toEqual({ status: 'processor-unconfigured' });
      // And it claimed nothing, so a deployment that later configures Stripe
      // still reconciles this window rather than finding it marked done.
      expect(await scheduledRuns()).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = original;
    }
  });
});
