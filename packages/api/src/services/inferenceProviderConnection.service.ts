/**
 * BYOK provider connections — the control plane (issue #972 workstream 10).
 *
 * Oxy holds the METADATA of a customer's own upstream provider credential and
 * never the credential. This module is the single writer of
 * `inference_provider_connections` and of its audit trail, and the single reader
 * of the scope precedence a routing decision resolves through.
 *
 * ## What it will not do
 *
 * It will not accept a credential when there is nowhere safe to put one. Every
 * entry point that has to hold plaintext takes a {@link ProviderSecretStore} as
 * an ARGUMENT rather than reaching for one, so the refusal happens in the route,
 * before the credential is read out of the request body — and so a test can
 * exercise the write path with a fake store without a test-only registration
 * hook existing in production code. No secret backend is wired in this
 * deployment; see `providerSecretStore.ts` for what would wire one.
 *
 * ## Validation, and where the provider call lives
 *
 * A credential can only be checked by whoever holds it. Oxy holds it for the
 * duration of one create or rotate request and never again — {@link ProviderSecretStore}
 * has no `get`, deliberately — so re-validation is performed by the data plane,
 * which resolves the reference to serve a request, and reported back through
 * {@link recordProviderConnectionValidation} as a verdict from a CLOSED set.
 * Nothing here logs, echoes or persists the credential, and the verdict carries
 * no free-form text a credential could be smuggled in.
 *
 * A reported `invalid` also DISABLES the connection, in the same transaction: a
 * credential the provider has rejected must stop serving, and leaving it active
 * would turn every subsequent request into a customer-visible upstream failure.
 * The database refuses `active` + `invalid` anyway, so this is the coherent
 * transition rather than a constraint failure.
 *
 * ## Routing preference is NOT re-modelled here
 *
 * `inference_routing_policy_versions.byok_preference` (workstream 6) is where a
 * customer says whether their own credentials may or must be used.
 * {@link resolveProviderConnectionForApplication} answers the other half —
 * whether there IS one — and returns a discriminated result so a `require`
 * policy with no live connection is a nameable outcome rather than a null the
 * caller may read as "fine, use Oxy's".
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  providerConnectionSchema,
  type ProviderConnection,
  type ProviderConnectionStatus,
} from '@oxyhq/contracts';
import { uuidv7 } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import {
  inferenceProviderConnectionAuditEvents,
  type ProviderConnectionActor,
  type ProviderConnectionActorKind,
  type ProviderConnectionAuditEventType,
} from '../db/schema/inferenceProviderConnectionAuditEvents';
import {
  inferenceProviderConnections,
  LIVE_PROVIDER_CONNECTION_STATUSES,
  type InferenceProviderConnectionRow,
  type ProviderConnectionEnvironment,
  type ProviderConnectionScopeKind,
  type ProviderConnectionValidationFailureCode,
  type ProviderConnectionValidationStateValue,
} from '../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../db/schema/inferenceProviders';
import { userAncestors } from '../db/schema/userAncestors';
import { logger } from '../utils/logger';
import {
  fingerprintProviderSecret,
  fingerprintsMatch,
  providerSecretReference,
  type ProviderSecretStore,
  type ProviderSecretValue,
} from './providerSecretStore';

/* -------------------------------------------------------------------------- */
/*  Serialization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A stored row as the contract describes it.
 *
 * Built field by field and then PARSED, never cast. The parse is what plants the
 * account-id brand, and it is also the structural guarantee this workstream
 * turns on: `providerConnectionSchema` is `.strict()` and declares no field a
 * credential could occupy, so a future edit that tried to attach one would fail
 * here rather than ship it. Nothing between the row and this function ever holds
 * a secret — the row does not contain one to leak.
 */
export function toProviderConnection(row: InferenceProviderConnectionRow): ProviderConnection {
  const scope =
    row.scopeKind === 'application' && row.applicationId !== null
      ? {
          kind: 'application' as const,
          accountId: row.ownerAccountId,
          applicationId: row.applicationId,
        }
      : { kind: row.scopeKind, accountId: row.ownerAccountId };

  return providerConnectionSchema.parse({
    schemaVersion: 1,
    connectionId: row.id,
    provider: row.provider,
    ownerAccountId: row.ownerAccountId,
    scope,
    environment: row.environment,
    status: row.status,
    secretRef: row.secretRef,
    keyPrefix: row.keyPrefix,
    fingerprint: row.fingerprint,
    validation: {
      state: row.validationState,
      lastValidatedAt: row.lastValidatedAt?.toISOString(),
      failureCode: row.validationFailureCode ?? undefined,
    },
    // Not a column: it is what BYOK MEANS, and a per-row flag could be written
    // false. The receipt side carries the other half as `platform_fee_only`.
    upstreamBillsCustomerDirectly: true,
    termsAcknowledgedAt: row.termsAcknowledgedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Detail an audit row may carry.
 *
 * Deliberately NOT `Record<string, unknown>`: every value is a primitive the
 * caller could already have read off the public DTO, so there is no parameter
 * shaped like a place to put a credential. The `metadata` column is the only
 * open surface on the audit table, and this type is what closes it.
 */
type AuditMetadataValue = string | number | boolean | null;

interface AuditEntry {
  readonly connectionId: string;
  readonly ownerAccountId: string;
  readonly environment: string;
  readonly eventType: ProviderConnectionAuditEventType;
  /**
   * Who acted. REQUIRED, and a discriminated union rather than an optional id:
   * "a member did this" and "an application's service credential did this" used
   * to land in one column and read identically (issue #972 workstream 12). A
   * writer that omits it now fails `tsc` rather than writing a row nobody can
   * attribute.
   */
  readonly actor: ProviderConnectionActor;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
}

/** The drizzle handle an audit write runs on — a transaction, in practice. */
type Writer = Pick<ReturnType<typeof getDb>, 'insert'>;

/**
 * Append one audit row on the caller's transaction.
 *
 * Takes the writer rather than reaching for `getDb()` so an event cannot land
 * without the mutation it describes, and does NOT catch: a failure here rolls
 * the whole transaction back. A connection whose creation was not recorded is a
 * credential reference nobody can account for.
 */
async function appendAuditEvent(writer: Writer, entry: AuditEntry): Promise<void> {
  await writer.insert(inferenceProviderConnectionAuditEvents).values({
    connectionId: entry.connectionId,
    ownerAccountId: entry.ownerAccountId,
    eventType: entry.eventType,
    actorKind: entry.actor.kind,
    // Only a `user` actor names a person. The other two kinds carry no id at
    // all, and the table's CHECK refuses one — see that file's "Who acted".
    actorUserId: entry.actor.kind === 'user' ? entry.actor.userId : null,
    environment: entry.environment,
    metadata: entry.metadata ?? {},
  });
}

/**
 * How long one instance suppresses a repeat `used` event for one connection.
 *
 * Same mechanism, and the same reasoning, as
 * `applicationCredentialAudit.service.ts`'s failure cooldown: a connection under
 * constant load would otherwise write one audit row per request, which is
 * metering rather than audit and is what `usage_receipts` already does. Sixty
 * seconds keeps the signal a customer wants — when this key started being used
 * and whether it still is — and turns unbounded volume into at most sixty rows
 * an hour per connection per instance.
 */
const USE_AUDIT_COOLDOWN_MS = 60_000;

/** Ceiling on the cooldown map; eviction costs an extra row, never a missed one. */
const USE_AUDIT_COOLDOWN_MAX_ENTRIES = 10_000;

const useAuditCooldown = new Map<string, number>();

/**
 * True when this instance has already recorded a `used` event for `connectionId`
 * inside the cooldown; otherwise records the suppression and returns false.
 *
 * Exported so the test that proves the cooldown is what bounds the table can
 * drive it, and so a test can reset shared module state rather than inheriting a
 * sibling case's.
 */
export function shouldSuppressUseAudit(connectionId: string, now: number = Date.now()): boolean {
  const until = useAuditCooldown.get(connectionId);
  if (until !== undefined && until > now) {
    return true;
  }

  if (useAuditCooldown.size >= USE_AUDIT_COOLDOWN_MAX_ENTRIES) {
    for (const [key, expiry] of useAuditCooldown) {
      if (expiry <= now) useAuditCooldown.delete(key);
    }
    if (useAuditCooldown.size >= USE_AUDIT_COOLDOWN_MAX_ENTRIES) {
      const oldest = useAuditCooldown.keys().next();
      if (!oldest.done) useAuditCooldown.delete(oldest.value);
    }
  }

  useAuditCooldown.set(connectionId, now + USE_AUDIT_COOLDOWN_MS);
  return false;
}

/** Clear the cooldown. Tests only — production has no reason to forget. */
export function resetUseAuditCooldown(): void {
  useAuditCooldown.clear();
}

/**
 * Record that a connection's reference was handed out for serving.
 *
 * Best-effort and cooldown-bounded: this runs on the resolution path, where a
 * database hiccup must not turn a servable request into a failure. Returns
 * whether a row was written so "suppressed" and "failed" stay distinguishable.
 */
export async function recordProviderConnectionUse(
  row: Pick<InferenceProviderConnectionRow, 'id' | 'ownerAccountId' | 'environment'>
): Promise<boolean> {
  if (shouldSuppressUseAudit(row.id)) return false;

  try {
    await appendAuditEvent(getDb(), {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: 'used',
      // No principal at all: this is the data plane resolving a reference. The
      // table's CHECK refuses a named person here anyway.
      actor: { kind: 'platform' },
    });
    return true;
  } catch (error) {
    logger.error(
      'Failed to record provider connection use',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'inferenceProviderConnection', connectionId: row.id }
    );
    return false;
  }
}

/**
 * Every audit event for one connection, newest first.
 *
 * `id` is a secondary sort so the ORDER of a page is stable across reads, not
 * because it means anything: two events written in one transaction share an
 * instant (`now()` is the transaction's start time) and uuid v7 is not monotone
 * within a millisecond, so their RELATIVE order is arbitrary and a caller must
 * not read it as a sequence. A monotonic column would make it defined and is
 * deliberately not added — the pairs written together (`validated` + the
 * automatic `disabled`, for one) describe one event, and inventing an order
 * between them would suggest a causality the trail cannot support.
 */
export async function listProviderConnectionAuditEvents(
  connectionId: string,
  limit: number
): Promise<
  readonly {
    eventType: ProviderConnectionAuditEventType;
    actorKind: ProviderConnectionActorKind | null;
    actorUserId: string | null;
    environment: string;
    metadata: unknown;
    createdAt: string;
  }[]
> {
  const rows = await getDb()
    .select({
      eventType: inferenceProviderConnectionAuditEvents.eventType,
      actorKind: inferenceProviderConnectionAuditEvents.actorKind,
      actorUserId: inferenceProviderConnectionAuditEvents.actorUserId,
      environment: inferenceProviderConnectionAuditEvents.environment,
      metadata: inferenceProviderConnectionAuditEvents.metadata,
      createdAt: inferenceProviderConnectionAuditEvents.createdAt,
    })
    .from(inferenceProviderConnectionAuditEvents)
    .where(eq(inferenceProviderConnectionAuditEvents.connectionId, connectionId))
    .orderBy(
      desc(inferenceProviderConnectionAuditEvents.createdAt),
      desc(inferenceProviderConnectionAuditEvents.id)
    )
    .limit(limit);

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** One connection, or `undefined`. Never filtered — the caller authorises. */
export async function getProviderConnectionRow(
  connectionId: string
): Promise<InferenceProviderConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId))
    .limit(1);
  return row;
}

/** Every connection an account owns, newest first. */
export async function listProviderConnectionsForAccount(
  accountId: string
): Promise<readonly ProviderConnection[]> {
  const rows = await getDb()
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.ownerAccountId, accountId))
    .orderBy(desc(inferenceProviderConnections.createdAt));
  return rows.map(toProviderConnection);
}

/** Where an effective connection came from — the question a customer asks. */
export type ProviderConnectionSource = 'application' | 'project' | 'account' | 'ancestor-account';

/**
 * The outcome of resolving BYOK for one application.
 *
 * `none` is a first-class arm rather than `undefined`, because the caller acting
 * on it is a routing decision under `byok_preference`: `require` with `none` must
 * refuse the request, and a nullable return is exactly the value somebody reads
 * as "fine, serve it from Oxy's own account instead".
 */
export type ProviderConnectionResolution =
  | {
      readonly status: 'resolved';
      readonly connection: ProviderConnection;
      readonly row: InferenceProviderConnectionRow;
      readonly source: ProviderConnectionSource;
    }
  | { readonly status: 'none' }
  | { readonly status: 'unknown-application'; readonly applicationId: string };

/**
 * The connection in force for an application, provider and environment.
 *
 * Precedence, most specific first: this application's own, then the owning
 * account's project-scoped one, then its account-scoped one, then the nearest
 * ANCESTOR account's — `user_ancestors` stores the path root-first, so "nearest"
 * is the highest `depth`. That ordering is what makes the contract's
 * `account`-vs-`project` distinction mean something: an `account` connection is
 * inherited by descendants, a `project` one is not.
 *
 * Only LIVE statuses qualify. A revoked or disabled connection is not a
 * fallback — a disable that silently promoted the next one up the tree would
 * defeat the point of disabling it.
 */
export async function resolveProviderConnectionForApplication(input: {
  readonly applicationId: string;
  readonly provider: string;
  readonly environment: ProviderConnectionEnvironment;
}): Promise<ProviderConnectionResolution> {
  const db = getDb();

  const [application] = await db
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applications)
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (application === undefined) {
    return { status: 'unknown-application', applicationId: input.applicationId };
  }

  const live = inArray(inferenceProviderConnections.status, [...LIVE_PROVIDER_CONNECTION_STATUSES]);
  const matches = and(
    eq(inferenceProviderConnections.provider, input.provider),
    eq(inferenceProviderConnections.environment, input.environment),
    live
  );

  const [own] = await db
    .select()
    .from(inferenceProviderConnections)
    .where(and(matches, eq(inferenceProviderConnections.applicationId, input.applicationId)))
    .limit(1);
  if (own !== undefined) {
    return { status: 'resolved', connection: toProviderConnection(own), row: own, source: 'application' };
  }

  const accountScoped = await db
    .select()
    .from(inferenceProviderConnections)
    .where(
      and(
        matches,
        eq(inferenceProviderConnections.ownerAccountId, application.ownerAccountId),
        isNull(inferenceProviderConnections.applicationId)
      )
    );

  // `project` beats `account` on the same account: it is the more specific of the
  // two, and the live-scope index guarantees at most one of each.
  const project = accountScoped.find((row) => row.scopeKind === 'project');
  if (project !== undefined) {
    return {
      status: 'resolved',
      connection: toProviderConnection(project),
      row: project,
      source: 'project',
    };
  }
  const account = accountScoped.find((row) => row.scopeKind === 'account');
  if (account !== undefined) {
    return {
      status: 'resolved',
      connection: toProviderConnection(account),
      row: account,
      source: 'account',
    };
  }

  // Inheritance: only `account`-scoped connections travel down the tree.
  const inherited = await db
    .select({ connection: inferenceProviderConnections })
    .from(userAncestors)
    .innerJoin(
      inferenceProviderConnections,
      eq(inferenceProviderConnections.ownerAccountId, userAncestors.ancestorId)
    )
    .where(
      and(
        eq(userAncestors.userId, application.ownerAccountId),
        matches,
        eq(inferenceProviderConnections.scopeKind, 'account'),
        isNull(inferenceProviderConnections.applicationId)
      )
    )
    .orderBy(desc(userAncestors.depth))
    .limit(1);

  const nearest = inherited[0]?.connection;
  if (nearest !== undefined) {
    return {
      status: 'resolved',
      connection: toProviderConnection(nearest),
      row: nearest,
      source: 'ancestor-account',
    };
  }

  return { status: 'none' };
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

/** What a caller states when registering a connection. */
export interface CreateProviderConnectionInput {
  readonly provider: string;
  readonly ownerAccountId: string;
  readonly scopeKind: ProviderConnectionScopeKind;
  /** Required when `scopeKind` is `application`, refused otherwise. */
  readonly applicationId?: string;
  readonly environment: ProviderConnectionEnvironment;
  readonly secret: ProviderSecretValue;
  /** The customer's acknowledgement of the provider's own BYOK terms. */
  readonly acknowledgeProviderTerms: boolean;
  readonly actor: ProviderConnectionActor;
}

/**
 * Outcomes of a create.
 *
 * Every refusal names itself. A caller has to decide between "the provider does
 * not exist", "you have not accepted their terms" and "you already have one",
 * and a boolean or a thrown `Error` would flatten three different customer
 * sentences into one.
 */
export type CreateProviderConnectionResult =
  | { readonly status: 'created'; readonly connection: ProviderConnection }
  | { readonly status: 'unknown-provider'; readonly provider: string }
  | {
      readonly status: 'terms-not-acknowledged';
      readonly provider: string;
      readonly termsUrl: string | null;
    }
  | { readonly status: 'scope-taken' }
  | { readonly status: 'scope-mismatch' };

/**
 * Register a connection: write the credential to the store, keep the reference.
 *
 * `store` is a parameter, not a lookup. The route resolves it FIRST and refuses
 * before reading the credential out of the request when none is configured, so
 * an unconfigured deployment never holds a customer secret at all — not for the
 * duration of a handler, not in a stack trace.
 *
 * ## Ordering, and which failure is survivable
 *
 * The row is inserted first, inside the transaction, and the store write happens
 * before the commit. A store failure therefore rolls the row back, and the
 * common failure — a constraint violation, a taken scope — never reaches the
 * store at all, so nothing is written anywhere. The residual hazard is a commit
 * that fails after a successful `put`, which leaves a secret in the store with
 * no row naming it; the catch below destroys it best-effort and logs if it
 * cannot, because an orphaned secret is the one outcome nobody can find later.
 *
 * The reverse order has the same residual hazard and adds a worse common case,
 * so this is the better of two imperfect orderings rather than a perfect one.
 */
export async function createProviderConnection(
  input: CreateProviderConnectionInput,
  store: ProviderSecretStore
): Promise<CreateProviderConnectionResult> {
  if ((input.scopeKind === 'application') !== (input.applicationId !== undefined)) {
    return { status: 'scope-mismatch' };
  }

  const [provider] = await getDb()
    .select({
      slug: inferenceProviders.slug,
      termsRequired: inferenceProviders.byokTermsAcknowledgementRequired,
      termsUrl: inferenceProviders.byokTermsUrl,
    })
    .from(inferenceProviders)
    .where(eq(inferenceProviders.slug, input.provider))
    .limit(1);
  if (provider === undefined) {
    return { status: 'unknown-provider', provider: input.provider };
  }
  if (provider.termsRequired && !input.acknowledgeProviderTerms) {
    return {
      status: 'terms-not-acknowledged',
      provider: provider.slug,
      termsUrl: provider.termsUrl,
    };
  }

  // Minted here rather than by the column default, because the secret reference
  // has to contain it — that is what the partition CHECK enforces, and a
  // database-side default would only be known after the insert.
  const connectionId = uuidv7();
  const secretRef = providerSecretReference(store.name, {
    environment: input.environment,
    ownerAccountId: input.ownerAccountId,
    connectionId,
  });

  let secretWritten = false;
  try {
    const connection = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(inferenceProviderConnections)
        .values({
          id: connectionId,
          provider: provider.slug,
          ownerAccountId: input.ownerAccountId,
          scopeKind: input.scopeKind,
          applicationId: input.applicationId ?? null,
          environment: input.environment,
          // Never `active` on create: nothing has checked the credential yet, and
          // a connection that claims to work before anyone asked the provider is
          // the state a customer debugs for an hour.
          status: 'pending_validation',
          secretRef,
          keyPrefix: input.secret.prefix(),
          fingerprint: fingerprintProviderSecret(input.secret),
          validationState: 'unvalidated',
          termsAcknowledgedAt: provider.termsRequired ? new Date() : null,
          providerTermsAcknowledgementRequired: provider.termsRequired,
        })
        .returning();

      await store.put(secretRef, input.secret);
      secretWritten = true;

      await appendAuditEvent(tx, {
        connectionId: row.id,
        ownerAccountId: row.ownerAccountId,
        environment: row.environment,
        eventType: 'created',
        actor: input.actor,
        metadata: {
          provider: row.provider,
          scopeKind: row.scopeKind,
          keyPrefix: row.keyPrefix,
          secretStore: store.name,
          termsAcknowledged: provider.termsRequired,
        },
      });

      return toProviderConnection(row);
    });

    return { status: 'created', connection };
  } catch (error) {
    if (secretWritten) {
      await destroySecretBestEffort(store, secretRef, connectionId);
    }
    if (isLiveScopeCollision(error)) {
      return { status: 'scope-taken' };
    }
    throw error;
  }
}

/** Outcomes of a rotation. */
export type RotateProviderConnectionResult =
  | { readonly status: 'rotated'; readonly connection: ProviderConnection }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'revoked' }
  | { readonly status: 'unchanged-credential' };

/**
 * Replace the credential behind a connection.
 *
 * The REFERENCE does not change — it is pinned to the connection's environment,
 * owner and id by the partition CHECK, none of which a rotation touches — so a
 * data plane holding the reference keeps working and the old credential is gone
 * the instant the store write lands. That is replacement, which is what a
 * customer rotating a leaked key needs; a new reference would leave the old
 * secret in the store with nothing pointing at it.
 *
 * `status` is deliberately NOT reset. A rotation is not a suspension: taking a
 * working connection out of service because its key was replaced would make
 * rotation something customers avoid. `validation` IS reset to `unvalidated`,
 * because the previous verdict was about a credential that no longer exists.
 */
export async function rotateProviderConnection(
  input: {
    readonly connectionId: string;
    readonly secret: ProviderSecretValue;
    readonly actor: ProviderConnectionActor;
  },
  store: ProviderSecretStore
): Promise<RotateProviderConnectionResult> {
  const existing = await getProviderConnectionRow(input.connectionId);
  if (existing === undefined) return { status: 'unknown-connection' };
  if (existing.status === 'revoked') return { status: 'revoked' };

  const fingerprint = fingerprintProviderSecret(input.secret);
  if (fingerprintsMatch(fingerprint, existing.fingerprint)) {
    // A rotation that changes nothing would still emit a `rotated` audit row and
    // a new `rotated_at`, which is an audit trail asserting something that did
    // not happen.
    return { status: 'unchanged-credential' };
  }

  const connection = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({
        keyPrefix: input.secret.prefix(),
        fingerprint,
        validationState: 'unvalidated',
        validationFailureCode: null,
        rotatedAt: new Date(),
      })
      .where(eq(inferenceProviderConnections.id, input.connectionId))
      .returning();

    await store.put(existing.secretRef, input.secret);

    await appendAuditEvent(tx, {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: 'rotated',
      actor: input.actor,
      metadata: {
        // Both already appear in the public DTO: a SHA-256 of a credential is
        // not the credential, and a 12-character prefix cannot be one.
        previousFingerprint: existing.fingerprint,
        previousKeyPrefix: existing.keyPrefix,
        keyPrefix: row.keyPrefix,
      },
    });

    return toProviderConnection(row);
  });

  return { status: 'rotated', connection };
}

/** Outcomes of a lifecycle transition that touches no credential. */
export type ProviderConnectionStatusResult =
  | { readonly status: 'updated'; readonly connection: ProviderConnection }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'revoked' }
  | { readonly status: 'already'; readonly current: ProviderConnectionStatus };

/**
 * Take a connection out of service immediately.
 *
 * Pure database work — no store round trip — because "immediate" has to mean
 * immediate, and a disable that waited on an external service would be at the
 * mercy of the thing the customer is trying to stop using. Reversible: the
 * credential still exists, which is the difference from a revoke.
 */
export async function disableProviderConnection(input: {
  readonly connectionId: string;
  readonly actor: ProviderConnectionActor;
}): Promise<ProviderConnectionStatusResult> {
  return transitionStatus({
    connectionId: input.connectionId,
    actor: input.actor,
    eventType: 'disabled',
    next: () => 'disabled',
    refuseWhen: (row) => (row.status === 'disabled' ? 'disabled' : undefined),
  });
}

/**
 * Put a disabled connection back into service.
 *
 * Back to `active` only when the last verdict was `valid`; otherwise to
 * `pending_validation`, because re-enabling is not evidence that the credential
 * works and `active` is a claim the database refuses to hold beside an `invalid`
 * verdict anyway.
 */
export async function enableProviderConnection(input: {
  readonly connectionId: string;
  readonly actor: ProviderConnectionActor;
}): Promise<ProviderConnectionStatusResult> {
  return transitionStatus({
    connectionId: input.connectionId,
    actor: input.actor,
    eventType: 'enabled',
    next: (row) => (row.validationState === 'valid' ? 'active' : 'pending_validation'),
    refuseWhen: (row) => (row.status === 'disabled' ? undefined : row.status),
  });
}

async function transitionStatus(input: {
  readonly connectionId: string;
  readonly actor: ProviderConnectionActor;
  readonly eventType: Extract<ProviderConnectionAuditEventType, 'disabled' | 'enabled'>;
  readonly next: (row: InferenceProviderConnectionRow) => ProviderConnectionStatus;
  readonly refuseWhen: (row: InferenceProviderConnectionRow) => ProviderConnectionStatus | undefined;
}): Promise<ProviderConnectionStatusResult> {
  const existing = await getProviderConnectionRow(input.connectionId);
  if (existing === undefined) return { status: 'unknown-connection' };
  if (existing.status === 'revoked') return { status: 'revoked' };

  const refusal = input.refuseWhen(existing);
  if (refusal !== undefined) return { status: 'already', current: refusal };

  const next = input.next(existing);
  const connection = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({ status: next })
      .where(eq(inferenceProviderConnections.id, input.connectionId))
      .returning();

    await appendAuditEvent(tx, {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: input.eventType,
      actor: input.actor,
      metadata: { previousStatus: existing.status, status: row.status },
    });

    return toProviderConnection(row);
  });

  return { status: 'updated', connection };
}

/** Outcomes of a revoke. */
export type RevokeProviderConnectionResult =
  | {
      readonly status: 'revoked';
      readonly connection: ProviderConnection;
      readonly secretDestroyed: boolean;
    }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'already-revoked' };

/**
 * Retire a connection permanently and destroy the credential behind it.
 *
 * ## Destroy FIRST, then record — and never let the destroy block the record
 *
 * The credential is destroyed before the status write, so a process that dies
 * between the two leaves the secret gone and the row stale, rather than the row
 * revoked and the secret still live in the store. Of the two crash states, the
 * first cannot serve anything and the second is a credential nobody is tracking.
 *
 * A destroy FAILURE does not stop the revoke. Retiring a connection is a safety
 * operation, often performed because the key leaked, and refusing to record it
 * because a store call timed out would leave the connection resolvable. The
 * outcome is recorded in the audit row and returned, so a failed destruction is
 * visible and actionable rather than assumed.
 *
 * `store` is optional: a deployment whose secret backend has since been
 * unconfigured must still be able to revoke. The audit row then says the secret
 * was not destroyed, which is the true statement.
 */
export async function revokeProviderConnection(
  input: { readonly connectionId: string; readonly actor: ProviderConnectionActor },
  store?: ProviderSecretStore
): Promise<RevokeProviderConnectionResult> {
  const existing = await getProviderConnectionRow(input.connectionId);
  if (existing === undefined) return { status: 'unknown-connection' };
  if (existing.status === 'revoked') return { status: 'already-revoked' };

  const secretDestroyed =
    store === undefined
      ? false
      : await destroySecretBestEffort(store, existing.secretRef, existing.id);

  const connection = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({ status: 'revoked' })
      .where(eq(inferenceProviderConnections.id, input.connectionId))
      .returning();

    await appendAuditEvent(tx, {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: 'revoked',
      actor: input.actor,
      metadata: {
        previousStatus: existing.status,
        secretDestroyed,
        secretStore: store?.name ?? null,
      },
    });

    return toProviderConnection(row);
  });

  return { status: 'revoked', connection, secretDestroyed };
}

/** Outcomes of recording a validation verdict. */
export type RecordValidationResult =
  | { readonly status: 'recorded'; readonly connection: ProviderConnection }
  | { readonly status: 'unknown-connection' }
  | { readonly status: 'revoked' };

/**
 * Record the verdict of a credential check.
 *
 * The check itself is performed where the credential is — the data plane, which
 * resolves the reference to serve a request. This module never fetches a secret
 * back to check it, which is why {@link ProviderSecretStore} has no `get`.
 *
 * An `invalid` verdict also DISABLES the connection, in the same transaction and
 * with its own audit row. Two rows rather than one, because two things happened
 * and an audit trail that merges them cannot answer "was it disabled because the
 * key failed, or did someone disable it".
 */
export async function recordProviderConnectionValidation(input: {
  readonly connectionId: string;
  readonly state: ProviderConnectionValidationStateValue;
  readonly failureCode?: ProviderConnectionValidationFailureCode;
  /**
   * Who asked for the check. `{kind:'platform'}` when the data plane reported the
   * verdict itself, which is a different fact from a member requesting one and is
   * now recorded as one.
   */
  readonly actor: ProviderConnectionActor;
}): Promise<RecordValidationResult> {
  const existing = await getProviderConnectionRow(input.connectionId);
  if (existing === undefined) return { status: 'unknown-connection' };
  if (existing.status === 'revoked') return { status: 'revoked' };

  const rejected = input.state === 'invalid' || input.state === 'expired';
  const nextStatus: ProviderConnectionStatus = rejected
    ? 'disabled'
    : input.state === 'valid' && existing.status === 'pending_validation'
      ? 'active'
      : existing.status;

  const connection = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({
        validationState: input.state,
        validationFailureCode: input.state === 'invalid' ? (input.failureCode ?? 'unknown') : null,
        lastValidatedAt: new Date(),
        status: nextStatus,
      })
      .where(eq(inferenceProviderConnections.id, input.connectionId))
      .returning();

    await appendAuditEvent(tx, {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: 'validated',
      actor: input.actor,
      metadata: {
        validationState: row.validationState,
        failureCode: row.validationFailureCode,
      },
    });

    if (rejected && existing.status !== 'disabled') {
      await appendAuditEvent(tx, {
        connectionId: row.id,
        ownerAccountId: row.ownerAccountId,
        environment: row.environment,
        eventType: 'disabled',
        // Nobody disabled it: the provider's answer did. Naming a person here
        // would be an accusation, so the actor is Oxy's own machinery.
        actor: { kind: 'platform' },
        metadata: { previousStatus: existing.status, reason: input.state },
      });
    }

    return toProviderConnection(row);
  });

  return { status: 'recorded', connection };
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Destroy a stored secret without letting the failure propagate.
 *
 * Both callers have already decided that the metadata write matters more than
 * the store call succeeding — a rolled-back create must not fail twice, and a
 * revoke must never be blocked. The failure is LOGGED and RETURNED rather than
 * swallowed: an orphaned or surviving secret is the one outcome that needs a
 * human, so it must be visible in both the log and the audit row.
 */
async function destroySecretBestEffort(
  store: ProviderSecretStore,
  secretRef: string,
  connectionId: string
): Promise<boolean> {
  try {
    await store.destroy(secretRef);
    return true;
  } catch (error) {
    logger.error(
      'Failed to destroy a provider secret; it may remain in the secret store',
      error instanceof Error ? error : new Error(String(error)),
      {
        component: 'inferenceProviderConnection',
        connectionId,
        secretStore: store.name,
      }
    );
    return false;
  }
}

/**
 * Whether a write failed because the scope already holds a live connection.
 *
 * Matched on the CONSTRAINT NAME, never on the message: the message is
 * Postgres's to change and a string match on it is a check that silently stops
 * working. `cause` rather than `error.code` — a drizzle error carries the
 * SQLSTATE on its cause, and a ported `err.code === '23505'` matches nothing.
 */
function isLiveScopeCollision(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause === null || typeof cause !== 'object') return false;
  const detail = cause as { code?: unknown; constraint_name?: unknown };
  return (
    detail.code === '23505' &&
    detail.constraint_name === 'inference_provider_connections_live_scope_key'
  );
}
