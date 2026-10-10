/** New subscription grants only. Existing mixed credits_paid is never reconstructed. */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { users } from './users';
import { billingTransactions } from './billingTransactions';

export const SUBSCRIPTION_CREDIT_SOURCES = [
  'subscription_payment',
  'subscription_proration',
  'subscription_promotional_grant',
] as const;

/** Financial identity has one immutable beneficiary, even before issuance. */
export const billingCreditInvoices = pgTable(
  'billing_credit_invoices',
  {
    providerAccountRef: text().notNull(),
    invoiceId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: text().notNull(),
    amountPaid: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.providerAccountRef, t.invoiceId] }),
    unique('billing_credit_invoices_attribution_key').on(
      t.providerAccountRef,
      t.invoiceId,
      t.userId,
      t.currency,
      t.amountPaid,
    ),
    check('billing_credit_invoices_amount_check', sql`${t.amountPaid} >= 0`),
    check(
      'billing_credit_invoices_identity_check',
      sql`length(${t.providerAccountRef}) between 1 and 160 and length(${t.invoiceId}) between 1 and 160 and ${t.currency} ~ '^[a-z]{3}$'`,
    ),
  ],
);

export const billingCreditGrants = pgTable(
  'billing_credit_grants',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    transactionId: text()
      .notNull()
      .references(() => billingTransactions.id, { onDelete: 'restrict' }),
    providerAccountRef: text().notNull(),
    invoiceId: text().notNull(),
    subscriptionId: text().notNull(),
    sourceType: text({ enum: SUBSCRIPTION_CREDIT_SOURCES }).notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    currency: text().notNull(),
    amountPaid: bigint({ mode: 'number' }).notNull(),
    granted: bigint({ mode: 'number' }).notNull(),
    consumed: bigint({ mode: 'number' }).notNull().default(0),
    clawed: bigint({ mode: 'number' }).notNull().default(0),
    promotionId: text(),
    oncePerAccountPromotionId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'billing_credit_grants_invoice_fk',
      columns: [t.providerAccountRef, t.invoiceId, t.userId, t.currency, t.amountPaid],
      foreignColumns: [
        billingCreditInvoices.providerAccountRef,
        billingCreditInvoices.invoiceId,
        billingCreditInvoices.userId,
        billingCreditInvoices.currency,
        billingCreditInvoices.amountPaid,
      ],
    }).onDelete('restrict'),
    unique('billing_credit_grants_invoice_key').on(t.providerAccountRef, t.invoiceId, t.sourceType),
    unique('billing_credit_grants_transaction_key').on(t.transactionId),
    unique('billing_credit_grants_account_identity_key').on(t.id, t.userId),
    unique('billing_credit_grants_trial_key').on(t.userId, t.oncePerAccountPromotionId),
    index('billing_credit_grants_fifo_idx').on(t.userId, t.createdAt, t.id),
    check(
      'billing_credit_grants_source_check',
      sql`${t.sourceType} in ('subscription_payment','subscription_proration','subscription_promotional_grant')`,
    ),
    check(
      'billing_credit_grants_amount_check',
      sql`${t.amountPaid} >= 0 and ${t.granted} >= 0 and ${t.consumed} >= 0 and ${t.clawed} >= 0 and ${t.consumed} + ${t.clawed} <= ${t.granted}`,
    ),
    check('billing_credit_grants_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      'billing_credit_grants_identity_check',
      sql`length(${t.providerAccountRef}) between 1 and 160 and length(${t.invoiceId}) between 1 and 160 and length(${t.subscriptionId}) between 1 and 160 and ${t.currency} ~ '^[a-z]{3}$'`,
    ),
    check(
      'billing_credit_grants_promotion_check',
      sql`(${t.sourceType} = 'subscription_promotional_grant' and ${t.promotionId} is not null and ${t.amountPaid} = 0) or (${t.sourceType} <> 'subscription_promotional_grant' and ${t.promotionId} is null and ${t.oncePerAccountPromotionId} is null and ${t.amountPaid} > 0)`,
    ),
  ],
);

/** One whole deduction intent, including its untouched historical/free portions. */
export const billingCreditSpends = pgTable(
  'billing_credit_spends',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    operationId: text().notNull(),
    amount: bigint({ mode: 'number' }).notNull(),
    trackedPaid: bigint({ mode: 'number' }).notNull(),
    legacyPaid: bigint({ mode: 'number' }).notNull(),
    free: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('billing_credit_spends_intent_key').on(t.userId, t.operationId),
    unique('billing_credit_spends_account_identity_key').on(t.id, t.userId),
    check(
      'billing_credit_spends_count_check',
      sql`${t.amount} >= 0 and ${t.trackedPaid} >= 0 and ${t.legacyPaid} >= 0 and ${t.free} >= 0 and ${t.amount} = ${t.trackedPaid} + ${t.legacyPaid} + ${t.free}`,
    ),
    check('billing_credit_spends_intent_check', sql`length(${t.operationId}) between 1 and 160`),
  ],
);

/** Immutable attribution of a spend to specific grants. */
export const billingCreditConsumptions = pgTable(
  'billing_credit_consumptions',
  {
    spendId: text().notNull(),
    grantId: text().notNull(),
    userId: text().notNull(),
    amount: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.spendId, t.grantId] }),
    foreignKey({
      name: 'billing_credit_consumptions_spend_fk',
      columns: [t.spendId, t.userId],
      foreignColumns: [billingCreditSpends.id, billingCreditSpends.userId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_credit_consumptions_grant_fk',
      columns: [t.grantId, t.userId],
      foreignColumns: [billingCreditGrants.id, billingCreditGrants.userId],
    }).onDelete('restrict'),
    check('billing_credit_consumptions_count_check', sql`${t.amount} > 0`),
  ],
);

/** Cumulative provider snapshots, including a refund arriving before the grant. */
export const billingCreditRefundObservations = pgTable(
  'billing_credit_refund_observations',
  {
    providerAccountRef: text().notNull(),
    eventId: text().notNull(),
    invoiceId: text().notNull(),
    chargeId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: text().notNull(),
    amountPaid: bigint({ mode: 'number' }).notNull(),
    amountRefunded: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.providerAccountRef, t.eventId] }),
    foreignKey({
      name: 'billing_credit_refund_observations_invoice_fk',
      columns: [t.providerAccountRef, t.invoiceId, t.userId, t.currency, t.amountPaid],
      foreignColumns: [
        billingCreditInvoices.providerAccountRef,
        billingCreditInvoices.invoiceId,
        billingCreditInvoices.userId,
        billingCreditInvoices.currency,
        billingCreditInvoices.amountPaid,
      ],
    }).onDelete('restrict'),
    index('billing_credit_refund_observations_invoice_idx').on(t.providerAccountRef, t.invoiceId),
    check(
      'billing_credit_refund_observations_amount_check',
      sql`${t.amountPaid} > 0 and ${t.amountRefunded} >= 0 and ${t.amountRefunded} <= ${t.amountPaid}`,
    ),
    check(
      'billing_credit_refund_observations_identity_check',
      sql`length(${t.providerAccountRef}) between 1 and 160 and length(${t.eventId}) between 1 and 160 and length(${t.invoiceId}) between 1 and 160 and length(${t.chargeId}) between 1 and 160 and ${t.currency} ~ '^[a-z]{3}$'`,
    ),
  ],
);
