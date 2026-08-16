/**
 * Monthly invoicing for accounts billed in arrears.
 *
 * `billing_profiles.billing_mode = 'invoiced'` gives an enterprise account a
 * credit limit to draw against instead of a prepaid balance. Without a way to
 * CLOSE a period, that is a limit that fills up and is never billed — so this
 * module is the other half of the epic's "monthly invoiced enterprise accounts
 * and credit limits", not an extra.
 *
 * ## Only for `invoiced` accounts, deliberately
 *
 * A prepaid account's charges were settled from its own money at request time.
 * An invoice for one would be a STATEMENT, and a statement that booked a
 * rounding entry would move money that has already been paid. {@link closeInvoicePeriod}
 * therefore refuses a prepaid profile by name rather than producing a document
 * that looks like a demand for payment.
 *
 * ## Rounding happens exactly once, and is booked
 *
 * Per-request amounts carry sub-minor-unit precision on purpose: one token costs
 * several orders of magnitude less than one cent, so rounding per request would
 * make a customer's bill depend on how their client chunked its work. The
 * invoice is where that precision meets a currency:
 *
 *   `subtotal` — the exact sum of the linked receipts, at full scale
 *   `total`    — the same figure rounded half-up to whole minor units
 *   the difference — booked as an `invoice_rounding` journal entry
 *
 * A discarded remainder is money that exists in one system and not the other,
 * which is precisely what the next reconciliation pass would report and nobody
 * would be able to explain.
 *
 * ## Receipts are LINKED, never stamped
 *
 * A receipt is immutable — the trigger refuses an UPDATE — so it cannot grow an
 * `invoice_id`. `billing_invoice_receipts` is the append-only link, with the
 * receipt as its primary key, so a settled charge can land on at most one
 * invoice. Billing the same charge twice is unrepresentable rather than
 * prevented by care.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { billingInvoiceSchema, type BillingInvoice } from '@oxyhq/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountBalances } from '../db/schema/accountBalances';
import { billingExternalPayments } from '../db/schema/billingExternalPayments';
import { billingInvoiceReceipts, billingInvoices } from '../db/schema/billingInvoices';
import { billingProfiles } from '../db/schema/billingProfiles';
import { usageReceipts } from '../db/schema/usageReceipts';
import { minorUnitExponentFor, roundExactDecimalToMinorUnits } from '../utils/minorUnits';
import { lockBalance, writeEntry } from './inferenceLedger.service';

type BillingInvoiceRow = typeof billingInvoices.$inferSelect;

/** Millisecond-precision `now()`, matching the schema's timestamp convention. */
const NOW = sql`date_trunc('milliseconds', now())`;

export function toBillingInvoice(row: BillingInvoiceRow, receiptCount: number): BillingInvoice {
  return billingInvoiceSchema.parse({
    schemaVersion: 1,
    id: row.id,
    accountId: row.accountId,
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    subtotalAmount: row.subtotalAmount,
    totalAmount: row.totalAmount,
    minorUnitExponent: row.minorUnitExponent,
    externalInvoiceRef: row.externalInvoiceRef ?? undefined,
    issuedAt: row.issuedAt?.toISOString(),
    paidAt: row.paidAt?.toISOString(),
    receiptCount,
  });
}

export interface CloseInvoicePeriodInput {
  readonly accountId: string;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export type CloseInvoicePeriodResult =
  | { readonly status: 'issued'; readonly invoice: BillingInvoice }
  | { readonly status: 'already-issued'; readonly invoice: BillingInvoice }
  | { readonly status: 'nothing-to-invoice' }
  | { readonly status: 'not-provisioned'; readonly accountId: string }
  | { readonly status: 'not-invoiced'; readonly accountId: string };

/**
 * Aggregate a window's settled charges into one issued invoice.
 *
 * The whole thing is one transaction opened by locking the balance row — the
 * same serialization point every money path in this package opens with — so an
 * invoice cannot be assembled while a settlement is landing halfway through its
 * own window. Two concurrent closes of one period queue on that lock and the
 * loser sees the invoice the winner issued.
 *
 * Timestamps are bound as ISO strings with an explicit cast wherever raw SQL is
 * used: a bare `Date` fails at SERIALISATION in the driver, and this path mixes
 * the query builder (which binds them fine) with `execute` (which does not).
 */
export async function closeInvoicePeriod(
  input: CloseInvoicePeriodInput
): Promise<CloseInvoicePeriodResult> {
  return getDb().transaction(async (tx): Promise<CloseInvoicePeriodResult> => {
    const [profile] = await tx
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.accountId, input.accountId))
      .limit(1);
    if (!profile) {
      return { status: 'not-provisioned', accountId: input.accountId };
    }
    if (profile.billingMode !== 'invoiced') {
      return { status: 'not-invoiced', accountId: input.accountId };
    }

    const locked = await lockBalance(tx, input.accountId, input.currency);
    if (!locked) {
      return { status: 'not-provisioned', accountId: input.accountId };
    }

    const [existing] = await tx
      .select()
      .from(billingInvoices)
      .where(
        and(
          eq(billingInvoices.accountId, input.accountId),
          eq(billingInvoices.currency, input.currency),
          eq(billingInvoices.periodStart, input.periodStart),
          eq(billingInvoices.periodEnd, input.periodEnd)
        )
      )
      .limit(1);
    if (existing && existing.status !== 'void') {
      return {
        status: 'already-issued',
        invoice: toBillingInvoice(existing, await countInvoiceReceipts(tx, existing.id)),
      };
    }

    // Receipts in the window that are not already on an invoice. The NOT EXISTS
    // is what makes a re-run after a voided invoice pick the same charges up
    // again rather than silently dropping them.
    const unbilled = await tx
      .select({ id: usageReceipts.id, billedAmount: usageReceipts.billedAmount })
      .from(usageReceipts)
      .where(
        and(
          eq(usageReceipts.accountId, input.accountId),
          eq(usageReceipts.currency, input.currency),
          gte(usageReceipts.settledAt, input.periodStart),
          lt(usageReceipts.settledAt, input.periodEnd),
          sql`not exists (
            select 1 from ${billingInvoiceReceipts} link
            join ${billingInvoices} inv on inv.id = link.invoice_id
            where link.receipt_id = ${usageReceipts.id} and inv.status <> 'void'
          )`
        )
      );

    if (unbilled.length === 0) {
      return { status: 'nothing-to-invoice' };
    }

    // The sum runs in SQL, over `numeric`. Adding these in JavaScript is exactly
    // the float error the whole ledger is built to avoid, and an invoice is the
    // one number a customer checks by hand.
    const [totals] = await executeRows<{ subtotal: string }>(
      tx,
      sql`
        select round(sum(r.billed_amount), 12)::text as subtotal
        from ${usageReceipts} r
        where r.id = any(${sql.param(unbilled.map((row) => row.id))}::text[])
      `
    );
    const subtotal = totals?.subtotal ?? '0';

    const exponent = minorUnitExponentFor(input.currency);
    const rounding = roundExactDecimalToMinorUnits(subtotal, exponent);

    const [invoice] = await tx
      .insert(billingInvoices)
      .values({
        accountId: input.accountId,
        currency: input.currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: 'open',
        subtotalAmount: subtotal,
        totalAmount: rounding.roundedAmount,
        minorUnitExponent: exponent,
        issuedAt: new Date(),
      })
      .returning();

    await tx
      .insert(billingInvoiceReceipts)
      .values(unbilled.map((row) => ({ receiptId: row.id, invoiceId: invoice.id })));

    if (rounding.direction !== 'exact') {
      // Rounding DOWN means the customer owes less than the exact sum, so value
      // returns from revenue to the receivable; rounding UP is the reverse. The
      // amount is the remainder, always non-negative — direction is carried by
      // WHICH way the posting runs, never by a sign, because a signed amount is
      // how a correction silently becomes a second charge.
      await writeEntry(tx, {
        idempotencyKey: `invoice-rounding:${invoice.id}`,
        accountId: input.accountId,
        currency: input.currency,
        kind: 'invoice_rounding',
        invoiceId: invoice.id,
        postings:
          rounding.direction === 'rounded_down'
            ? [
                {
                  source: 'platform_revenue',
                  destination: 'invoice_receivable',
                  amount: rounding.remainder,
                },
              ]
            : [
                {
                  source: 'invoice_receivable',
                  destination: 'platform_revenue',
                  amount: rounding.remainder,
                },
              ],
      });

      await tx.execute(sql`
        update ${accountBalances}
        set invoiced_outstanding = ${accountBalances.invoicedOutstanding}
              ${sql.raw(rounding.direction === 'rounded_down' ? '-' : '+')} ${rounding.remainder}::numeric,
            updated_at = ${NOW}
        where ${accountBalances.accountId} = ${input.accountId}
          and ${accountBalances.currency} = ${input.currency}
      `);
    }

    return {
      status: 'issued',
      invoice: toBillingInvoice(invoice, unbilled.length),
    };
  });
}

export interface RecordInvoicePaymentInput {
  readonly invoiceId: string;
  /** Exact decimal string, strictly positive. */
  readonly amount: string;
  /** The processor's own invoice or payment reference. */
  readonly externalRef: string;
  readonly occurredAt?: Date;
}

export type RecordInvoicePaymentResult =
  | { readonly status: 'recorded'; readonly invoice: BillingInvoice }
  | { readonly status: 'already-recorded'; readonly invoice: BillingInvoice }
  | { readonly status: 'unknown-invoice'; readonly invoiceId: string }
  | { readonly status: 'not-open'; readonly invoiceStatus: string };

/**
 * Record that an invoice was paid, reducing what the account owes.
 *
 * The posting is `external_settlement → invoice_receivable`, which is the exact
 * reverse direction of the draw a settlement made against the receivable — so
 * `invoiced_outstanding`, which is the negation of that account's journal
 * balance, comes back down by the amount paid.
 *
 * Idempotent on the invoice, through the journal's own unique key: a redelivered
 * processor event composes the same `invoice-payment:<id>` key and writes
 * nothing. `ON CONFLICT … DO NOTHING RETURNING` throughout, never a caught
 * duplicate-key error.
 */
export async function recordInvoicePayment(
  input: RecordInvoicePaymentInput
): Promise<RecordInvoicePaymentResult> {
  return getDb().transaction(async (tx): Promise<RecordInvoicePaymentResult> => {
    const [invoice] = await tx
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.id, input.invoiceId))
      .limit(1);
    if (!invoice) {
      return { status: 'unknown-invoice', invoiceId: input.invoiceId };
    }

    const locked = await lockBalance(tx, invoice.accountId, invoice.currency);
    if (!locked) {
      return { status: 'unknown-invoice', invoiceId: input.invoiceId };
    }

    // Re-read under the lock: a concurrent payment may have closed it between
    // the first select and here, and paying an invoice twice is the failure this
    // whole function is arranged around.
    const [current] = await tx
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.id, input.invoiceId))
      .limit(1);
    if (current.status === 'paid') {
      return {
        status: 'already-recorded',
        invoice: toBillingInvoice(current, await countInvoiceReceipts(tx, current.id)),
      };
    }
    if (current.status !== 'open') {
      return { status: 'not-open', invoiceStatus: current.status };
    }

    const entryId = await writeEntry(tx, {
      idempotencyKey: `invoice-payment:${current.id}`,
      accountId: current.accountId,
      currency: current.currency,
      kind: 'invoice_payment',
      invoiceId: current.id,
      postings: [
        {
          source: 'external_settlement',
          destination: 'invoice_receivable',
          amount: input.amount,
        },
      ],
    });

    // The reconciliation anchor for an invoice, exactly as a top-up gets one.
    // Without it a paid invoice is invisible to the pass that compares Oxy's
    // records against the processor's.
    await tx
      .insert(billingExternalPayments)
      .values({
        accountId: current.accountId,
        currency: current.currency,
        provider: 'stripe',
        externalKind: 'invoice',
        externalRef: input.externalRef,
        amount: input.amount,
        ledgerEntryId: entryId,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .onConflictDoNothing();

    await tx.execute(sql`
      update ${accountBalances}
      set invoiced_outstanding = greatest(
            0::numeric,
            ${accountBalances.invoicedOutstanding} - ${input.amount}::numeric
          ),
          updated_at = ${NOW}
      where ${accountBalances.accountId} = ${current.accountId}
        and ${accountBalances.currency} = ${current.currency}
    `);

    const [paid] = await tx
      .update(billingInvoices)
      .set({
        status: 'paid',
        paidAt: new Date(),
        externalInvoiceRef: input.externalRef,
        updatedAt: new Date(),
      })
      .where(eq(billingInvoices.id, current.id))
      .returning();

    return {
      status: 'recorded',
      invoice: toBillingInvoice(paid, await countInvoiceReceipts(tx, paid.id)),
    };
  });
}

async function countInvoiceReceipts(
  tx: DatabaseOrTransaction,
  invoiceId: string
): Promise<number> {
  const rows = await executeRows<{ total: string }>(
    tx,
    sql`
      select count(*)::text as total
      from ${billingInvoiceReceipts}
      where invoice_id = ${invoiceId}
    `
  );
  // `count(*)` is a bigint, which postgres.js decodes as a STRING. Cast in SQL
  // and convert here so the coercion is visible rather than a string sitting in
  // a field typed `number`.
  return Number(rows[0]?.total ?? '0');
}

/** An account's invoices, newest period first. */
export async function listAccountInvoices(
  accountId: string,
  limit = 24
): Promise<BillingInvoice[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.accountId, accountId))
    .orderBy(sql`${billingInvoices.periodStart} desc`)
    .limit(limit);

  return Promise.all(rows.map(async (row) => toBillingInvoice(row, await countInvoiceReceipts(db, row.id))));
}
