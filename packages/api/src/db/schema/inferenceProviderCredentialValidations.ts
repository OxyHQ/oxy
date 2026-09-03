/**
 * Durable Oxy side of a separately authenticated BYOK bootstrap probe.
 *
 * The row is complete before Kaana is called and repeats every exact selector
 * in the signed task. It contains neither plaintext nor ciphertext. A pending
 * row can be dispatched again after an API restart; Kaana's operation ledger
 * returns the original terminal result and re-emits its service-auth callback.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { applications } from './applications';
import {
  inferenceProviderConnections,
  PROVIDER_CONNECTION_ENVIRONMENTS,
  PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES,
} from './inferenceProviderConnections';
import { inferenceDeployments } from './inferenceDeployments';

export const PROVIDER_CREDENTIAL_VALIDATION_OPERATION_STATES = [
  'pending',
  'valid',
  'invalid',
  'inconclusive',
] as const;

export type ProviderCredentialValidationOperationState =
  (typeof PROVIDER_CREDENTIAL_VALIDATION_OPERATION_STATES)[number];

export const inferenceProviderCredentialValidations = pgTable(
  'inference_provider_credential_validations',
  {
    id: generatedId(),
    connectionId: text().notNull(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    provider: text().notNull(),
    ownerAccountId: text().notNull(),
    environment: text({ enum: PROVIDER_CONNECTION_ENVIRONMENTS }).notNull(),
    credentialHandle: text().notNull(),
    credentialRevision: bigint({ mode: 'number' }).notNull(),
    /** Exact customer-selected Oxy catalogue row. */
    deploymentId: text()
      .notNull()
      .references(() => inferenceDeployments.id, { onDelete: 'restrict' }),
    /** Protected exact route bound into the signed Kaana task. */
    kaanaDeploymentId: text().notNull(),
    state: text({ enum: PROVIDER_CREDENTIAL_VALIDATION_OPERATION_STATES })
      .notNull()
      .default('pending'),
    failureCode: text({ enum: PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES }),
    completedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'inference_provider_credential_validations_connection_identity_fk',
      columns: [t.connectionId, t.provider, t.ownerAccountId, t.environment],
      foreignColumns: [
        inferenceProviderConnections.id,
        inferenceProviderConnections.provider,
        inferenceProviderConnections.ownerAccountId,
        inferenceProviderConnections.environment,
      ],
    }).onDelete('restrict'),
    uniqueIndex('inference_provider_credential_validations_pending_generation_key')
      .on(t.connectionId, t.credentialHandle, t.credentialRevision)
      .where(sql`${t.state} = 'pending'`),
    index('inference_provider_credential_validations_connection_created_at_idx').on(
      t.connectionId,
      t.createdAt.desc(),
    ),
    check(
      'inference_provider_credential_validations_state_check',
      sql`${t.state} in (${sql.raw(inList(PROVIDER_CREDENTIAL_VALIDATION_OPERATION_STATES))})`,
    ),
    check(
      'inference_provider_credential_validations_environment_check',
      sql`${t.environment} in (${sql.raw(inList(PROVIDER_CONNECTION_ENVIRONMENTS))})`,
    ),
    check(
      'inference_provider_credential_validations_handle_check',
      sql`${t.credentialHandle} ~ '^kcred_[a-z2-7]{26}$'`,
    ),
    check(
      'inference_provider_credential_validations_revision_check',
      sql`${t.credentialRevision} > 0 and ${t.credentialRevision} <= 9007199254740991`,
    ),
    check(
      'inference_provider_credential_validations_deployment_check',
      sql`length(${t.kaanaDeploymentId}) between 1 and 128 and ${t.kaanaDeploymentId} = btrim(${t.kaanaDeploymentId}) and ${t.kaanaDeploymentId} !~ E'[\\r\\n]'`,
    ),
    check(
      'inference_provider_credential_validations_outcome_check',
      sql`(
        ${t.state} = 'pending' and ${t.failureCode} is null and ${t.completedAt} is null
      ) or (
        ${t.state} = 'valid' and ${t.failureCode} is null and ${t.completedAt} is not null
      ) or (
        ${t.state} = 'invalid' and ${t.failureCode} = 'unauthorized' and ${t.completedAt} is not null
      ) or (
        ${t.state} = 'inconclusive' and ${t.failureCode} is not null and ${t.failureCode} <> 'unauthorized' and ${t.completedAt} is not null
      )`,
    ),
  ],
);

export type InferenceProviderCredentialValidationRow =
  typeof inferenceProviderCredentialValidations.$inferSelect;
