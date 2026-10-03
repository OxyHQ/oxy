import { assignPaidPeriodCredits, assertFrozenPeriodAssignments, type PaidPeriodEvidence } from '../subscriptionPeriodPolicy';

const start = 1_800_000_000; const end = start + 30 * 86_400;
const base = { invoiceId: 'in_base', paidAt: start, kind: 'base' as const, oldCredits: 10_000, newCredits: 10_000, remainingStart: start, remainingEnd: end };
const upgrade = (id: string, day: number) => ({ invoiceId: id, paidAt: start + day * 86_400, kind: 'change' as const,
  oldCredits: 10_000, newCredits: 50_000, remainingStart: start + day * 86_400, remainingEnd: end });
function evidence(invoices: PaidPeriodEvidence['invoices']): PaidPeriodEvidence { return { periodStart: start, periodEnd: end, invoices }; }

it('all delivery inversions from a stable full set reserve the late base and freeze identical per-invoice values', () => {
  const a = upgrade('in_a', 10); const b = upgrade('in_b', 25);
  const expected = assignPaidPeriodCredits(evidence([base, a, b]));
  for (const invoices of [[a, b, base], [b, base, a], [base, b, a], [a, base, b]]) {
    expect(assignPaidPeriodCredits(evidence(invoices))).toEqual(expected);
  }
  expect(expected.map(v => v.credits)).toEqual([10_000, 26_666, 6_666]);
});
it('caps canonical upgrades while a downgrade grants and claws back nothing', () => {
  const a = upgrade('in_a', 1); const b = upgrade('in_b', 2);
  const downgrade = { ...upgrade('in_down', 15), oldCredits: 50_000, newCredits: 10_000 };
  const assigned = assignPaidPeriodCredits(evidence([b, downgrade, base, a]));
  expect(assigned.map(v => v.credits)).toEqual([10_000, 38_666, 1_334, 0]);
  expect(assigned[2].capApplied).toBe(true);
  expect(assigned.reduce((sum, v) => sum + v.credits, 0)).toBe(50_000);
});
it('rejects missing base, duplicate identity, ambiguous period or fractional counts', () => {
  expect(() => assignPaidPeriodCredits(evidence([upgrade('in_a', 1)]))).toThrow();
  expect(() => assignPaidPeriodCredits(evidence([base, base]))).toThrow();
  expect(() => assignPaidPeriodCredits(evidence([base, { ...upgrade('in_a', 1), remainingEnd: end + 1 }]))).toThrow();
  expect(() => assignPaidPeriodCredits(evidence([{ ...base, newCredits: 1.5 }]))).toThrow();
});
it('rejects incomplete or backdated evidence that changes frozen refund attribution before writes', () => {
  const old = assignPaidPeriodCredits(evidence([base, upgrade('in_b', 2), upgrade('in_c', 3)]));
  expect(() => assertFrozenPeriodAssignments(old, old)).not.toThrow();
  expect(() => assertFrozenPeriodAssignments(assignPaidPeriodCredits(evidence([base, upgrade('in_b', 2)])), old)).toThrow();
  expect(() => assertFrozenPeriodAssignments(assignPaidPeriodCredits(evidence([base, upgrade('in_a', 1), upgrade('in_b', 2), upgrade('in_c', 3)])), old)).toThrow();
});
it('integer rational multiplication remains exact near the safe count bound', () => {
  const huge = { ...base, oldCredits: 0, newCredits: 0 };
  const top = { ...upgrade('in_huge', 1), oldCredits: 0, newCredits: Number.MAX_SAFE_INTEGER };
  const assigned = assignPaidPeriodCredits(evidence([huge, top]));
  expect(assigned[1].credits).toBe(Number(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(29) / BigInt(30)));
});
