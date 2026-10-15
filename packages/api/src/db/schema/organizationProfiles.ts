import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  ORGANIZATION_CLAIM_DECISIONS,
  ORGANIZATION_CLAIM_STATUSES,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  type Organization,
} from '@oxy.so/contracts';
import { users } from './users';
const values = (items: readonly string[]) => sql.raw(items.map((value) => `'${value}'`).join(', '));

/** Same account ID as Oxy identity; current name/avatar remain solely on users. */
export const organizationProfiles = pgTable(
  'organization_profiles',
  {
    accountId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationType: text({ enum: ORGANIZATION_TYPES }).notNull().default('other'),
    legalName: text(),
    websiteUrl: text(),
    countryCode: text(),
    aliases: jsonb().$type<Organization['aliases']>().notNull().default([]),
    claimStatus: text({ enum: ORGANIZATION_CLAIM_STATUSES }).notNull().default('unclaimed'),
    status: text({ enum: ORGANIZATION_STATUSES }).notNull().default('active'),
    mergedIntoAccountId: text().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'organization_profiles_type_check',
      sql`${table.organizationType} in (${values(ORGANIZATION_TYPES)})`,
    ),
    check(
      'organization_profiles_status_check',
      sql`${table.status} in (${values(ORGANIZATION_STATUSES)})`,
    ),
    check(
      'organization_profiles_claim_status_check',
      sql`${table.claimStatus} in (${values(ORGANIZATION_CLAIM_STATUSES)})`,
    ),
    check(
      'organization_profiles_country_code_check',
      sql`${table.countryCode} is null or ${table.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'organization_profiles_merge_check',
      sql`(${table.status} = 'merged') = (${table.mergedIntoAccountId} is not null) and ${table.accountId} is distinct from ${table.mergedIntoAccountId}`,
    ),
    index('organization_profiles_type_status_account_idx').on(
      table.organizationType,
      table.status,
      table.accountId,
    ),
    index('organization_profiles_merge_idx').on(table.mergedIntoAccountId),
  ],
);

/** Stable external IDs map to one Oxy identity; never a second company record. */
export const organizationExternalIds = pgTable(
  'organization_external_ids',
  {
    namespace: text().notNull(),
    externalId: text().notNull(),
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.externalId] }),
    index('organization_external_ids_account_idx').on(table.accountId),
  ],
);

/** Private claim evidence stays out of the public directory. */
export const organizationClaims = pgTable(
  'organization_claims',
  {
    id: generatedId(),
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimantUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: ORGANIZATION_CLAIM_DECISIONS }).notNull().default('pending'),
    evidenceReference: text().notNull(),
    reviewedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    reviewEvidenceReference: text(),
    reviewedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'organization_claims_status_check',
      sql`${table.status} in (${values(ORGANIZATION_CLAIM_DECISIONS)})`,
    ),
    index('organization_claims_account_status_idx').on(table.accountId, table.status),
    index('organization_claims_claimant_id_idx').on(table.claimantUserId, table.id),
    index('organization_claims_status_id_idx').on(table.status, table.id),
    uniqueIndex('organization_claims_pending_claimant_key')
      .on(table.accountId, table.claimantUserId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/** Append-only staff decisions; never name-match evidence or inherited commercial ownership. */
export const organizationDirectoryAudit = pgTable('organization_directory_audit', {
  id: generatedId(),
  accountId: text().notNull(),
  actorUserId: text(),
  actorApplicationId: text(),
  action: text().notNull(),
  evidenceReference: text().notNull(),
  relatedAccountId: text(),
  createdAt: createdAt(),
});

/** Derived prefix-search projection, maintained only by identity/profile triggers. */
export const organizationSearchTerms = pgTable(
  'organization_search_terms',
  {
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    term: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.term] }),
    index('organization_search_terms_prefix_idx').on(sql`${table.term} text_pattern_ops`),
  ],
);
