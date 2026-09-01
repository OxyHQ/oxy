/**
 * `billing_invoices` + `billing_invoice_receipts` — invoice aggregation, and the
 * one place rounding happens.
 *
 * ## Rounding happens ONCE, at the invoice boundary, and is itself a ledger
 * entry
 *
 * Per-request amounts carry sub-minor-unit precision on purpose: one token costs
 * several orders of magnitude less than one cent, so rounding per request would
 * make a customer's bill depend on how their client chunked its work. `subtotal`
 * is therefore the EXACT sum of the receipts on this invoice, `total` is the
 * rounded figure actually charged, and the difference is booked as a
 * `invoice_rounding` ledger entry rather than discarded as a remainder. A
 * discarded remainder is money that exists in one system and not the other.
 *
 * `minor_unit_exponent` is stored rather than derived from the currency code,
 * because the exponent is not a property this database knows: USD is 2, JPY is
 * 0, BHD is 3. Deriving it would mean a currency table nobody asked for; storing
 * what was used keeps the invoice reproducible.
 *
 * ## Receipts are LINKED, never stamped
 *
 * A receipt is immutable, so it cannot grow an `invoice_id` when it is
 * aggregated. `billing_invoice_receipts` is the append-only link, with the
 * receipt as its primary key so a receipt can land on at most one invoice —
 * billing the same settled charge on two invoices is the failure this key makes
 * unrepresentable.
 *
 * ## Stripe is a reference, not the authority
 *
 * `external_invoice_ref` holds Stripe's invoice id for reconciliation. The
 * epic's invariant is that Stripe is a payment and invoicing processor and not
 * the authoritative usage ledger — so nothing here is derived from Stripe, and
 * the column is deliberately not named `*_id`, because it names a record in
 * Stripe's database rather than a row in this one.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { usageReceipts } from './usageReceipts';
import { users } from './users';

/**
 * Lifecycle of an invoice.
 *
 * `draft` is still accumulating receipts; `open` has been issued and is
 * awaiting payment; `paid` has been settled; `void` was cancelled and its
 * receipts are free to be aggregated again.
 */
export const BILLING_INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;

export type BillingInvoiceStatus = (typeof BILLING_INVOICE_STATUSES)[number];

/** Decimal places in the currency's minor unit. USD 2, JPY 0, BHD 3. */
export const MAX_MINOR_UNIT_EXPONENT = 4;

export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: generatedId(),

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),

    status: text({ enum: BILLING_INVOICE_STATUSES }).notNull().default('draft'),

    /** Exact sum of the linked receipts, at full scale. */
    subtotalAmount: exactAmount().notNull().default('0'),
    /** The rounded figure actually charged. `subtotal - total` is booked. */
    totalAmount: exactAmount().notNull().default('0'),
    minorUnitExponent: integer().notNull().default(2),

    /** Stripe's invoice id, for reconciliation. Never an authority. */
    externalInvoiceRef: text(),

    issuedAt: timestamptz(),
    paidAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One invoice per account, currency and period. A second one for the same
    // window would double-bill whatever both aggregated.
    unique('billing_invoices_account_period_key').on(
      t.accountId,
      t.currency,
      t.periodStart,
      t.periodEnd
    ),
    index('billing_invoices_account_id_period_start_idx').on(t.accountId, t.periodStart.desc()),
    index('billing_invoices_status_idx').on(t.status),

    check(
      'billing_invoices_status_check',
      sql`${t.status} in (${sql.raw(inList(BILLING_INVOICE_STATUSES))})`
    ),
    check('billing_invoices_currency_check', currencyCodeCheck(t.currency)),
    check('billing_invoices_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check('billing_invoices_subtotal_check', sql`${t.subtotalAmount} >= 0`),
    check('billing_invoices_total_check', sql`${t.totalAmount} >= 0`),
    // `sql.raw` on the constant side, never an interpolated value: a JS value
    // in a `check()` is emitted as the literal `$1` in the generated migration
    // and fails at APPLY time, far from its cause.
    check(
      'billing_invoices_minor_unit_exponent_check',
      sql`${t.minorUnitExponent} >= 0 and ${t.minorUnitExponent} <= ${sql.raw(String(MAX_MINOR_UNIT_EXPONENT))}`
    ),
    // Rounding moves the total by strictly less than one minor unit. A larger
    // gap is an aggregation bug, and it is the shape a silently dropped receipt
    // takes.
    check(
      'billing_invoices_rounding_bound_check',
      sql`abs(${t.totalAmount} - ${t.subtotalAmount}) < power(10::numeric, -${t.minorUnitExponent})`
    ),
    // An issued invoice records when. A paid one records both.
    check(
      'billing_invoices_issued_at_check',
      sql`${t.status} in ('draft', 'void') or ${t.issuedAt} is not null`
    ),
    check(
      'billing_invoices_paid_at_check',
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`
    ),
  ]
);

export const billingInvoiceReceipts = pgTable(
  'billing_invoice_receipts',
  {
    /**
     * The receipt IS the key: a settled charge appears on at most one invoice.
     * `RESTRICT` in both directions — neither an invoice nor a receipt may be
     * deleted out from under the link, and neither is ever deleted anyway.
     */
    receiptId: text()
      .primaryKey()
      .references(() => usageReceipts.id, { onDelete: 'restrict' }),
    invoiceId: text()
      .notNull()
      .references(() => billingInvoices.id, { onDelete: 'restrict' }),

    createdAt: createdAt(),
  },
  (t) => [
    // The invoice's own line items.
    index('billing_invoice_receipts_invoice_id_idx').on(t.invoiceId),
  ]
);
