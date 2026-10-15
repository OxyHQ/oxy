import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, check, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  SUPERVISION_STATUSES,
  SUPERVISION_INVITATION_STATUSES,
  PURCHASE_APPROVAL_STATUSES,
} from '@oxy.so/contracts';
import { users } from './users';
import { applications } from './applications';
const values = (items: readonly string[]) => sql.raw(items.map((value) => `'${value}'`).join(', '));
/** A safety policy on a human root; no membership, delegated credential or account-kind change. */
export const supervisionProfiles = pgTable(
  'supervision_profiles',
  {
    childAccountId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    guardianAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    status: text({ enum: SUPERVISION_STATUSES }).notNull().default('active'),
    consentVersion: text().notNull(),
    /** Tokens minted before this transition cannot survive a cache or session restore. */
    sessionsValidAfter: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'supervision_profiles_status_check',
      sql`${t.status} in (${values(SUPERVISION_STATUSES)})`,
    ),
    check(
      'supervision_profiles_distinct_guardian_check',
      sql`${t.childAccountId} is distinct from ${t.guardianAccountId}`,
    ),
    index('supervision_profiles_guardian_idx').on(t.guardianAccountId, t.childAccountId),
  ],
);
export const supervisionInvitations = pgTable(
  'supervision_invitations',
  {
    id: generatedId(),
    childAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    guardianAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: SUPERVISION_INVITATION_STATUSES }).notNull().default('pending'),
    consentVersion: text().notNull(),
    expiresAt: timestamptz().notNull(),
    acceptedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'supervision_invitations_status_check',
      sql`${t.status} in (${values(SUPERVISION_INVITATION_STATUSES)})`,
    ),
    check(
      'supervision_invitations_distinct_accounts_check',
      sql`${t.childAccountId} <> ${t.guardianAccountId}`,
    ),
    index('supervision_invitations_guardian_idx').on(t.guardianAccountId, t.status, t.id),
    index('supervision_invitations_child_idx').on(t.childAccountId, t.status, t.id),
    uniqueIndex('supervision_invitations_pending_key')
      .on(t.childAccountId, t.guardianAccountId)
      .where(sql`${t.status}='pending'`),
  ],
);
export const supervisionContacts = pgTable(
  'supervision_contacts',
  {
    childAccountId: text()
      .notNull()
      .references(() => supervisionProfiles.childAccountId, { onDelete: 'cascade' }),
    contactAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    approvedByAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.childAccountId, t.contactAccountId] }),
    index('supervision_contacts_contact_idx').on(t.contactAccountId),
  ],
);
/** Immutable checkout effects. Retained only while the owning child exists; merchant receipts stay in merchant ledgers. */
export const supervisionPurchaseApprovals = pgTable(
  'supervision_purchase_approvals',
  {
    id: generatedId(),
    childAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    operationId: text().notNull(),
    resourceId: text().notNull(),
    cartFingerprint: text().notNull(),
    summary: text().notNull(),
    shippingMinor: bigint({ mode: 'number' }).notNull(),
    taxMinor: bigint({ mode: 'number' }).notNull(),
    discountMinor: bigint({ mode: 'number' }).notNull(),
    roundingAdjustmentMinor: bigint({ mode: 'number' }).notNull(),
    evidenceSealed: boolean().notNull().default(false),
    merchantAccountIds: text().array().notNull(),
    paymentFingerprint: text().notNull(),
    amountMinor: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull(),
    expiresAt: timestamptz().notNull(),
    status: text({ enum: PURCHASE_APPROVAL_STATUSES }).notNull().default('pending'),
    reviewedByAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz(),
    reservedAt: timestamptz(),
    receiptReference: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('supervision_purchase_approvals_merchants_check', sql`cardinality(${t.merchantAccountIds}) between 1 and 100`),
    check(
      'supervision_purchase_approvals_status_check',
      sql`${t.status} in (${values(PURCHASE_APPROVAL_STATUSES)})`,
    ),
    check(
      'supervision_purchase_approvals_amount_check',
      sql`${t.amountMinor} between 0 and 9007199254740991`,
    ),
    check('supervision_purchase_approvals_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    uniqueIndex('supervision_purchase_approvals_operation_key').on(t.applicationId, t.operationId),
    index('supervision_purchase_approvals_child_id_idx').on(t.childAccountId, t.id),
  ],
);
/** Bounded action evidence, never bearer/reauth payloads, DOB or message contents. */
export const supervisionAudit = pgTable(
  'supervision_audit',
  {
    id: generatedId(),
    childAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    applicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    action: text().notNull(),
    relatedAccountId: text(),
    resourceId: text(),
    evidenceReference: text(),
    createdAt: createdAt(),
  },
  (t) => [index('supervision_audit_child_idx').on(t.childAccountId, t.id)],
);

/** Immutable authorization evidence, not the merchant's mutable cart or financial ledger. */
export const supervisionPurchaseLines = pgTable('supervision_purchase_lines', {
  approvalId: text().notNull().references(()=>supervisionPurchaseApprovals.id,{onDelete:'cascade'}),
  position: integer().notNull(), itemReference: text().notNull(), title: text().notNull(), optionsText: text().notNull(),
  merchantAccountId: text().notNull(), quantity: integer().notNull(),
  unitAmountMinor: bigint({mode:'number'}).notNull(), lineAmountMinor: bigint({mode:'number'}).notNull(),
}, t=>[
  primaryKey({columns:[t.approvalId,t.position]}),
  check('supervision_purchase_lines_position_check',sql`${t.position} between 0 and 199`),
  check('supervision_purchase_lines_quantity_check',sql`${t.quantity} between 1 and 1000000`),
  check('supervision_purchase_lines_amounts_check',sql`${t.unitAmountMinor} between 0 and 9007199254740991 and ${t.lineAmountMinor} between 0 and 9007199254740991`),
]);
