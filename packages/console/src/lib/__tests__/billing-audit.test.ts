import { describe, expect, it } from 'vitest';
import type { BillingAuditEntry } from '@/hooks/use-account-audit';
import {
  billingAuditActorLabel,
  billingAuditAmount,
  billingAuditDirection,
  billingAuditKindDescription,
  billingAuditReferences,
} from '@/lib/billing-audit';

/**
 * The fixtures are the rows `GET /accounts/:id/billing/audit` projects, taken
 * from the mapper that builds them (`accountBillingAudit.service.ts`, `pageOf`):
 * a non-negative exact-decimal `amount`, a separate `direction`, an `actorKind`
 * with no id beside it, and the three reference columns of which a reversal is
 * the only kind that fills two.
 */
const TOP_UP: BillingAuditEntry = {
  id: 'entry_1',
  kind: 'top_up',
  currency: 'USD',
  amount: '25.000000000000',
  direction: 'in',
  actorKind: 'machine',
  receiptId: null,
  refundId: null,
  invoiceId: null,
  createdAt: '2026-08-18T10:00:00.000Z',
};

const GRANT: BillingAuditEntry = {
  id: 'entry_2',
  kind: 'promotional_grant',
  currency: 'USD',
  amount: '10.000000000000',
  direction: 'in',
  actorKind: 'staff',
  receiptId: null,
  refundId: null,
  invoiceId: null,
  createdAt: '2026-08-18T09:00:00.000Z',
};

const REVERSAL: BillingAuditEntry = {
  id: 'entry_3',
  kind: 'settlement_reversal',
  currency: 'USD',
  amount: '0.004212000000',
  direction: 'in',
  actorKind: 'machine',
  receiptId: 'receipt_1',
  refundId: 'refund_1',
  invoiceId: null,
  createdAt: '2026-08-18T08:00:00.000Z',
};

const INVOICE_PAYMENT: BillingAuditEntry = {
  id: 'entry_4',
  kind: 'invoice_payment',
  currency: 'USD',
  amount: '120.000000000000',
  direction: 'in',
  actorKind: 'machine',
  receiptId: null,
  refundId: null,
  invoiceId: 'invoice_1',
  createdAt: '2026-08-18T07:00:00.000Z',
};

describe('billingAuditDirection', () => {
  /**
   * THE load-bearing case, and the reason the fields are fed in DISAGREEMENT.
   *
   * All four customer-facing kinds are `in` today, so a direction derived from
   * `kind` would be indistinguishable from a correct one on every row the ledger
   * currently writes — and would be wrong, on a money screen, on the first kind
   * that is not. These two entries carry a `kind` and a `direction` that
   * contradict each other; only an implementation reading `direction` answers
   * them the way the ledger meant.
   */
  it('reads the direction field, not the kind that correlates with it', () => {
    expect(billingAuditDirection({ ...TOP_UP, direction: 'out' }).sign).toBe('-');
    expect(billingAuditDirection({ ...REVERSAL, direction: 'out' }).sign).toBe('-');
    // And the reverse disagreement: a kind that reads like a charge, moving in.
    expect(billingAuditDirection({ ...REVERSAL, direction: 'in' }).sign).toBe('+');
  });

  it('gives the three directions three distinct readings', () => {
    const readings = (['in', 'out', 'none'] as const).map((direction) =>
      billingAuditDirection({ direction })
    );

    expect(readings.map((reading) => reading.sign)).toEqual(['+', '-', '']);
    expect(new Set(readings.map((reading) => reading.tone)).size).toBe(3);
    expect(new Set(readings.map((reading) => reading.label)).size).toBe(3);
  });

  /**
   * `none` is a real outcome — an entry whose postings were all internal moved
   * nothing across the boundary — so it gets no sign at all. `+0.00` would be a
   * claim about a direction nothing took.
   */
  it('gives an unmoved entry no sign', () => {
    expect(billingAuditDirection({ direction: 'none' }).sign).toBe('');
    expect(billingAuditDirection({ direction: 'none' }).tone).toBe('neutral');
  });
});

describe('billingAuditAmount', () => {
  /**
   * The property the whole exact-decimal contract exists for: twelve fractional
   * digits and an integer part past 2^53 survive the render unchanged.
   *
   * A `Number()` anywhere on this path turns `9007199254740993` into
   * `9007199254740992` and drops the trailing `1` from the fraction — silently,
   * because the wrong figure still looks like money.
   */
  it('never rounds: an amount a float would mangle comes through intact', () => {
    const exact = billingAuditAmount({
      amount: '9007199254740993.000000000001',
      currency: 'USD',
      direction: 'in',
    });

    expect(exact).toBe('+9,007,199,254,740,993.000000000001 USD');
    expect(exact).not.toContain('9007199254740992');
  });

  it('keeps a tiny reversal legible instead of rounding it to nothing', () => {
    // A per-request refund is smaller than a cent. `0.00` would read as though
    // nothing had been returned.
    expect(billingAuditAmount(REVERSAL)).toBe('+0.004212 USD');
  });

  /**
   * The sign is TEXT in front of formatted text — there is no negative number
   * anywhere in the Console, which is what keeps the non-negative-amount contract
   * true on this side of the wire too.
   */
  it('signs the amount from the direction without negating the value', () => {
    expect(billingAuditAmount({ ...TOP_UP, direction: 'out' })).toBe('-25.00 USD');
    expect(billingAuditAmount({ ...TOP_UP, direction: 'none' })).toBe('25.00 USD');
    expect(billingAuditAmount(TOP_UP)).toBe('+25.00 USD');
  });
});

describe('billingAuditActorLabel', () => {
  /**
   * Coarse on purpose, and coarse in BOTH directions: `staff` says a person at
   * Oxy did this without saying who, and `machine` says no person did. The API
   * does not project `actorUserId` at all, and this function has no parameter an
   * identity could arrive through — the signature is the mechanism, the
   * assertions are the record of it.
   */
  it('names a kind, never a person', () => {
    expect(billingAuditActorLabel('staff')).toBe('by Oxy staff');
    expect(billingAuditActorLabel('machine')).toBe('automatic');
    expect(billingAuditActorLabel('unknown')).toBe('author not recorded');

    for (const label of ['staff', 'machine', 'unknown'] as const) {
      // No id, no handle, no digits — nothing that could identify one employee.
      expect(billingAuditActorLabel(label)).not.toMatch(/\d/);
    }
  });

  /**
   * `unknown` is not a synonym for `machine`. The server deliberately did NOT
   * back-fill rows written before the actor columns, because "no person authored
   * it" and "we did not record who did" are exactly the two readings those
   * columns exist to separate.
   */
  it('keeps an unrecorded author apart from an automatic one', () => {
    expect(billingAuditActorLabel('unknown')).not.toBe(billingAuditActorLabel('machine'));
  });
});

describe('billingAuditKindDescription', () => {
  it('explains each of the four kinds distinctly', () => {
    const descriptions = (
      ['top_up', 'promotional_grant', 'settlement_reversal', 'invoice_payment'] as const
    ).map(billingAuditKindDescription);

    expect(new Set(descriptions).size).toBe(4);
    expect(billingAuditKindDescription('settlement_reversal')).toContain('returned');
  });
});

describe('billingAuditReferences', () => {
  /**
   * A reversal names both the receipt it reverses and the refund it produced, so
   * a "first non-null field" implementation loses one of them — and the one it
   * loses is the refund, which is the id a customer chasing their money quotes.
   */
  it('carries both of a reversal\'s references, not the first', () => {
    expect(billingAuditReferences(REVERSAL)).toEqual([
      { label: 'receipt', id: 'receipt_1' },
      { label: 'refund', id: 'refund_1' },
    ]);
  });

  it('carries an invoice payment\'s invoice', () => {
    expect(billingAuditReferences(INVOICE_PAYMENT)).toEqual([
      { label: 'invoice', id: 'invoice_1' },
    ]);
  });

  /**
   * A top-up and a grant carry NO reference — the processor reference lives on a
   * table the API deliberately does not join in. An empty list is the honest
   * answer; the entry's own id dressed up as a receipt would not be.
   *
   * The reversal case above is this assertion's positive control: an
   * always-empty implementation fails there.
   */
  it('invents no reference for a kind that has none', () => {
    expect(billingAuditReferences(TOP_UP)).toEqual([]);
    expect(billingAuditReferences(GRANT)).toEqual([]);
  });
});
