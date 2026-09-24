/**
 * The two tables behind the automatic Kaana → Oxy catalogue sync.
 *
 * `inference_catalogue_auto_approval_policies` is the RECORD an automatically
 * approved deployment points at. A synced route is not "approved because it
 * answers": it is approved because a named, owner-decided policy says every
 * model Kaana discovers may be consumed by official Oxy products
 * (`platform_internal`, `standard_application_use`) and nothing wider. The CHECKs
 * below make that ceiling structural: no row of this table can authorize public
 * resale, BYOK or enterprise exposure, so the sync can never write a route that
 * skips the reviewed resale process.
 *
 * `inference_catalogue_blocklist` is the emergency brake. A model line listed
 * here is never written by the sync, and adding it retires the line's synced
 * deployments immediately. Empty by default.
 *
 * Decided by the owner on 2026-09-25; see docs/inference/catalogue.md,
 * "Automatic sync from Kaana".
 */

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { MODEL_ID_CHECK_PATTERN } from './inferenceSlug';
import { users } from './users';

/** The one policy the sync writes under. Seeded by migration 0103. */
export const KAANA_SYNC_AUTO_APPROVAL_POLICY_ID = 'kaana-sync';

export const inferenceCatalogueAutoApprovalPolicies = pgTable(
  'inference_catalogue_auto_approval_policies',
  {
    id: text().primaryKey(),
    /** Fixed to `platform_internal` by CHECK: an automatic approval never sells. */
    availabilityScope: text().notNull(),
    /** Fixed to `standard_application_use` by CHECK. */
    commercialPermission: text().notNull(),
    /**
     * `false` pauses the sync's writes entirely. Existing rows keep serving
     * until an operator retires them; the blocklist is the per-model brake.
     */
    enabled: boolean().notNull().default(true),
    /** The owner decision this policy records, as prose an auditor can read. */
    description: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'inference_catalogue_auto_approval_policies_internal_only',
      sql`${t.availabilityScope} = 'platform_internal' and ${t.commercialPermission} = 'standard_application_use'`
    ),
    check(
      'inference_catalogue_auto_approval_policies_description_check',
      sql`length(btrim(${t.description})) between 1 and 2000`
    ),
  ]
);

export const inferenceCatalogueBlocklist = pgTable(
  'inference_catalogue_blocklist',
  {
    id: generatedId(),
    /** The model LINE, `<publisher>/<model>`. Every revision of it is blocked. */
    modelId: text().notNull(),
    reason: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('inference_catalogue_blocklist_model_id_key').on(t.modelId),
    check(
      'inference_catalogue_blocklist_model_id_format',
      sql`${t.modelId} ~ ${sql.raw(MODEL_ID_CHECK_PATTERN)}`
    ),
    check(
      'inference_catalogue_blocklist_reason_check',
      sql`length(btrim(${t.reason})) between 1 and 500`
    ),
  ]
);

export type InferenceCatalogueBlocklistRow = typeof inferenceCatalogueBlocklist.$inferSelect;
