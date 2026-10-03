/** Deterministic real-PG barriers; no public clock/lock injection or provider effects. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb, type Transaction } from '../../config/postgres';
import { users, userCredits, billingTransactions, billingCreditGrants, billingCreditSpends, billingCreditRefundObservations } from '../../db/schema';
import { grantSubscriptionCredits, spendSubscriptionTrackedCredits, recordCreditRefundSnapshot, type SubscriptionCreditGrantInput } from '../subscriptionCreditLedger.service';
jest.setTimeout(30_000);
beforeAll(connectPostgres); afterAll(closePostgres);
function signal() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function instrumentGrant(tx: Transaction, userLocked: ReturnType<typeof signal>, continueGrant: ReturnType<typeof signal>, balanceAttempted: ReturnType<typeof signal>) {
  return new Proxy(tx, { get(target, property) {
    if (property !== 'select') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
    return (...args: Parameters<Transaction['select']>) => {
      const builder = target.select(...args); const from = builder.from.bind(builder);
      builder.from = ((table: Parameters<typeof from>[0]) => {
        const query = from(table); const rowLock = query.for.bind(query);
        if (table === userCredits) query.for = ((...values: Parameters<typeof rowLock>) => { balanceAttempted.release(); return rowLock(...values); }) as typeof rowLock;
        if (table === users) query.for = ((...values: Parameters<typeof rowLock>) => {
          const result = rowLock(...values);
          return Promise.resolve(result).then(async rows => {
            userLocked.release(); await continueGrant.promise; return rows;
          });
        }) as typeof rowLock;
        return query;
      }) as typeof builder.from;
      return builder;
    };
  } });
}
async function waitBlocked(pid: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await getDb().execute<{ waiting: boolean }>(sql`SELECT wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AS waiting FROM pg_stat_activity WHERE pid = ${pid}`);
    if (rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected controlled PostgreSQL lock waiter ${pid}`);
}
function codes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const value = error as { code?: string; cause?: unknown }; return [...(value.code ? [value.code] : []), ...codes(value.cause)];
}

it.each(['spend', 'refund'] as const)('grant-first vs first %s finishes both commits without a FK row-lock cycle', async kind => runRace(kind, true));
it.each(['spend', 'refund'] as const)('%s-first vs grant finishes both commits without a FK row-lock cycle', async kind => runRace(kind, false));
async function runRace(kind: 'spend' | 'refund', grantFirst: boolean) {
  const db = getDb(); const token = randomUUID().replaceAll('-', ''); const grantApp = `i06-grant-${token}`; const otherApp = `i06-${kind}-${token}`;
  const key = Number.parseInt(token.slice(0, 7), 16); const operationId = `spend-${token}`;
  const [user] = await db.insert(users).values({ color: 'teal' }).returning();
  await db.insert(userCredits).values({ userId: user.id, creditsPaid: 2000, creditsFree: 100 });
  const input: SubscriptionCreditGrantInput = { userId: user.id, transactionId: randomUUID(), providerAccountRef: `synthetic-${token}`,
    invoiceId: `in_${token}`, subscriptionId: `sub_${token}`, sourceType: 'subscription_payment',
    periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-11-01T00:00:00Z'), currency: 'usd', amountPaid: 1000, granted: 1000,
    promotionId: null, oncePerAccountPromotionId: null };
  // A confirmed paid receipt already exists; the concurrent transactions exercise real ledger helpers.
  await db.insert(billingTransactions).values({ id: input.transactionId, userId: user.id, stripeInvoiceId: input.invoiceId,
    stripeSubscriptionId: input.subscriptionId, stripeSubscriptionPeriodStart: input.periodStart,
    type: input.sourceType, amountMinorUnits: 1000, currency: 'usd', credits: 1000, status: 'completed' });
  const refund = { userId: user.id, providerAccountRef: input.providerAccountRef, invoiceId: input.invoiceId, eventId: `evt_${token}`,
    chargeId: `ch_${token}`, currency: 'usd', amountPaid: 1000, amountRefunded: 500 };
  const table = kind === 'spend' ? 'billing_credit_spends' : 'billing_credit_invoices';
  // Trigger is scoped to this synthetic session, installed only in the newly owned test database.
  await db.execute(sql.raw(`CREATE FUNCTION i06_lock_barrier_${token}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('application_name') = '${otherApp}' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$; CREATE TRIGGER i06_lock_barrier_${token} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION i06_lock_barrier_${token}();`));
  const grantLocked = signal(); const releaseGrant = signal(); const grantBalance = signal(); const grantPidReady = signal(); const otherPidReady = signal();
  let grantPid = 0; let otherPid = 0; const pending: Promise<unknown>[] = [];
  const grantOperation = () => db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('application_name', ${grantApp}, true), set_config('statement_timeout', '10000', true)`);
    const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); grantPid = rows[0].pid; grantPidReady.release();
    return grantSubscriptionCredits(instrumentGrant(tx, grantLocked, releaseGrant, grantBalance), input);
  });
  const otherOperation = () => db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('application_name', ${otherApp}, true), set_config('statement_timeout', '10000', true)`);
    const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); otherPid = rows[0].pid; otherPidReady.release();
    return kind === 'spend' ? spendSubscriptionTrackedCredits(tx, user.id, 100, operationId) : recordCreditRefundSnapshot(tx, refund);
  });
  try {
    await db.transaction(async coordinator => {
      await coordinator.execute(sql`SELECT pg_advisory_lock(${key})`);
      try {
        if (grantFirst) {
          pending.push(grantOperation()); await grantLocked.promise;
          pending.push(otherOperation()); await otherPidReady.promise; await waitBlocked(otherPid);
          releaseGrant.release(); await grantBalance.promise;
        } else {
          pending.push(otherOperation()); await otherPidReady.promise; await waitBlocked(otherPid);
          pending.push(grantOperation()); await grantPidReady.promise;
          const state = await Promise.race([grantLocked.promise.then(() => 'held' as const), waitBlocked(grantPid).then(() => 'blocked' as const)]);
          releaseGrant.release(); if (state === 'held') await grantBalance.promise;
        }
      } finally { releaseGrant.release(); await coordinator.execute(sql`SELECT pg_advisory_unlock(${key})`); }
    });
    const outcomes = await Promise.allSettled(pending);
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? codes(outcome.reason) : []);
    expect({ statuses: outcomes.map(outcome => outcome.status), sqlStates: failures }).toEqual({ statuses: ['fulfilled','fulfilled'], sqlStates: [] });
    await db.transaction(tx => grantSubscriptionCredits(tx, input));
    if (kind === 'spend') expect(await spendSubscriptionTrackedCredits(db, user.id, 100, operationId)).toBe(true);
    else expect((await recordCreditRefundSnapshot(db, refund)).removed).toBe(0);
    const [balance] = await db.select().from(userCredits).where(eq(userCredits.userId, user.id));
    expect(balance.creditsPaid).toBe(kind === 'spend' ? 2900 : 2500); expect(balance.creditsFree).toBe(100);
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, user.id)); expect(grants).toHaveLength(1);
    expect(grants[0].granted).toBe(1000); expect(grants[0].consumed + grants[0].clawed).toBeLessThanOrEqual(1000);
    expect(await db.select().from(kind === 'spend' ? billingCreditSpends : billingCreditRefundObservations).where(eq(kind === 'spend' ? billingCreditSpends.userId : billingCreditRefundObservations.userId, user.id))).toHaveLength(1);
  } finally {
    releaseGrant.release(); await Promise.allSettled(pending);
    await db.execute(sql.raw(`DROP TRIGGER i06_lock_barrier_${token} ON ${table}; DROP FUNCTION i06_lock_barrier_${token}();`));
  }
}
