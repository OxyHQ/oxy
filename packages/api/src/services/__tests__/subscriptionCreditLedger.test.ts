/** Real PostgreSQL credit ledger; provider snapshots are synthetic, no remote effects. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userCredits } from '../../db/schema/userCredits';
import { billingTransactions } from '../../db/schema/billingTransactions';
import { billingCreditGrants, billingCreditSpends, billingCreditInvoices, billingCreditRefundObservations } from '../../db/schema/billingCreditGrants';
import { deductCredits } from '../../db/credits';
import { grantSubscriptionCredits, recordCreditRefundSnapshot, refundCreditTarget, spendSubscriptionTrackedCredits, type SubscriptionCreditGrantInput } from '../subscriptionCreditLedger.service';

beforeAll(async () => { await connectPostgres(); });
afterAll(closePostgres);
async function account(legacy = 5000, free = 0) {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning();
  await getDb().insert(userCredits).values({ userId: row.id, creditsPaid: legacy, creditsFree: free });
  return row.id;
}
async function grant(userId: string, credits = 10000, invoiceId = `in_${randomUUID()}`) {
  const input: SubscriptionCreditGrantInput = { userId, transactionId: randomUUID(), providerAccountRef: 'synthetic-processor-account',
    invoiceId, subscriptionId: `sub_${randomUUID()}`, sourceType: 'subscription_payment',
    periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-11-01T00:00:00Z'),
    currency: 'usd', amountPaid: 2999, granted: credits, promotionId: null, oncePerAccountPromotionId: null };
  await getDb().transaction(async tx => {
    await tx.insert(billingTransactions).values({ id: input.transactionId, userId, stripeInvoiceId: invoiceId,
      stripeSubscriptionId: input.subscriptionId, stripeSubscriptionPeriodStart: input.periodStart,
      type: input.sourceType, amountMinorUnits: input.amountPaid, currency: input.currency, credits, status: 'completed' });
    await grantSubscriptionCredits(tx, input);
  });
  return input;
}
function refund(input: SubscriptionCreditGrantInput, refunded = 2999, eventId = `evt_${randomUUID()}`) {
  return { userId: input.userId, providerAccountRef: input.providerAccountRef, invoiceId: input.invoiceId,
    eventId, chargeId: `ch_${input.invoiceId}`, currency: 'usd', amountPaid: 2999, amountRefunded: refunded };
}
async function paid(userId: string) { const [r] = await getDb().select().from(userCredits).where(eq(userCredits.userId, userId)); return r.creditsPaid; }
async function ledger(userId: string) { return getDb().select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, userId)).orderBy(billingCreditGrants.createdAt, billingCreditGrants.id); }

it('uses exact common rounding and rejects unsafe/nonwhole evidence', () => {
  expect(refundCreditTarget(10000, 1000, 2999)).toBe(3334);
  expect(refundCreditTarget(Number.MAX_SAFE_INTEGER, 1, 3)).toBe(3002399751580330);
  expect(() => refundCreditTarget(10, 11, 10)).toThrow();
  expect(() => refundCreditTarget(10.5, 1, 3)).toThrow();
});
it('consumes FIFO new grants through the existing deduction helper, then legacy and free', async () => {
  const user = await account(5000, 100); await grant(user, 1000); await grant(user, 2000);
  expect(await deductCredits(getDb(), user, 1500)).toBe(true);
  expect((await ledger(user)).map(g => g.consumed)).toEqual([1000, 500]);
  expect(await spendSubscriptionTrackedCredits(getDb(), user, 6600, 'finish')).toBe(true);
  expect(await paid(user)).toBe(0);
  const [b] = await getDb().select().from(userCredits).where(eq(userCredits.userId, user));expect(b.creditsFree).toBe(0);
  const [s] = await getDb().select().from(billingCreditSpends).where(eq(billingCreditSpends.operationId, 'finish'));
  expect(s).toMatchObject({ trackedPaid: 1500, legacyPaid: 5000, free: 100 });
});
it('full refund removes only the unconsumed grant, keeping bought/opaque credits', async () => {
  const user = await account(); const g = await grant(user);
  expect(await deductCredits(getDb(), user, 800)).toBe(true);
  expect(await recordCreditRefundSnapshot(getDb(), refund(g))).toMatchObject({ removed: 9200 });
  expect(await paid(user)).toBe(5000); expect((await ledger(user))[0]).toMatchObject({ consumed: 800, clawed: 9200 });
});
it('partial cumulative refunds converge without summing deliveries, even reversed', async () => {
  const user = await account(); const g = await grant(user);
  const partial = refund(g, 1000);
  expect((await recordCreditRefundSnapshot(getDb(), partial)).removed).toBe(3334);
  expect((await recordCreditRefundSnapshot(getDb(), partial)).removed).toBe(0);
  expect((await recordCreditRefundSnapshot(getDb(), refund(g))).removed).toBe(6666);
  expect((await recordCreditRefundSnapshot(getDb(), refund(g, 1000))).removed).toBe(0);
  expect(await paid(user)).toBe(5000);
});
it('refund before grant records the full logical grant and same floored clawback', async () => {
  const user = await account(); const invoice = `in_${randomUUID()}`;
  const snapshot = { userId: user, providerAccountRef: 'synthetic-processor-account', invoiceId: invoice,
    eventId: randomUUID(), chargeId: `ch_${invoice}`, currency: 'usd', amountPaid: 2999, amountRefunded: 1000 };
  expect((await recordCreditRefundSnapshot(getDb(), snapshot)).matchedGrants).toBe(0);
  await grant(user, 10000, invoice);
  expect(await paid(user)).toBe(11666);expect((await ledger(user))[0]).toMatchObject({ granted: 10000, consumed: 0, clawed: 3334 });
});
it('refund replay cannot debit a different period or an exhausted grant', async () => {
  const user = await account(); const first = await grant(user, 1000); await grant(user, 2000);
  await deductCredits(getDb(), user, 1000);
  expect((await recordCreditRefundSnapshot(getDb(), refund(first))).removed).toBe(0);expect(await paid(user)).toBe(7000);
});
it('same spend intent is idempotent and incompatible amount rejects', async () => {
  const user = await account(); await grant(user);
  expect(await spendSubscriptionTrackedCredits(getDb(), user, 600, 'same')).toBe(true);
  expect(await spendSubscriptionTrackedCredits(getDb(), user, 600, 'same')).toBe(true);
  await expect(spendSubscriptionTrackedCredits(getDb(), user, 601, 'same')).rejects.toThrow('different amount');
  expect(await paid(user)).toBe(14400);
});
it('insufficient/negative/fractional deduction changes neither counters nor balance', async () => {
  const user = await account(0); await grant(user, 10);
  for (const amount of [11, -1, 0.5]) expect(await deductCredits(getDb(), user, amount)).toBe(false);
  expect(await paid(user)).toBe(10);expect((await ledger(user))[0].consumed).toBe(0);
});
it('concurrent spend/refund preserves conservation and legacy across real row locks', async () => {
  const user = await account(); const g = await grant(user, 1000);
  await Promise.all([spendSubscriptionTrackedCredits(getDb(), user, 800, 'racing'), recordCreditRefundSnapshot(getDb(), refund(g))]);
  const [row] = await ledger(user);
  expect(row.consumed + row.clawed).toBe(1000);
  expect(await paid(user)).toBe(row.consumed === 800 ? 5000 : 4200);
});
it('concurrent identical spend intents debit once', async () => {
  const user = await account(); await grant(user);
  const result = await Promise.all(Array.from({ length: 6 }, () => spendSubscriptionTrackedCredits(getDb(), user, 500, 'racing-id')));
  expect(result).toEqual(Array(6).fill(true));expect(await paid(user)).toBe(14500);
});
it('reused refund event cannot change invoice or beneficiary', async () => {
  const user = await account(); const g = await grant(user); const r = refund(g, 1000);
  await recordCreditRefundSnapshot(getDb(), r);
  await expect(recordCreditRefundSnapshot(getDb(), { ...r, invoiceId: `in_${randomUUID()}` })).rejects.toThrow('differs');
  expect(await paid(user)).toBe(11666);
});
it('wrong payment amount/currency/charge identity refuses and preserves balances', async () => {
  const user = await account(); const g = await grant(user); const r = refund(g, 1000);
  await recordCreditRefundSnapshot(getDb(), r);
  for (const change of [{ currency: 'eur' }, { amountPaid: 3000 }, { chargeId: 'ch_other' }]) {
    await expect(recordCreditRefundSnapshot(getDb(), { ...refund(g, 1000), ...change })).rejects.toThrow('identity differs');
  }
  expect(await paid(user)).toBe(11666);
});
it('nested transaction rollback restores receipt, grant and aggregate', async () => {
  const user = await account(); const g = await grant(user);
  await expect(getDb().transaction(async tx => { await spendSubscriptionTrackedCredits(tx, user, 800, 'rollback'); throw new Error('forced crash'); })).rejects.toThrow('forced crash');
  expect(await paid(user)).toBe(15000);expect((await ledger(user))[0].consumed).toBe(0);
  const spends = await getDb().select().from(billingCreditSpends).where(eq(billingCreditSpends.userId, user));expect(spends).toEqual([]);
  const noOp = await getDb().transaction(tx => grantSubscriptionCredits(tx, g));expect(noOp.status).toBe('replayed');
});
it('ledger provenance cannot be altered/deleted even through SQL', async () => {
  const user = await account(); const g = await grant(user); await spendSubscriptionTrackedCredits(getDb(), user, 800, 'immutable');
  const [row] = await ledger(user);
  await expect(getDb().execute(sql`update billing_credit_grants set invoice_id = 'forged' where id = ${row.id}`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  await expect(getDb().execute(sql`delete from billing_credit_consumptions where grant_id = ${row.id}`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  await expect(getDb().execute(sql`update billing_credit_grants set consumed = 0 where id = ${row.id}`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  expect((await ledger(user))[0].consumed).toBe(800);expect(g.invoiceId).toBe(row.invoiceId);
});
it("out-of-band aggregate drift fails closed rather than debiting somebody else’s credits", async () => {
  const user = await account(0); const g = await grant(user);
  await getDb().update(userCredits).set({ creditsPaid: 1 }).where(eq(userCredits.userId, user));
  await expect(recordCreditRefundSnapshot(getDb(), refund(g))).rejects.toThrow('diverged');
  await expect(deductCredits(getDb(), user, 1)).rejects.toThrow('diverged');
  expect((await ledger(user))[0].clawed).toBe(0);
});

it('near-limit grant rejects and rolls back its receipt/identity before overflowing JS counts', async () => {
  const user = await account(Number.MAX_SAFE_INTEGER - 5);
  await expect(grant(user, 10)).rejects.toThrow('exceeds supported count');
  expect(await paid(user)).toBe(Number.MAX_SAFE_INTEGER - 5);
  expect(await ledger(user)).toEqual([]);
  expect(await getDb().select().from(billingTransactions).where(eq(billingTransactions.userId, user))).toEqual([]);
  expect(await getDb().select().from(billingCreditInvoices).where(eq(billingCreditInvoices.userId, user))).toEqual([]);
});
it('concurrent pre-grant refunds cannot bind one financial invoice to two users', async () => {
  const first = await account(); const second = await account(); const invoiceId = `in_${randomUUID()}`;
  const input = { providerAccountRef: 'synthetic-processor-account', invoiceId,
    chargeId: `ch_${invoiceId}`, currency: 'usd', amountPaid: 2999, amountRefunded: 1000 };
  const result = await Promise.allSettled([recordCreditRefundSnapshot(getDb(), { ...input, userId: first, eventId: randomUUID() }),
    recordCreditRefundSnapshot(getDb(), { ...input, userId: second, eventId: randomUUID() })]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  const [bound] = await getDb().select().from(billingCreditInvoices).where(eq(billingCreditInvoices.invoiceId, invoiceId));
  const observations = await getDb().select().from(billingCreditRefundObservations).where(eq(billingCreditRefundObservations.invoiceId, invoiceId));
  expect(observations).toHaveLength(1); expect(observations[0].userId).toBe(bound.userId);
  expect(await paid(first)).toBe(5000);expect(await paid(second)).toBe(5000);
  const other = bound.userId === first ? second : first;
  await expect(grant(other, 10000, invoiceId)).rejects.toThrow('differs');
  expect(await ledger(other)).toEqual([]);
  await grant(bound.userId, 10000, invoiceId); expect(await paid(bound.userId)).toBe(11666);
});
