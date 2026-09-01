import type { BillingAuditActorKind, BillingAuditEntry, BillingAuditKind } from '@/hooks/use-account-audit';
import { formatMoney } from '@/lib/money';

/**
 * Presentation logic for an account's BILLING audit trail (issue #972).
 *
 * ## The sign is a FIELD, and reading it from anywhere else is the bug
 *
 * `exactDecimalSchema` in `@oxyhq/contracts` is non-negative by regex, and the
 * ledger it guards carries direction in the SHAPE of an entry rather than in a
 * sign — because a signed amount is how a reversal silently becomes a second
 * charge. So `GET /accounts/:id/billing/audit` sends a non-negative `amount`
 * beside a separate `direction` of `'in' | 'out' | 'none'`, and everything on
 * this screen that says which way money went reads THAT field.
 *
 * The tempting alternative is to derive it from `kind`, and it would look
 * correct: all four customer-facing kinds are `in` today. That is precisely what
 * makes it dangerous — a `direction` derived from `kind` cannot be wrong until
 * the first kind that is not `in`, at which point it is wrong on a money screen
 * with nothing logged. `__tests__/billing-audit.test.ts` feeds `kind` and
 * `direction` in DISAGREEMENT so an implementation reading the wrong one fails
 * today rather than then.
 *
 * ## No `Number()` anywhere in this file
 *
 * An amount is an exact decimal STRING with up to 12 fractional digits, and the
 * moment it passes through a JS `number` the exactness is gone silently — the
 * wrong figure still looks like money. Formatting goes through `lib/money.ts`,
 * whose grouping is string splicing, and the sign is PREPENDED to the formatted
 * text rather than applied to a value. Nothing here does arithmetic at all.
 *
 * ## What is deliberately absent
 *
 * There is no actor name and no actor id, because the API projects neither: the
 * entry carries `actorKind` and the staff member's identity is not on the wire
 * at all. {@link billingAuditActorLabel} therefore takes the KIND as its only
 * argument — there is no parameter an identity could arrive through.
 */

/** Which way value crossed the boundary of the customer's own accounts. */
export type BillingAuditDirectionView = {
  /** Prepended to the formatted amount. Empty for `none`. */
  readonly sign: '+' | '-' | '';
  /** The direction in words, for a screen reader and for the column header's sake. */
  readonly label: string;
  readonly tone: 'positive' | 'negative' | 'neutral';
};

/**
 * Read the direction — from `direction`, and from nothing else.
 *
 * Exhaustive with no `default`, so a fourth direction added server-side is a
 * compile error rather than a row silently rendering as `none`.
 */
export function billingAuditDirection(
  entry: Pick<BillingAuditEntry, 'direction'>
): BillingAuditDirectionView {
  switch (entry.direction) {
    case 'in':
      return { sign: '+', label: 'into this account', tone: 'positive' };
    case 'out':
      return { sign: '-', label: 'out of this account', tone: 'negative' };
    case 'none':
      // A real outcome, not a placeholder: an entry whose postings were all
      // internal moved nothing across the boundary, and `+0.00` would be a claim
      // about a direction nothing took.
      return { sign: '', label: 'no movement', tone: 'neutral' };
  }
}

/**
 * The amount as it is shown: the server's exact digits, grouped, with the
 * direction's sign in front.
 *
 * The sign is TEXT concatenated onto formatted text. There is no negative number
 * anywhere in the Console, which is what keeps the non-negative-amount contract
 * true on this side of the wire as well.
 */
export function billingAuditAmount(
  entry: Pick<BillingAuditEntry, 'amount' | 'currency' | 'direction'>
): string {
  return `${billingAuditDirection(entry).sign}${formatMoney(entry.amount, entry.currency)}`;
}

/**
 * What a kind MEANS, in a sentence.
 *
 * The badge itself shows the API's own token (`humaniseAuditToken`), because that
 * is the word a support conversation will quote; this is the explanation beside
 * it. Both, rather than a friendlier rename of one.
 *
 * Exhaustive: a fifth customer-facing kind is a compile error here, which is the
 * only way this screen finds out that the server started publishing one.
 */
export function billingAuditKindDescription(kind: BillingAuditKind): string {
  switch (kind) {
    case 'top_up':
      return 'Funds you added to this account.';
    case 'promotional_grant':
      return 'Credit Oxy granted to this account.';
    case 'settlement_reversal':
      return 'A settled charge returned to this account.';
    case 'invoice_payment':
      return 'A payment that settled an invoice.';
  }
}

/**
 * Who authored the entry, coarsely — and there is no id to go with it.
 *
 * `staff` and `machine` are the distinction a customer auditing a surprise
 * credit actually needs: a person at Oxy did this, or no person did. `unknown`
 * is the third real state — the row predates the actor columns and never
 * recorded one, which the server deliberately did not back-fill into `machine`.
 */
export function billingAuditActorLabel(actorKind: BillingAuditActorKind): string {
  switch (actorKind) {
    case 'staff':
      return 'by Oxy staff';
    case 'machine':
      return 'automatic';
    case 'unknown':
      return 'author not recorded';
  }
}

/** A reference a customer can quote, and what it refers to. */
export interface BillingAuditReference {
  readonly label: string;
  readonly id: string;
}

/**
 * The references an entry carries — none, one, or two.
 *
 * A reversal names BOTH the receipt it reverses and the refund it produced, so
 * this returns a list rather than the first non-null field. `top_up` and
 * `promotional_grant` carry no reference at all: a top-up's processor reference
 * lives on `billing_external_payments`, which the API deliberately does not join
 * in, so the honest answer here is an empty list rather than the entry's own id
 * dressed up as one.
 */
export function billingAuditReferences(
  entry: Pick<BillingAuditEntry, 'receiptId' | 'refundId' | 'invoiceId'>
): ReadonlyArray<BillingAuditReference> {
  const references: Array<BillingAuditReference> = [];
  if (entry.receiptId !== null) {
    references.push({ label: 'receipt', id: entry.receiptId });
  }
  if (entry.refundId !== null) {
    references.push({ label: 'refund', id: entry.refundId });
  }
  if (entry.invoiceId !== null) {
    references.push({ label: 'invoice', id: entry.invoiceId });
  }
  return references;
}
