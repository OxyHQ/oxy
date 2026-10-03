/** Subscription-credit accounting, separate from monetary account_balances. */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseOrTransaction, Transaction } from '../config/postgres';
import { billingCreditInvoices, billingCreditGrants, billingCreditSpends, billingCreditConsumptions, billingCreditRefundObservations, SUBSCRIPTION_CREDIT_SOURCES } from '../db/schema/billingCreditGrants';
import { billingTransactions } from '../db/schema/billingTransactions';
import { userCredits } from '../db/schema/userCredits';
import { ConflictError } from '../utils/error';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(160);
const grantSchema = z.object({ userId: id, transactionId: id, providerAccountRef: id,
  invoiceId: id, subscriptionId: id, sourceType: z.enum(SUBSCRIPTION_CREDIT_SOURCES),
  periodStart: z.date(), periodEnd: z.date(), currency: z.string().regex(/^[a-z]{3}$/),
  amountPaid: count, granted: count, promotionId: id.nullable().default(null),
  oncePerAccountPromotionId: id.nullable().default(null),
}).strict().refine(v => Number.isFinite(v.periodStart.getTime()) && v.periodEnd > v.periodStart, 'Invalid credit period')
  .refine(v => v.sourceType === 'subscription_promotional_grant' ? v.amountPaid === 0 && v.promotionId !== null : v.amountPaid > 0 && v.promotionId === null && v.oncePerAccountPromotionId === null, 'Invalid promotion/payment evidence');
const refundSchema = z.object({ userId: id, providerAccountRef: id, invoiceId: id,
  eventId: id, chargeId: id, currency: z.string().regex(/^[a-z]{3}$/),
  amountPaid: count.positive(), amountRefunded: count,
}).strict().refine(v => v.amountRefunded <= v.amountPaid, 'Refund exceeds paid invoice');
export type SubscriptionCreditGrantInput = z.input<typeof grantSchema>;
export type CreditRefundSnapshotInput = z.input<typeof refundSchema>;

export function refundCreditTarget(granted: number, amountRefunded: number, amountPaid: number): number {
  count.parse(granted); count.parse(amountRefunded); count.positive().parse(amountPaid);
  if (amountRefunded > amountPaid) throw new ConflictError('Refund exceeds invoice payment');
  return Number(BigInt(granted) * BigInt(amountRefunded) / BigInt(amountPaid));
}
function digest(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function identical(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ConflictError('Immutable credit evidence differs');
}
async function balanceForUpdate(tx: Transaction, userId: string) {
  const [balance] = await tx.select().from(userCredits).where(eq(userCredits.userId, userId)).for('update');
  if (!balance) throw new ConflictError('Credit account is unavailable');
  count.parse(balance.creditsPaid); count.parse(balance.creditsFree);
  return balance;
}
/** Account balance -> global invoice identity -> grants; common across all paths. */
async function bindInvoice(tx: Transaction, input: { providerAccountRef: string; invoiceId: string; userId: string; currency: string; amountPaid: number }) {
  const attribution = { providerAccountRef: input.providerAccountRef, invoiceId: input.invoiceId,
    userId: input.userId, currency: input.currency, amountPaid: input.amountPaid };
  await tx.insert(billingCreditInvoices).values(attribution).onConflictDoNothing();
  const [row] = await tx.select().from(billingCreditInvoices).where(and(
    eq(billingCreditInvoices.providerAccountRef, input.providerAccountRef), eq(billingCreditInvoices.invoiceId, input.invoiceId))).for('update');
  if (!row) throw new ConflictError('Invoice credit identity is unavailable');
  identical({ providerAccountRef: row.providerAccountRef, invoiceId: row.invoiceId,
    userId: row.userId, currency: row.currency, amountPaid: row.amountPaid }, attribution);
}
async function trackedGrants(tx: Transaction, userId: string) {
  return tx.select().from(billingCreditGrants).where(eq(billingCreditGrants.userId, userId))
    .orderBy(asc(billingCreditGrants.createdAt), asc(billingCreditGrants.id)).for('update');
}
function remainder(grant: typeof billingCreditGrants.$inferSelect): number { return grant.granted - grant.consumed - grant.clawed; }
function trackedTotal(grants: (typeof billingCreditGrants.$inferSelect)[]): number {
  const total = grants.reduce((sum, grant) => sum + BigInt(remainder(grant)), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictError('Tracked credit total exceeds supported count');
  return Number(total);
}
async function refundTarget(tx: Transaction, input: { userId: string; providerAccountRef: string; invoiceId: string; currency: string; amountPaid: number; granted: number }) {
  const rows = await tx.select().from(billingCreditRefundObservations).where(and(
    eq(billingCreditRefundObservations.providerAccountRef, input.providerAccountRef),
    eq(billingCreditRefundObservations.invoiceId, input.invoiceId)));
  let refunded = 0;
  for (const row of rows) {
    if (row.userId !== input.userId || row.currency !== input.currency || row.amountPaid !== input.amountPaid) throw new ConflictError('Refund invoice attribution differs');
    refunded = Math.max(refunded, row.amountRefunded);
  }
  return input.amountPaid === 0 ? 0 : refundCreditTarget(input.granted, refunded, input.amountPaid);
}

/** Receipt and full logical grant must share the caller's transaction. */
export async function grantSubscriptionCredits(tx: Transaction, raw: SubscriptionCreditGrantInput) {
  const input = grantSchema.parse(raw);
  const [receipt] = await tx.select().from(billingTransactions).where(eq(billingTransactions.id, input.transactionId));
  if (!receipt || receipt.userId !== input.userId || receipt.stripeInvoiceId !== input.invoiceId
    || receipt.stripeSubscriptionId !== input.subscriptionId || receipt.type !== input.sourceType
    || receipt.amountMinorUnits !== input.amountPaid || receipt.currency !== input.currency || receipt.credits !== input.granted || receipt.status !== 'completed') {
    throw new ConflictError('Credit grant differs from its paid receipt');
  }
  const [account] = await tx.select({ status: users.accountStatus }).from(users).where(eq(users.id, input.userId)).for('update');
  const [fence] = await tx.select().from(accountClosureFences).where(eq(accountClosureFences.accountId, input.userId));
  if (!account || account.status !== 'active' || fence) throw new ConflictError('Account closure prevents new credit grants');
  const balance = await balanceForUpdate(tx, input.userId);
  await bindInvoice(tx, input);
  const existingGrants = await trackedGrants(tx, input.userId);
  if (trackedTotal(existingGrants) > balance.creditsPaid) throw new ConflictError('Aggregate paid credits diverged from grant ledger');
  const grantId = `credit_grant_${digest([input.providerAccountRef, input.invoiceId, input.sourceType])}`;
  const existing = existingGrants.find(g => g.id === grantId);
  const projection = (g: typeof input) => ({ userId: g.userId, transactionId: g.transactionId,
    providerAccountRef: g.providerAccountRef, invoiceId: g.invoiceId, subscriptionId: g.subscriptionId,
    sourceType: g.sourceType, periodStart: g.periodStart, periodEnd: g.periodEnd,
    currency: g.currency, amountPaid: g.amountPaid, granted: g.granted,
    promotionId: g.promotionId, oncePerAccountPromotionId: g.oncePerAccountPromotionId });
  if (existing) { identical(projection(existing), projection(input)); return { status: 'replayed' as const, id: grantId, issued: 0 }; }
  const clawed = await refundTarget(tx, input);
  const issued = input.granted - clawed;
  if (BigInt(balance.creditsPaid) + BigInt(issued) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictError('Credit balance exceeds supported count');
  await tx.insert(billingCreditGrants).values({ ...input, id: grantId, consumed: 0, clawed });
  await tx.update(userCredits).set({ creditsPaid: sql`${userCredits.creditsPaid} + ${issued}` }).where(eq(userCredits.userId, input.userId));
  return { status: 'recorded' as const, id: grantId, issued };
}

/** Paid remains first: FIFO new grants, then opaque legacy/purchased, then free. */
export async function spendSubscriptionTrackedCredits(db: DatabaseOrTransaction, userId: string, amount: number, operationId = randomUUID()): Promise<boolean> {
  if (!Number.isSafeInteger(amount) || amount < 0) return false;
  id.parse(userId); id.parse(operationId);
  return db.transaction(async tx => {
    const [balance] = await tx.select().from(userCredits).where(eq(userCredits.userId, userId)).for('update');
    if (!balance) return false;
    count.parse(balance.creditsPaid); count.parse(balance.creditsFree);
    const [prior] = await tx.select().from(billingCreditSpends).where(and(eq(billingCreditSpends.userId, userId), eq(billingCreditSpends.operationId, operationId)));
    if (prior) { if (prior.amount !== amount) throw new ConflictError('Credit spend intent was reused with a different amount'); return true; }
    if (BigInt(balance.creditsPaid) + BigInt(balance.creditsFree) < BigInt(amount)) return false;
    const grants = await trackedGrants(tx, userId);
    const total = trackedTotal(grants);
    if (total > balance.creditsPaid) throw new ConflictError('Aggregate paid credits diverged from grant ledger');
    const paid = Math.min(amount, balance.creditsPaid);
    const trackedPaid = Math.min(paid, total);
    const spendId = `credit_spend_${digest([userId, operationId])}`;
    await tx.insert(billingCreditSpends).values({ id: spendId, userId, operationId, amount,
      trackedPaid, legacyPaid: paid - trackedPaid, free: amount - paid });
    let remaining = trackedPaid;
    for (const grant of grants) {
      const consumed = Math.min(remainder(grant), remaining);
      if (!consumed) continue;
      await tx.insert(billingCreditConsumptions).values({ spendId, grantId: grant.id, userId, amount: consumed });
      await tx.update(billingCreditGrants).set({ consumed: grant.consumed + consumed }).where(eq(billingCreditGrants.id, grant.id));
      remaining -= consumed;
    }
    await tx.update(userCredits).set({ creditsPaid: balance.creditsPaid - paid, creditsFree: balance.creditsFree - (amount - paid) }).where(eq(userCredits.userId, userId));
    return true;
  });
}

/** Provider cumulative snapshots only; never sums deliveries or calls a refund API. */
export async function recordCreditRefundSnapshot(db: DatabaseOrTransaction, raw: CreditRefundSnapshotInput) {
  const input = refundSchema.parse(raw);
  return db.transaction(async tx => {
    const balance = await balanceForUpdate(tx, input.userId);
    await bindInvoice(tx, input);
    const grants = await trackedGrants(tx, input.userId);
    if (trackedTotal(grants) > balance.creditsPaid) throw new ConflictError('Aggregate paid credits diverged from grant ledger');
    const invoiceSnapshots = await tx.select().from(billingCreditRefundObservations).where(and(eq(billingCreditRefundObservations.providerAccountRef, input.providerAccountRef), eq(billingCreditRefundObservations.invoiceId, input.invoiceId)));
    if (invoiceSnapshots.some(row => row.userId !== input.userId || row.currency !== input.currency || row.chargeId !== input.chargeId || row.amountPaid !== input.amountPaid)) throw new ConflictError('Refund invoice payment identity differs');
    const [prior] = await tx.select().from(billingCreditRefundObservations).where(and(
      eq(billingCreditRefundObservations.providerAccountRef, input.providerAccountRef), eq(billingCreditRefundObservations.eventId, input.eventId)));
    if (prior) identical({ userId: prior.userId, providerAccountRef: prior.providerAccountRef, invoiceId: prior.invoiceId,
      eventId: prior.eventId, chargeId: prior.chargeId, currency: prior.currency, amountPaid: prior.amountPaid, amountRefunded: prior.amountRefunded }, input);
    else await tx.insert(billingCreditRefundObservations).values(input);
    let removed = 0;
    for (const grant of grants.filter(g => g.providerAccountRef === input.providerAccountRef && g.invoiceId === input.invoiceId)) {
      const target = await refundTarget(tx, grant);
      const clawback = Math.max(0, Math.min(remainder(grant), target - grant.clawed));
      if (!clawback) continue;
      await tx.update(billingCreditGrants).set({ clawed: grant.clawed + clawback }).where(eq(billingCreditGrants.id, grant.id));
      removed += clawback;
    }
    if (removed) await tx.update(userCredits).set({ creditsPaid: balance.creditsPaid - removed }).where(eq(userCredits.userId, input.userId));
    return { status: prior ? 'replayed' as const : 'recorded' as const, removed, matchedGrants: grants.filter(g => g.providerAccountRef === input.providerAccountRef && g.invoiceId === input.invoiceId).length };
  });
}
