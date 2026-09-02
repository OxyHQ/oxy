/**
 * Durable Oxy side of one exact Kaana BYOK mutation.
 *
 * The operation row is committed before any network request. It contains only
 * immutable identity, an opaque Kaana reference, recognition metadata and a
 * one-way fingerprint. Provider plaintext and transport base64 have no column.
 * An uncertain response can therefore be reconciled against Kaana's signed
 * outcome route with the same operation id, never by guessing or minting a new
 * identity.
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxyhq/db';
import {
  inferenceProviderConnections,
  PROVIDER_CONNECTION_ENVIRONMENTS,
  PROVIDER_CONNECTION_STATUSES,
} from './inferenceProviderConnections';

export const PROVIDER_CREDENTIAL_OPERATION_ACTIONS = ['create', 'rotate', 'revoke'] as const;

export type ProviderCredentialOperationAction =
  (typeof PROVIDER_CREDENTIAL_OPERATION_ACTIONS)[number];

export const PROVIDER_CREDENTIAL_OPERATION_STATES = [
  'pending',
  'reconciliation',
  'manual',
  'applied',
] as const;

export type ProviderCredentialOperationState =
  (typeof PROVIDER_CREDENTIAL_OPERATION_STATES)[number];

export const inferenceProviderCredentialOperations = pgTable(
  'inference_provider_credential_operations',
  {
    /** Oxy-minted opaque id, supplied to Kaana exactly and reused for outcome lookup. */
    id: text().primaryKey(),
    connectionId: text().notNull(),
    action: text({ enum: PROVIDER_CREDENTIAL_OPERATION_ACTIONS }).notNull(),

    /** Exact immutable identity signed in both mutation and outcome requests. */
    provider: text().notNull(),
    ownerAccountId: text().notNull(),
    environment: text({ enum: PROVIDER_CONNECTION_ENVIRONMENTS }).notNull(),

    /** Exact actor string signed on the mutation; outcomes intentionally omit it. */
    operationActor: text().notNull(),

    /** Present only for rotate/revoke and never inferred from another row later. */
    credentialHandle: text(),
    expectedRevision: integer(),

    /** Present only for create/rotate; one-way recognition data, never plaintext. */
    secretSha256: text(),
    keyPrefix: text(),
    /** Snapshot needed to audit a revoke after a later outcome reconciliation. */
    previousConnectionStatus: text({ enum: PROVIDER_CONNECTION_STATUSES }),

    /** `manual` is a confirmed conflict; only an operator may resolve it. */
    state: text({ enum: PROVIDER_CREDENTIAL_OPERATION_STATES }).notNull(),

    /** Exact terminal applied result. A conflict carries no reference. */
    outcomeCredentialHandle: text(),
    outcomeRevision: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'inference_provider_credential_operations_identity_fk',
      columns: [t.connectionId, t.provider, t.ownerAccountId, t.environment],
      foreignColumns: [
        inferenceProviderConnections.id,
        inferenceProviderConnections.provider,
        inferenceProviderConnections.ownerAccountId,
        inferenceProviderConnections.environment,
      ],
    }).onDelete('restrict'),

    /** One unresolved operation owns a connection's custody fence at a time. */
    uniqueIndex('inference_provider_credential_operations_unresolved_key')
      .on(t.connectionId)
      .where(sql`${t.state} in ('pending', 'reconciliation', 'manual')`),
    index('inference_provider_credential_operations_connection_id_created_at_idx').on(
      t.connectionId,
      t.createdAt.desc(),
    ),

    check(
      'inference_provider_credential_operations_action_check',
      sql`${t.action} in (${sql.raw(inList(PROVIDER_CREDENTIAL_OPERATION_ACTIONS))})`,
    ),
    check(
      'inference_provider_credential_operations_state_check',
      sql`${t.state} in (${sql.raw(inList(PROVIDER_CREDENTIAL_OPERATION_STATES))})`,
    ),
    check(
      'inference_provider_credential_operations_id_format',
      sql`${t.id} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    check(
      'inference_provider_credential_operations_actor_format',
      sql`length(${t.operationActor}) between 1 and 256 and ${t.operationActor} = btrim(${t.operationActor}) and ${t.operationActor} !~ E'[\\r\\n]'`,
    ),
    check(
      'inference_provider_credential_operations_reference_format',
      sql`${t.credentialHandle} is null or ${t.credentialHandle} ~ '^kcred_[a-z2-7]{26}$'`,
    ),
    check(
      'inference_provider_credential_operations_reference_pair',
      sql`(${t.credentialHandle} is null) = (${t.expectedRevision} is null)`,
    ),
    check(
      'inference_provider_credential_operations_reference_action',
      sql`(${t.action} = 'create') = (${t.credentialHandle} is null)`,
    ),
    check(
      'inference_provider_credential_operations_expected_revision_positive',
      sql`${t.expectedRevision} is null or ${t.expectedRevision} > 0`,
    ),
    check(
      'inference_provider_credential_operations_secret_fingerprint_action',
      sql`(${t.action} in ('create', 'rotate')) = (${t.secretSha256} is not null)`,
    ),
    check(
      'inference_provider_credential_operations_secret_fingerprint_format',
      sql`${t.secretSha256} is null or ${t.secretSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'inference_provider_credential_operations_key_prefix_action',
      sql`(${t.action} in ('create', 'rotate')) = (${t.keyPrefix} is not null)`,
    ),
    check(
      'inference_provider_credential_operations_key_prefix_length',
      sql`${t.keyPrefix} is null or length(${t.keyPrefix}) between 1 and 12`,
    ),
    check(
      'inference_provider_credential_operations_previous_status_action',
      sql`(${t.action} = 'revoke') = (${t.previousConnectionStatus} is not null)`,
    ),
    check(
      'inference_provider_credential_operations_previous_status_check',
      sql`${t.previousConnectionStatus} is null or ${t.previousConnectionStatus} in (${sql.raw(inList(PROVIDER_CONNECTION_STATUSES))})`,
    ),
    check(
      'inference_provider_credential_operations_outcome_pair',
      sql`(${t.outcomeCredentialHandle} is null) = (${t.outcomeRevision} is null)`,
    ),
    check(
      'inference_provider_credential_operations_outcome_format',
      sql`${t.outcomeCredentialHandle} is null or ${t.outcomeCredentialHandle} ~ '^kcred_[a-z2-7]{26}$'`,
    ),
    check(
      'inference_provider_credential_operations_applied_outcome',
      sql`(${t.state} = 'applied') = (${t.outcomeCredentialHandle} is not null)`,
    ),
    check(
      'inference_provider_credential_operations_outcome_identity',
      sql`${t.outcomeCredentialHandle} is null or ${t.action} = 'create' or ${t.outcomeCredentialHandle} = ${t.credentialHandle}`,
    ),
    check(
      'inference_provider_credential_operations_outcome_revision',
      sql`${t.outcomeRevision} is null or (${t.action} = 'create' and ${t.outcomeRevision} = 1) or (${t.action} <> 'create' and ${t.outcomeRevision} = ${t.expectedRevision} + 1)`,
    ),
  ],
);

export type InferenceProviderCredentialOperationRow =
  typeof inferenceProviderCredentialOperations.$inferSelect;
