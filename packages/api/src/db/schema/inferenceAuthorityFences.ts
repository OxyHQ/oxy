/** Permanent admission barrier for an explicitly migrated workload population.
 * Existing settlements remain owned by Oxy. No expiry or automatic reversal.
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';
import { INFERENCE_ENVIRONMENTS } from './usageReservations';

export const inferenceAuthorityFences = pgTable(
  'inference_authority_fences',
  {
    id: generatedId(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),
    credentialKind: text({ enum: ['workload'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('inference_authority_fences_population_key').on(
      t.applicationId,
      t.ownerAccountId,
      t.environment,
      t.credentialKind,
    ),
    check(
      'inference_authority_fences_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`,
    ),
    check(
      'inference_authority_fences_credential_kind_check',
      sql`${t.credentialKind} = 'workload'`,
    ),
  ],
);
