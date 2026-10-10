/** Approved P1 integer policy; provider evidence validation happens separately. */
import { z } from 'zod';
import { ConflictError } from '../utils/error';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const second = count.positive();
const paidInvoice = z
  .object({
    invoiceId: z.string().min(1).max(160),
    paidAt: second,
    kind: z.enum(['base', 'change']),
    oldCredits: count,
    newCredits: count,
    remainingStart: second,
    remainingEnd: second,
  })
  .strict();
const inputSchema = z
  .object({
    periodStart: second,
    periodEnd: second,
    invoices: z.array(paidInvoice).min(1).max(10_000),
  })
  .strict();
export type PaidPeriodEvidence = z.infer<typeof inputSchema>;
export type PeriodCreditAssignment = {
  invoiceId: string;
  credits: number;
  kind: 'base' | 'change';
  capApplied: boolean;
};

/**
 * Canonical assignment from the same complete, verified period evidence. Reserve
 * the base even when its delivery arrives last. No mutable delivery-order sum.
 * Paginated provider reads are not an atomic remote snapshot: adapters must reject
 * ambiguous/incomplete evidence and any change to already frozen assignments.
 */
export function assignPaidPeriodCredits(raw: PaidPeriodEvidence): PeriodCreditAssignment[] {
  const input = inputSchema.parse(raw);
  const duration = input.periodEnd - input.periodStart;
  if (duration <= 0) throw new ConflictError('Invalid subscription credit period');
  const bases = input.invoices.filter((invoice) => invoice.kind === 'base');
  if (bases.length !== 1) throw new ConflictError('Exactly one paid base invoice is required');
  const base = bases[0];
  if (
    base.remainingStart !== input.periodStart ||
    base.remainingEnd !== input.periodEnd ||
    base.oldCredits !== base.newCredits
  )
    throw new ConflictError('Base invoice period or plan differs');
  const ids = new Set<string>();
  let cap = base.newCredits;
  for (const invoice of input.invoices) {
    if (ids.has(invoice.invoiceId)) throw new ConflictError('Duplicate invoice evidence');
    ids.add(invoice.invoiceId);
    if (
      invoice.remainingStart < input.periodStart ||
      invoice.remainingEnd !== input.periodEnd ||
      invoice.remainingStart >= invoice.remainingEnd
    )
      throw new ConflictError('Proration period differs from subscription period');
    cap = Math.max(cap, invoice.oldCredits, invoice.newCredits);
  }
  const ordered = input.invoices
    .filter((invoice) => invoice.kind === 'change')
    .sort(
      (a, b) =>
        a.paidAt - b.paidAt || (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0),
    );
  let available = cap - base.newCredits;
  const assigned: PeriodCreditAssignment[] = [
    { invoiceId: base.invoiceId, credits: base.newCredits, kind: 'base', capApplied: false },
  ];
  for (const invoice of ordered) {
    const delta = Math.max(0, invoice.newCredits - invoice.oldCredits);
    const intended = Number(
      (BigInt(delta) * BigInt(invoice.remainingEnd - invoice.remainingStart)) / BigInt(duration),
    );
    const credits = Math.min(intended, available);
    available -= credits;
    assigned.push({
      invoiceId: invoice.invoiceId,
      credits,
      kind: 'change',
      capApplied: credits !== intended,
    });
  }
  return assigned;
}

/** Validate all frozen attribution before the first receipt/grant write. */
export function assertFrozenPeriodAssignments(
  assignments: PeriodCreditAssignment[],
  frozen: { invoiceId: string; credits: number }[],
): void {
  const planned = new Map(
    assignments.map((assignment) => [assignment.invoiceId, assignment.credits]),
  );
  for (const invoice of frozen)
    if (planned.get(invoice.invoiceId) !== invoice.credits) {
      throw new ConflictError(
        'Period evidence is incomplete or changes a frozen invoice credit assignment',
      );
    }
}
