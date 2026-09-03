/**
 * Durable control-plane side of explicit BYOK bootstrap validation.
 *
 * The customer selects an exact Oxy catalogue deployment id. Oxy resolves that
 * row to its protected exact Kaana route id once, stores both identities, and
 * signs only the protected route into the task. No name, ordering or implicit
 * "first deployment" decision exists anywhere in this module.
 */

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  kaanaCredentialValidationOutcomeSchema,
  kaanaCredentialValidationTaskSchema,
  providerCredentialValidationDeploymentSchema,
  providerCredentialValidationOperationSchema,
  type KaanaCredentialValidationOutcome,
  type KaanaCredentialValidationTask,
  type ProviderCredentialValidationDeployment,
  type ProviderCredentialValidationOperation,
} from '@oxyhq/contracts';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type Transaction } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { inferenceDeployments } from '../db/schema/inferenceDeployments';
import {
  inferenceProviderConnectionAuditEvents,
} from '../db/schema/inferenceProviderConnectionAuditEvents';
import {
  inferenceProviderConnections,
  type InferenceProviderConnectionRow,
} from '../db/schema/inferenceProviderConnections';
import {
  inferenceProviderCredentialValidations,
  type InferenceProviderCredentialValidationRow,
} from '../db/schema/inferenceProviderCredentialValidations';
import { userAncestors } from '../db/schema/userAncestors';
import { users } from '../db/schema/users';
import type { KaanaCredentialValidationDispatcher } from './kaanaCredentialValidation';

export type StartProviderCredentialValidationResult =
  | {
      readonly status: 'accepted';
      readonly operation: ProviderCredentialValidationOperation;
      readonly dispatch: 'accepted' | 'retry_required';
    }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'generation-not-ready' }
  | { readonly status: 'revoked' }
  | { readonly status: 'application-unavailable' }
  | { readonly status: 'application-not-applicable' }
  | { readonly status: 'deployment-unavailable' }
  | { readonly status: 'operation-conflict' };

export type RecordProviderCredentialValidationOutcomeResult =
  | { readonly status: 'recorded'; readonly operation: ProviderCredentialValidationOperation }
  | { readonly status: 'unknown-operation' }
  | { readonly status: 'selector-mismatch' }
  | { readonly status: 'outcome-conflict' }
  | { readonly status: 'pending-outcome' };

export async function listProviderCredentialValidationDeployments(input: {
  readonly connectionId: string;
  readonly applicationId: string;
}): Promise<
  | { readonly status: 'available'; readonly deployments: readonly ProviderCredentialValidationDeployment[] }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'application-unavailable' }
  | { readonly status: 'application-not-applicable' }
> {
  return getDb().transaction(async (tx) => {
    const connection = await connectionRow(tx, input.connectionId);
    if (connection === undefined) return { status: 'unknown-connection' };
    const applicable = await applicationApplicability(tx, connection, input.applicationId);
    if (applicable !== 'applicable') return { status: applicable };

    const rows = await tx
      .select({ deploymentId: inferenceDeployments.id })
      .from(inferenceDeployments)
      .where(
        and(
          eq(inferenceDeployments.providerSlug, connection.provider),
          eq(inferenceDeployments.availabilityScope, 'byok_only'),
          eq(inferenceDeployments.commercialPermission, 'customer_byok'),
          eq(inferenceDeployments.permissionState, 'approved'),
          inArray(inferenceDeployments.status, ['active', 'degraded']),
          isNotNull(inferenceDeployments.internalRouteId),
        ),
      );
    return {
      status: 'available' as const,
      deployments: rows.map((row) =>
        providerCredentialValidationDeploymentSchema.parse(row),
      ),
    };
  });
}

/**
 * Create or resume the one pending operation for this exact generation.
 * Dispatch happens only after commit. A failed dispatch therefore leaves a
 * durable operation which this same method can resend after restart.
 */
export async function startProviderCredentialValidation(
  input: {
    readonly connectionId: string;
    readonly applicationId: string;
    readonly deploymentId: string;
  },
  dispatcher: KaanaCredentialValidationDispatcher,
): Promise<StartProviderCredentialValidationResult> {
  const prepared = await getDb().transaction(async (tx) => {
    const connection = await lockConnectionRow(tx, input.connectionId);
    if (connection === undefined) return { status: 'unknown-connection' as const };
    if (connection.status === 'revoked') return { status: 'revoked' as const };
    if (
      connection.custodyState !== 'ready' ||
      connection.credentialHandle === null ||
      connection.credentialRevision === null
    ) {
      return { status: 'generation-not-ready' as const };
    }
    const applicable = await applicationApplicability(tx, connection, input.applicationId);
    if (applicable !== 'applicable') return { status: applicable };

    const [deployment] = await tx
      .select({
        deploymentId: inferenceDeployments.id,
        kaanaDeploymentId: inferenceDeployments.internalRouteId,
      })
      .from(inferenceDeployments)
      .where(
        and(
          eq(inferenceDeployments.id, input.deploymentId),
          eq(inferenceDeployments.providerSlug, connection.provider),
          eq(inferenceDeployments.availabilityScope, 'byok_only'),
          eq(inferenceDeployments.commercialPermission, 'customer_byok'),
          eq(inferenceDeployments.permissionState, 'approved'),
          inArray(inferenceDeployments.status, ['active', 'degraded']),
          isNotNull(inferenceDeployments.internalRouteId),
        ),
      )
      .limit(1);
    if (deployment?.kaanaDeploymentId === null || deployment === undefined) {
      return { status: 'deployment-unavailable' as const };
    }

    const [existing] = await tx
      .select()
      .from(inferenceProviderCredentialValidations)
      .where(
        and(
          eq(inferenceProviderCredentialValidations.connectionId, connection.id),
          eq(inferenceProviderCredentialValidations.credentialHandle, connection.credentialHandle),
          eq(
            inferenceProviderCredentialValidations.credentialRevision,
            connection.credentialRevision,
          ),
          eq(inferenceProviderCredentialValidations.state, 'pending'),
        ),
      )
      .limit(1)
      .for('update');

    let operation: InferenceProviderCredentialValidationRow;
    if (existing !== undefined) {
      if (
        existing.applicationId !== input.applicationId ||
        existing.deploymentId !== deployment.deploymentId ||
        existing.kaanaDeploymentId !== deployment.kaanaDeploymentId ||
        existing.provider !== connection.provider ||
        existing.ownerAccountId !== connection.ownerAccountId ||
        existing.environment !== connection.environment
      ) {
        return { status: 'operation-conflict' as const };
      }
      operation = existing;
    } else {
      [operation] = await tx
        .insert(inferenceProviderCredentialValidations)
        .values({
          id: uuidv7(),
          connectionId: connection.id,
          applicationId: input.applicationId,
          provider: connection.provider,
          ownerAccountId: connection.ownerAccountId,
          environment: connection.environment,
          credentialHandle: connection.credentialHandle,
          credentialRevision: connection.credentialRevision,
          deploymentId: deployment.deploymentId,
          kaanaDeploymentId: deployment.kaanaDeploymentId,
          state: 'pending',
        })
        .returning();
    }
    return { status: 'prepared' as const, operation };
  });

  if (prepared.status !== 'prepared') return prepared;
  const task = validationTask(prepared.operation);
  let dispatch: 'accepted' | 'retry_required' = 'accepted';
  try {
    await dispatcher.dispatch(task);
  } catch (error) {
    void error;
    dispatch = 'retry_required';
  }
  return {
    status: 'accepted',
    operation: validationOperation(prepared.operation),
    dispatch,
  };
}

export async function getLatestProviderCredentialValidation(input: {
  readonly connectionId: string;
  readonly applicationId: string;
}): Promise<ProviderCredentialValidationOperation | undefined> {
  const [row] = await getDb()
    .select()
    .from(inferenceProviderCredentialValidations)
    .where(
      and(
        eq(inferenceProviderCredentialValidations.connectionId, input.connectionId),
        eq(inferenceProviderCredentialValidations.applicationId, input.applicationId),
      ),
    )
    .orderBy(
      desc(inferenceProviderCredentialValidations.createdAt),
      desc(inferenceProviderCredentialValidations.id),
    )
    .limit(1);
  return row === undefined ? undefined : validationOperation(row);
}

/** Exact, terminal, idempotent Kaana callback. */
export async function recordProviderCredentialValidationOutcome(
  raw: KaanaCredentialValidationOutcome,
): Promise<RecordProviderCredentialValidationOutcomeResult> {
  const outcome = kaanaCredentialValidationOutcomeSchema.parse(raw);
  if (outcome.state === 'pending') return { status: 'pending-outcome' };

  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(inferenceProviderCredentialValidations)
      .where(eq(inferenceProviderCredentialValidations.id, outcome.operationId))
      .limit(1);
    if (candidate === undefined) return { status: 'unknown-operation' };
    // Lock in the same connection -> operation order used by start/resume so a
    // callback racing a retry cannot deadlock through reversed row locks.
    const connection = await lockConnectionRow(tx, candidate.connectionId);
    const [operation] = await tx
      .select()
      .from(inferenceProviderCredentialValidations)
      .where(eq(inferenceProviderCredentialValidations.id, outcome.operationId))
      .limit(1)
      .for('update');
    if (operation === undefined) return { status: 'unknown-operation' };
    if (!outcomeMatches(operation, outcome)) return { status: 'selector-mismatch' };
    if (operation.state !== 'pending') {
      return operation.state === outcome.state && operation.failureCode === (outcome.failureCode ?? null)
        ? { status: 'recorded', operation: validationOperation(operation) }
        : { status: 'outcome-conflict' };
    }

    const completedAt = new Date();
    const [stored] = await tx
      .update(inferenceProviderCredentialValidations)
      .set({
        state: outcome.state,
        failureCode: outcome.failureCode ?? null,
        completedAt,
      })
      .where(eq(inferenceProviderCredentialValidations.id, operation.id))
      .returning();

    if (
      connection === undefined ||
      connection.provider !== operation.provider ||
      connection.ownerAccountId !== operation.ownerAccountId ||
      connection.environment !== operation.environment ||
      connection.credentialHandle !== operation.credentialHandle ||
      connection.credentialRevision !== operation.credentialRevision
    ) {
      // The exact historical result is still durable and deduplicated, but it
      // cannot mutate a replacement generation. A later current-generation
      // operation has its own id and selectors.
      return { status: 'recorded', operation: validationOperation(stored) };
    }

    const next = connectionTransition(connection, outcome);
    await tx
      .update(inferenceProviderConnections)
      .set(next)
      .where(eq(inferenceProviderConnections.id, connection.id));

    await tx.insert(inferenceProviderConnectionAuditEvents).values({
      connectionId: connection.id,
      ownerAccountId: connection.ownerAccountId,
      eventType: 'validated',
      actorKind: 'platform',
      actorUserId: null,
      environment: connection.environment,
      metadata: {
        operationId: operation.id,
        applicationId: operation.applicationId,
        deploymentId: operation.deploymentId,
        validationState: outcome.state,
        failureCode: outcome.failureCode ?? null,
      },
    });
    if (outcome.state === 'invalid' && connection.status !== 'disabled') {
      await tx.insert(inferenceProviderConnectionAuditEvents).values({
        connectionId: connection.id,
        ownerAccountId: connection.ownerAccountId,
        eventType: 'disabled',
        actorKind: 'platform',
        actorUserId: null,
        environment: connection.environment,
        metadata: { operationId: operation.id, reason: 'invalid' },
      });
    }
    return { status: 'recorded', operation: validationOperation(stored) };
  });
}

function connectionTransition(
  connection: InferenceProviderConnectionRow,
  outcome: KaanaCredentialValidationOutcome,
): Partial<InferenceProviderConnectionRow> {
  if (outcome.state === 'valid') {
    return {
      validationState: 'valid',
      validationFailureCode: null,
      lastValidatedAt: new Date(),
      status: connection.status === 'pending_validation' ? 'active' : connection.status,
    };
  }
  if (outcome.state === 'invalid') {
    return {
      validationState: 'invalid',
      validationFailureCode: 'unauthorized',
      lastValidatedAt: new Date(),
      status: 'disabled',
    };
  }
  // Billing/quota/network outcomes say nothing adverse about the key. Preserve
  // an already-valid connection; an initial generation remains quarantined.
  return connection.validationState === 'valid'
    ? {}
    : { validationState: 'unvalidated', validationFailureCode: null };
}

function validationTask(
  row: InferenceProviderCredentialValidationRow,
): KaanaCredentialValidationTask {
  return kaanaCredentialValidationTaskSchema.parse({
    schemaVersion: 1,
    operationId: row.id,
    applicationId: row.applicationId,
    provider: row.provider,
    ownerAccountId: row.ownerAccountId,
    connectionId: row.connectionId,
    environment: row.environment,
    credentialHandle: row.credentialHandle,
    credentialRevision: row.credentialRevision,
    deploymentId: row.kaanaDeploymentId,
  });
}

function validationOperation(
  row: InferenceProviderCredentialValidationRow,
): ProviderCredentialValidationOperation {
  return providerCredentialValidationOperationSchema.parse({
    schemaVersion: 1,
    operationId: row.id,
    connectionId: row.connectionId,
    applicationId: row.applicationId,
    deploymentId: row.deploymentId,
    state: row.state,
    failureCode: row.failureCode ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  });
}

function outcomeMatches(
  row: InferenceProviderCredentialValidationRow,
  outcome: KaanaCredentialValidationOutcome,
): boolean {
  return (
    outcome.schemaVersion === 1 &&
    outcome.operationId === row.id &&
    outcome.applicationId === row.applicationId &&
    outcome.provider === row.provider &&
    outcome.ownerAccountId === row.ownerAccountId &&
    outcome.connectionId === row.connectionId &&
    outcome.environment === row.environment &&
    outcome.credentialHandle === row.credentialHandle &&
    outcome.credentialRevision === row.credentialRevision &&
    outcome.deploymentId === row.kaanaDeploymentId
  );
}

async function connectionRow(
  tx: Transaction,
  connectionId: string,
): Promise<InferenceProviderConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId))
    .limit(1);
  return row;
}

async function lockConnectionRow(
  tx: Transaction,
  connectionId: string,
): Promise<InferenceProviderConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId))
    .limit(1)
    .for('update');
  return row;
}

type ApplicationApplicability =
  | 'applicable'
  | 'application-unavailable'
  | 'application-not-applicable';

async function applicationApplicability(
  tx: Transaction,
  connection: InferenceProviderConnectionRow,
  applicationId: string,
): Promise<ApplicationApplicability> {
  const [application] = await tx
    .select({
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      ownerAccountStatus: users.accountStatus,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (
    application === undefined ||
    application.applicationStatus !== 'active' ||
    application.ownerAccountStatus !== 'active'
  ) {
    return 'application-unavailable';
  }
  if (connection.scopeKind === 'application') {
    return connection.applicationId === applicationId
      ? 'applicable'
      : 'application-not-applicable';
  }
  if (connection.scopeKind === 'project') {
    return connection.ownerAccountId === application.ownerAccountId
      ? 'applicable'
      : 'application-not-applicable';
  }
  const [ownership] = await tx
    .select({ ancestorId: userAncestors.ancestorId })
    .from(userAncestors)
    .where(
      and(
        eq(userAncestors.userId, application.ownerAccountId),
        eq(userAncestors.ancestorId, connection.ownerAccountId),
      ),
    )
    .limit(1);
  return connection.ownerAccountId === application.ownerAccountId || ownership !== undefined
    ? 'applicable'
    : 'application-not-applicable';
}
