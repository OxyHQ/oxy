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
 * entry point that briefly handles plaintext takes a {@link KaanaCredentialControl}
 * as an argument. The route resolves that signed client before parsing the
 * credential body; absent or partial configuration refuses the request.
 *
 * ## Validation, and where the provider call lives
 *
 * A credential can only be checked by whoever holds it. Oxy holds it for the
 * duration of one signed create or rotate request and never again. Re-validation
 * is performed by the data plane,
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

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  kaanaCredentialOutcomeRequestSchema,
  providerConnectionSchema,
  type KaanaCredentialOutcome,
  type KaanaCredentialOutcomeRequest,
  type ProviderConnection,
  type ProviderConnectionStatus,
} from "@oxyhq/contracts";
import { uuidv7 } from "@oxyhq/db";
import { getDb, type Transaction } from "../config/postgres";
import { applications } from "../db/schema/applications";
import {
  inferenceProviderConnectionAuditEvents,
  type ProviderConnectionActor,
  type ProviderConnectionActorKind,
  type ProviderConnectionAuditEventType,
} from "../db/schema/inferenceProviderConnectionAuditEvents";
import {
  inferenceProviderConnections,
  type InferenceProviderConnectionRow,
  type ProviderConnectionEnvironment,
  type ProviderConnectionScopeKind,
  type ProviderConnectionValidationFailureCode,
  type ProviderConnectionValidationStateValue,
} from "../db/schema/inferenceProviderConnections";
import {
  inferenceProviderCredentialOperations,
  type InferenceProviderCredentialOperationRow,
  type ProviderCredentialOperationState,
} from "../db/schema/inferenceProviderCredentialOperations";
import { inferenceProviders } from "../db/schema/inferenceProviders";
import { userAncestors } from "../db/schema/userAncestors";
import { users } from "../db/schema/users";
import { accountClosureFences } from "../db/schema/accountClosureFences";
import { logger } from "../utils/logger";
import {
  KaanaCredentialConflictError,
  KaanaCredentialOutcomeNotFoundError,
  type KaanaCredentialControl,
  type ProviderCredentialValue,
} from "./kaanaCredentialControl";

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
export function toProviderConnection(
  row: InferenceProviderConnectionRow,
): ProviderConnection {
  const scope =
    row.scopeKind === "application" && row.applicationId !== null
      ? {
          kind: "application" as const,
          accountId: row.ownerAccountId,
          applicationId: row.applicationId,
        }
      : { kind: row.scopeKind, accountId: row.ownerAccountId };

  return providerConnectionSchema.parse({
    schemaVersion: 2,
    connectionId: row.id,
    provider: row.provider,
    ownerAccountId: row.ownerAccountId,
    scope,
    environment: row.environment,
    status: row.status,
    custodyState: row.custodyState,
    credentialHandle: row.credentialHandle ?? undefined,
    credentialRevision: row.credentialRevision ?? undefined,
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
type Writer = Pick<ReturnType<typeof getDb>, "insert">;

/**
 * Append one audit row on the caller's transaction.
 *
 * Takes the writer rather than reaching for `getDb()` so an event cannot land
 * without the mutation it describes, and does NOT catch: a failure here rolls
 * the whole transaction back. A connection whose creation was not recorded is a
 * credential reference nobody can account for.
 */
async function appendAuditEvent(
  writer: Writer,
  entry: AuditEntry,
): Promise<void> {
  await writer.insert(inferenceProviderConnectionAuditEvents).values({
    connectionId: entry.connectionId,
    ownerAccountId: entry.ownerAccountId,
    eventType: entry.eventType,
    actorKind: entry.actor.kind,
    // Only a `user` actor names a person. The other two kinds carry no id at
    // all, and the table's CHECK refuses one — see that file's "Who acted".
    actorUserId: entry.actor.kind === "user" ? entry.actor.userId : null,
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
export function shouldSuppressUseAudit(
  connectionId: string,
  now: number = Date.now(),
): boolean {
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
  row: Pick<
    InferenceProviderConnectionRow,
    "id" | "ownerAccountId" | "environment"
  >,
): Promise<boolean> {
  if (shouldSuppressUseAudit(row.id)) return false;

  try {
    await appendAuditEvent(getDb(), {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: "used",
      // No principal at all: this is the data plane resolving a reference. The
      // table's CHECK refuses a named person here anyway.
      actor: { kind: "platform" },
    });
    return true;
  } catch (error) {
    logger.error(
      "Failed to record provider connection use",
      error instanceof Error ? error : new Error(String(error)),
      { component: "inferenceProviderConnection", connectionId: row.id },
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
  limit: number,
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
    .where(
      eq(inferenceProviderConnectionAuditEvents.connectionId, connectionId),
    )
    .orderBy(
      desc(inferenceProviderConnectionAuditEvents.createdAt),
      desc(inferenceProviderConnectionAuditEvents.id),
    )
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** One connection, or `undefined`. Never filtered — the caller authorises. */
export async function getProviderConnectionRow(
  connectionId: string,
): Promise<InferenceProviderConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId))
    .limit(1);
  return row;
}

/** Serialize lifecycle writers on one connection before deriving their transition. */
async function lockProviderConnectionRow(
  tx: Transaction,
  connectionId: string,
): Promise<InferenceProviderConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(inferenceProviderConnections)
    .where(eq(inferenceProviderConnections.id, connectionId))
    .limit(1)
    .for("update");
  return row;
}

/** Every connection an account owns, newest first. */
export async function listProviderConnectionsForAccount(
  accountId: string,
  serviceBoundary?: {
    readonly applicationId: string;
    readonly environment: ProviderConnectionEnvironment;
  },
): Promise<readonly ProviderConnection[]> {
  const rows = await getDb()
    .select()
    .from(inferenceProviderConnections)
    .where(
      serviceBoundary === undefined
        ? eq(inferenceProviderConnections.ownerAccountId, accountId)
        : and(
            eq(inferenceProviderConnections.ownerAccountId, accountId),
            eq(
              inferenceProviderConnections.environment,
              serviceBoundary.environment,
            ),
            or(
              isNull(inferenceProviderConnections.applicationId),
              eq(
                inferenceProviderConnections.applicationId,
                serviceBoundary.applicationId,
              ),
            ),
          ),
    )
    .orderBy(desc(inferenceProviderConnections.createdAt));
  return rows.map(toProviderConnection);
}

/** Where an effective connection came from — the question a customer asks. */
export type ProviderConnectionSource =
  "application" | "project" | "account" | "ancestor-account";

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
      readonly status: "resolved";
      readonly connection: ProviderConnection;
      readonly row: InferenceProviderConnectionRow;
      readonly source: ProviderConnectionSource;
    }
  | { readonly status: "none" }
  | { readonly status: "unknown-application"; readonly applicationId: string };

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
 * Only `active + valid + custody ready` qualifies for serving. The signed route
 * binding does not carry a bootstrap purpose, so exposing an unvalidated
 * generation here would let normal inference consume it. Initial validation
 * therefore remains fail-closed until Kaana and Oxy expose a dedicated,
 * authenticated bootstrap mechanism.
 *
 * A pending, revoked, disabled, invalid, expired or custody-uncertain connection
 * is not a fallback — silently promoting the next one up the tree would defeat
 * both operator intent and validation quarantine.
 */
export async function resolveProviderConnectionForApplication(input: {
  readonly applicationId: string;
  readonly provider: string;
  readonly environment: ProviderConnectionEnvironment;
}): Promise<ProviderConnectionResolution> {
  const db = getDb();

  const [application] = await db
    .select({
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      ownerAccountStatus: users.accountStatus,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (
    application === undefined ||
    application.applicationStatus !== "active" ||
    application.ownerAccountStatus !== "active"
  ) {
    return {
      status: "unknown-application",
      applicationId: input.applicationId,
    };
  }

  const candidateMatches = and(
    eq(inferenceProviderConnections.provider, input.provider),
    eq(inferenceProviderConnections.environment, input.environment),
    ne(inferenceProviderConnections.status, "revoked"),
  );

  const resolveCandidate = (
    row: InferenceProviderConnectionRow | undefined,
    source: ProviderConnectionSource,
  ): ProviderConnectionResolution | undefined => {
    if (row === undefined) return undefined;
    if (
      row.custodyState !== "ready" ||
      row.status !== "active" ||
      row.validationState !== "valid"
    ) {
      // A more-specific override exists but it is disabled, rejected, expired,
      // internally inconsistent, or its custody is uncertain. It shadows
      // broader scopes fail-closed; silently promoting a parent key would defeat
      // validation and quarantine.
      return { status: "none" };
    }
    return {
      status: "resolved",
      connection: toProviderConnection(row),
      row,
      source,
    };
  };

  const [own] = await db
    .select()
    .from(inferenceProviderConnections)
    .where(
      and(
        candidateMatches,
        eq(inferenceProviderConnections.applicationId, input.applicationId),
      ),
    )
    .orderBy(
      desc(inferenceProviderConnections.createdAt),
      asc(inferenceProviderConnections.id),
    )
    .limit(1);
  const ownResolution = resolveCandidate(own, "application");
  if (ownResolution !== undefined) return ownResolution;

  const [project] = await db
    .select()
    .from(inferenceProviderConnections)
    .where(
      and(
        candidateMatches,
        eq(
          inferenceProviderConnections.ownerAccountId,
          application.ownerAccountId,
        ),
        eq(inferenceProviderConnections.scopeKind, "project"),
        isNull(inferenceProviderConnections.applicationId),
      ),
    )
    .orderBy(
      desc(inferenceProviderConnections.createdAt),
      asc(inferenceProviderConnections.id),
    )
    .limit(1);
  const projectResolution = resolveCandidate(project, "project");
  if (projectResolution !== undefined) return projectResolution;

  const [account] = await db
    .select()
    .from(inferenceProviderConnections)
    .where(
      and(
        candidateMatches,
        eq(
          inferenceProviderConnections.ownerAccountId,
          application.ownerAccountId,
        ),
        eq(inferenceProviderConnections.scopeKind, "account"),
        isNull(inferenceProviderConnections.applicationId),
      ),
    )
    .orderBy(
      desc(inferenceProviderConnections.createdAt),
      asc(inferenceProviderConnections.id),
    )
    .limit(1);
  const accountResolution = resolveCandidate(account, "account");
  if (accountResolution !== undefined) return accountResolution;

  // Inheritance: only `account`-scoped connections travel down the tree.
  const inherited = await db
    .select({ connection: inferenceProviderConnections })
    .from(userAncestors)
    .innerJoin(
      inferenceProviderConnections,
      eq(inferenceProviderConnections.ownerAccountId, userAncestors.ancestorId),
    )
    .where(
      and(
        eq(userAncestors.userId, application.ownerAccountId),
        candidateMatches,
        eq(inferenceProviderConnections.scopeKind, "account"),
        isNull(inferenceProviderConnections.applicationId),
      ),
    )
    .orderBy(
      desc(userAncestors.depth),
      desc(inferenceProviderConnections.createdAt),
      asc(inferenceProviderConnections.id),
    )
    .limit(1);

  const nearest = inherited[0]?.connection;
  const inheritedResolution = resolveCandidate(nearest, "ancestor-account");
  if (inheritedResolution !== undefined) return inheritedResolution;

  return { status: "none" };
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
  readonly secret: ProviderCredentialValue;
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
  | { readonly status: "created"; readonly connection: ProviderConnection }
  | { readonly status: "custody-reconcile"; readonly connectionId: string }
  | { readonly status: "custody-manual"; readonly connectionId: string }
  | { readonly status: "unknown-provider"; readonly provider: string }
  | {
      readonly status: "terms-not-acknowledged";
      readonly provider: string;
      readonly termsUrl: string | null;
    }
  | { readonly status: "scope-taken" }
  | { readonly status: "scope-mismatch" }
  | { readonly status: "account-unavailable"; readonly accountId: string }
  | {
      readonly status: "application-unavailable";
      readonly applicationId: string;
    };

/**
 * Register a connection: commit pending metadata, then ask Kaana for its handle.
 *
 * `control` is a parameter, not a lookup. The route resolves it first and
 * refuses before parsing the credential when the dedicated authority is absent.
 *
 * ## Ordering, and which failure is survivable
 *
 * The pending row is committed before the network hop. Kaana success is fenced
 * into `ready`; a missing acknowledgement becomes `reconciliation` and a
 * confirmed conflict becomes `manual`, both excluded by the resolver.
 */
export async function createProviderConnection(
  input: CreateProviderConnectionInput,
  control: KaanaCredentialControl,
): Promise<CreateProviderConnectionResult> {
  if (
    (input.scopeKind === "application") !==
    (input.applicationId !== undefined)
  ) {
    return { status: "scope-mismatch" };
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
    return { status: "unknown-provider", provider: input.provider };
  }
  if (provider.termsRequired && !input.acknowledgeProviderTerms) {
    return {
      status: "terms-not-acknowledged",
      provider: provider.slug,
      termsUrl: provider.termsUrl,
    };
  }

  // Minted here because this exact id is part of Kaana's immutable KMS context.
  const connectionId = uuidv7();
  const operationId = uuidv7();
  const operationActor = providerConnectionOperationActor(input.actor);
  try {
    const preparation = await getDb().transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id, accountStatus: users.accountStatus })
        .from(users)
        .where(eq(users.id, input.ownerAccountId))
        .limit(1)
        .for("update");
      if (owner === undefined || owner.accountStatus !== "active") {
        return "account-unavailable" as const;
      }
      const [closureFence] = await tx
        .select({ accountId: accountClosureFences.accountId })
        .from(accountClosureFences)
        .where(eq(accountClosureFences.accountId, owner.id))
        .limit(1);
      if (closureFence !== undefined) {
        return "account-unavailable" as const;
      }

      if (
        input.scopeKind === "application" &&
        input.applicationId !== undefined
      ) {
        // Application deletion takes this same lock before checking custody.
        // Re-read both lifecycle and ownership under it so authorization done
        // before the transaction cannot race a delete or rebind attribution.
        const [application] = await tx
          .select({
            ownerAccountId: applications.ownerAccountId,
            status: applications.status,
          })
          .from(applications)
          .where(eq(applications.id, input.applicationId))
          .limit(1)
          .for("update");
        if (
          application === undefined ||
          application.status === "deleted" ||
          application.ownerAccountId !== input.ownerAccountId
        ) {
          return "application-unavailable" as const;
        }
      }

      await tx.insert(inferenceProviderConnections).values({
        id: connectionId,
        provider: provider.slug,
        ownerAccountId: input.ownerAccountId,
        scopeKind: input.scopeKind,
        applicationId: input.applicationId ?? null,
        environment: input.environment,
        // Never `active` on create: nothing has checked the credential yet, and
        // a connection that claims to work before anyone asked the provider is
        // the state a customer debugs for an hour.
        status: "pending_validation",
        custodyState: "pending",
        credentialHandle: null,
        credentialRevision: null,
        validationState: "unvalidated",
        termsAcknowledgedAt: provider.termsRequired ? new Date() : null,
        providerTermsAcknowledgementRequired: provider.termsRequired,
      });
      await tx.insert(inferenceProviderCredentialOperations).values({
        id: operationId,
        connectionId,
        action: "create",
        provider: provider.slug,
        ownerAccountId: input.ownerAccountId,
        environment: input.environment,
        operationActor,
        credentialHandle: null,
        expectedRevision: null,
        previousConnectionStatus: null,
        state: "pending",
      });
      return "prepared" as const;
    });
    if (preparation === "account-unavailable") {
      return { status: preparation, accountId: input.ownerAccountId };
    }
    if (preparation === "application-unavailable") {
      return { status: preparation, applicationId: input.applicationId! };
    }
  } catch (error) {
    if (isLiveScopeCollision(error)) {
      return { status: "scope-taken" };
    }
    throw error;
  }

  let outcome: KaanaCredentialOutcome;
  try {
    outcome = await control.create({
      operationId,
      provider: provider.slug,
      ownerAccountId: input.ownerAccountId,
      connectionId,
      environment: input.environment,
      operationActor,
      secret: input.secret,
    });
  } catch (error) {
    if (error instanceof KaanaCredentialConflictError) {
      await markCredentialOperation(connectionId, operationId, "manual");
      return { status: "custody-manual", connectionId };
    }
    await markCredentialOperation(connectionId, operationId, "reconciliation");
    return { status: "custody-reconcile", connectionId };
  }
  if (outcome.status !== "applied") {
    await markCredentialOperation(connectionId, operationId, "reconciliation");
    return { status: "custody-reconcile", connectionId };
  }

  try {
    return {
      status: "created",
      connection: await applyCredentialOperation(operationId, outcome),
    };
  } catch (error) {
    void error;
    await markCredentialOperation(connectionId, operationId, "reconciliation");
    return { status: "custody-reconcile", connectionId };
  }
}

/** Outcomes of a rotation. */
export type RotateProviderConnectionResult =
  | { readonly status: "rotated"; readonly connection: ProviderConnection }
  | { readonly status: "custody-reconcile" }
  | { readonly status: "custody-manual" }
  | { readonly status: "unknown-connection" }
  | { readonly status: "revoked" };

/**
 * Replace the credential behind a connection.
 *
 * The REFERENCE does not change — it is pinned to the connection's environment,
 * owner and id by the partition CHECK, none of which a rotation touches — so a
 * data plane holding the reference keeps working and the old credential is gone
 * after Kaana advances the exact revision. The opaque handle is stable.
 *
 * The previous validation verdict was about a credential generation that no
 * longer exists. An active connection therefore returns to
 * `pending_validation`; a connection an operator disabled remains disabled.
 * The applied update derives that transition from the row's current status so a
 * disable concurrent with the Kaana round trip cannot be overwritten.
 */
export async function rotateProviderConnection(
  input: {
    readonly connectionId: string;
    readonly secret: ProviderCredentialValue;
    readonly actor: ProviderConnectionActor;
  },
  control: KaanaCredentialControl,
): Promise<RotateProviderConnectionResult> {
  const existing = await getProviderConnectionRow(input.connectionId);
  if (existing === undefined) return { status: "unknown-connection" };
  if (existing.status === "revoked") return { status: "revoked" };

  if (
    existing.custodyState !== "ready" ||
    existing.credentialHandle === null ||
    existing.credentialRevision === null
  ) {
    return { status: "custody-reconcile" };
  }
  const credentialHandle = existing.credentialHandle;
  const credentialRevision = existing.credentialRevision;

  const operationId = uuidv7();
  const operationActor = providerConnectionOperationActor(input.actor);
  const fenced = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({ custodyState: "reconcile" })
      .where(
        and(
          eq(inferenceProviderConnections.id, input.connectionId),
          eq(inferenceProviderConnections.custodyState, "ready"),
          eq(inferenceProviderConnections.credentialHandle, credentialHandle),
          eq(
            inferenceProviderConnections.credentialRevision,
            credentialRevision,
          ),
        ),
      )
      .returning({ id: inferenceProviderConnections.id });
    if (row === undefined) return undefined;
    await tx.insert(inferenceProviderCredentialOperations).values({
      id: operationId,
      connectionId: existing.id,
      action: "rotate",
      provider: existing.provider,
      ownerAccountId: existing.ownerAccountId,
      environment: existing.environment,
      operationActor,
      credentialHandle,
      expectedRevision: credentialRevision,
      previousConnectionStatus: null,
      state: "pending",
    });
    return row;
  });
  if (fenced === undefined) return { status: "custody-reconcile" };

  let outcome: KaanaCredentialOutcome;
  try {
    outcome = await control.rotate({
      operationId,
      provider: existing.provider,
      ownerAccountId: existing.ownerAccountId,
      connectionId: existing.id,
      environment: existing.environment,
      operationActor,
      credentialHandle,
      expectedRevision: credentialRevision,
      secret: input.secret,
    });
  } catch (error) {
    if (error instanceof KaanaCredentialConflictError) {
      await markCredentialOperation(existing.id, operationId, "manual");
      return { status: "custody-manual" };
    }
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }
  if (outcome.status !== "applied") {
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }

  try {
    return {
      status: "rotated",
      connection: await applyCredentialOperation(operationId, outcome),
    };
  } catch (error) {
    void error;
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }
}

/** Outcomes of a lifecycle transition that touches no credential. */
export type ProviderConnectionStatusResult =
  | { readonly status: "updated"; readonly connection: ProviderConnection }
  | { readonly status: "unknown-connection" }
  | { readonly status: "revoked" }
  | { readonly status: "already"; readonly current: ProviderConnectionStatus };

/**
 * Take a connection out of service immediately.
 *
 * Pure database work — no Kaana round trip — because "immediate" has to mean
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
    eventType: "disabled",
    next: () => "disabled",
    refuseWhen: (row) => (row.status === "disabled" ? "disabled" : undefined),
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
    eventType: "enabled",
    next: (row) =>
      row.validationState === "valid" ? "active" : "pending_validation",
    refuseWhen: (row) => (row.status === "disabled" ? undefined : row.status),
  });
}

async function transitionStatus(input: {
  readonly connectionId: string;
  readonly actor: ProviderConnectionActor;
  readonly eventType: Extract<
    ProviderConnectionAuditEventType,
    "disabled" | "enabled"
  >;
  readonly next: (
    row: InferenceProviderConnectionRow,
  ) => ProviderConnectionStatus;
  readonly refuseWhen: (
    row: InferenceProviderConnectionRow,
  ) => ProviderConnectionStatus | undefined;
}): Promise<ProviderConnectionStatusResult> {
  return getDb().transaction(
    async (tx): Promise<ProviderConnectionStatusResult> => {
      const existing = await lockProviderConnectionRow(tx, input.connectionId);
      if (existing === undefined) return { status: "unknown-connection" };
      if (existing.status === "revoked") return { status: "revoked" };

      const refusal = input.refuseWhen(existing);
      if (refusal !== undefined) return { status: "already", current: refusal };

      const next = input.next(existing);
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

      return { status: "updated", connection: toProviderConnection(row) };
    },
  );
}

/** Outcomes of a revoke. */
export type RevokeProviderConnectionResult =
  | {
      readonly status: "revoked";
      readonly connection: ProviderConnection;
      readonly credentialRevoked: true;
    }
  | { readonly status: "custody-reconcile" }
  | { readonly status: "custody-manual" }
  | { readonly status: "unknown-connection" }
  | { readonly status: "already-revoked" };

/**
 * Retire a connection permanently and ask Kaana to revoke the exact generation.
 *
 * The Oxy row is fenced locally first, so no request can route while the signed
 * control hop is in flight. A missing acknowledgement remains `reconcile` and
 * never gets promoted to `revoked` custody by assumption.
 */
export async function revokeProviderConnection(
  input: {
    readonly connectionId: string;
    readonly actor: ProviderConnectionActor;
  },
  control?: KaanaCredentialControl,
): Promise<RevokeProviderConnectionResult> {
  const operationId = uuidv7();
  const fenced = await getDb().transaction(async (tx) => {
    const existing = await lockProviderConnectionRow(tx, input.connectionId);
    if (existing === undefined)
      return { status: "unknown-connection" as const };
    if (existing.status === "revoked")
      return { status: "already-revoked" as const };
    if (
      existing.custodyState !== "ready" ||
      existing.credentialHandle === null ||
      existing.credentialRevision === null
    ) {
      return { status: "custody-reconcile" as const };
    }

    const operationActor = providerConnectionOperationActor(input.actor);
    const credentialHandle = existing.credentialHandle;
    const credentialRevision = existing.credentialRevision;
    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({ status: "revoked", custodyState: "reconcile" })
      .where(
        and(
          eq(inferenceProviderConnections.id, input.connectionId),
          eq(inferenceProviderConnections.status, existing.status),
          eq(inferenceProviderConnections.custodyState, "ready"),
          eq(inferenceProviderConnections.credentialHandle, credentialHandle),
          eq(
            inferenceProviderConnections.credentialRevision,
            credentialRevision,
          ),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new Error(
        "locked provider connection could not be fenced for revocation",
      );
    }
    await tx.insert(inferenceProviderCredentialOperations).values({
      id: operationId,
      connectionId: existing.id,
      action: "revoke",
      provider: existing.provider,
      ownerAccountId: existing.ownerAccountId,
      environment: existing.environment,
      operationActor,
      credentialHandle,
      expectedRevision: credentialRevision,
      previousConnectionStatus: existing.status,
      state: "pending",
    });
    return {
      status: "fenced" as const,
      existing,
      operationActor,
      credentialHandle,
      credentialRevision,
    };
  });

  if (fenced.status !== "fenced") return fenced;
  const { existing, operationActor, credentialHandle, credentialRevision } =
    fenced;

  if (control === undefined) {
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }

  let outcome: KaanaCredentialOutcome;
  try {
    outcome = await control.revoke({
      operationId,
      provider: existing.provider,
      ownerAccountId: existing.ownerAccountId,
      connectionId: existing.id,
      environment: existing.environment,
      operationActor,
      credentialHandle,
      expectedRevision: credentialRevision,
    });
  } catch (error) {
    if (error instanceof KaanaCredentialConflictError) {
      await markCredentialOperation(existing.id, operationId, "manual");
      return { status: "custody-manual" };
    }
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }
  if (outcome.status !== "applied") {
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }

  try {
    return {
      status: "revoked",
      connection: await applyCredentialOperation(operationId, outcome),
      credentialRevoked: true,
    };
  } catch (error) {
    void error;
    await markCredentialOperation(existing.id, operationId, "reconciliation");
    return { status: "custody-reconcile" };
  }
}

export type ReconcileProviderConnectionResult =
  | {
      readonly status: "reconciled";
      readonly action: InferenceProviderCredentialOperationRow["action"];
      readonly connection: ProviderConnection;
    }
  | { readonly status: "reconciliation-required" }
  | { readonly status: "manual-required" }
  | {
      readonly status: "credential-required";
      readonly action: "create" | "rotate";
    }
  | { readonly status: "credential-not-applicable" }
  | { readonly status: "no-unresolved-operation" }
  | { readonly status: "unknown-connection" };

/**
 * Resolve one quarantined connection from Kaana's signed durable outcome.
 *
 * Always asks for the exact outcome first. Only an explicit 404 permits an
 * at-least-once replay under the SAME durable operation id. Create/rotate then
 * require the original credential again; Kaana validates that the replayed
 * payload matches the operation id it recorded. Revoke replays without
 * plaintext. Network, malformed and 5xx responses never trigger a mutation and
 * leave the connection quarantined.
 */
export async function reconcileProviderConnection(
  connectionId: string,
  control: KaanaCredentialControl,
  secret?: ProviderCredentialValue,
): Promise<ReconcileProviderConnectionResult> {
  const existing = await getProviderConnectionRow(connectionId);
  if (existing === undefined) return { status: "unknown-connection" };

  const [operation] = await getDb()
    .select()
    .from(inferenceProviderCredentialOperations)
    .where(
      and(
        eq(inferenceProviderCredentialOperations.connectionId, connectionId),
        inArray(inferenceProviderCredentialOperations.state, [
          "pending",
          "reconciliation",
          "manual",
        ]),
      ),
    )
    .limit(1);
  if (operation === undefined) return { status: "no-unresolved-operation" };
  if (operation.state === "manual") return { status: "manual-required" };
  if (operation.action === "revoke" && secret !== undefined) {
    return { status: "credential-not-applicable" };
  }

  let outcome: KaanaCredentialOutcome;
  try {
    outcome = await control.outcome(outcomeRequestForOperation(operation));
  } catch (error) {
    if (error instanceof KaanaCredentialConflictError) {
      await markCredentialOperation(connectionId, operation.id, "manual");
      return { status: "manual-required" };
    }
    if (!(error instanceof KaanaCredentialOutcomeNotFoundError)) {
      await markCredentialOperation(
        connectionId,
        operation.id,
        "reconciliation",
      );
      return { status: "reconciliation-required" };
    }

    if (operation.action === "revoke") {
      if (
        operation.credentialHandle === null ||
        operation.expectedRevision === null
      ) {
        await markCredentialOperation(
          connectionId,
          operation.id,
          "reconciliation",
        );
        return { status: "reconciliation-required" };
      }
      try {
        outcome = await control.revoke({
          operationId: operation.id,
          provider: operation.provider,
          ownerAccountId: operation.ownerAccountId,
          connectionId: operation.connectionId,
          environment: operation.environment,
          operationActor: operation.operationActor,
          credentialHandle: operation.credentialHandle,
          expectedRevision: operation.expectedRevision,
        });
      } catch (replayError) {
        if (replayError instanceof KaanaCredentialConflictError) {
          await markCredentialOperation(connectionId, operation.id, "manual");
          return { status: "manual-required" };
        }
        await markCredentialOperation(
          connectionId,
          operation.id,
          "reconciliation",
        );
        return { status: "reconciliation-required" };
      }
    } else {
      if (secret === undefined)
        return { status: "credential-required", action: operation.action };
      try {
        outcome =
          operation.action === "create"
            ? await control.create({
                operationId: operation.id,
                provider: operation.provider,
                ownerAccountId: operation.ownerAccountId,
                connectionId: operation.connectionId,
                environment: operation.environment,
                operationActor: operation.operationActor,
                secret,
              })
            : operation.credentialHandle !== null &&
                operation.expectedRevision !== null
              ? await control.rotate({
                  operationId: operation.id,
                  provider: operation.provider,
                  ownerAccountId: operation.ownerAccountId,
                  connectionId: operation.connectionId,
                  environment: operation.environment,
                  operationActor: operation.operationActor,
                  secret,
                  credentialHandle: operation.credentialHandle,
                  expectedRevision: operation.expectedRevision,
                })
              : (() => {
                  throw new Error(
                    "provider credential rotate operation lost exact selectors",
                  );
                })();
      } catch (replayError) {
        if (replayError instanceof KaanaCredentialConflictError) {
          await markCredentialOperation(connectionId, operation.id, "manual");
          return { status: "manual-required" };
        }
        await markCredentialOperation(
          connectionId,
          operation.id,
          "reconciliation",
        );
        return { status: "reconciliation-required" };
      }
    }
  }
  if (outcome.status !== "applied") {
    await markCredentialOperation(connectionId, operation.id, "reconciliation");
    return { status: "reconciliation-required" };
  }

  try {
    return {
      status: "reconciled",
      action: operation.action,
      connection: await applyCredentialOperation(operation.id, outcome),
    };
  } catch (error) {
    void error;
    await markCredentialOperation(connectionId, operation.id, "reconciliation");
    return { status: "reconciliation-required" };
  }
}

/** Outcomes of recording a validation verdict. */
export type RecordValidationResult =
  | { readonly status: "recorded"; readonly connection: ProviderConnection }
  | { readonly status: "unknown-connection" }
  | { readonly status: "generation-not-ready" }
  | { readonly status: "stale-generation" }
  | { readonly status: "revoked" };

/**
 * Record the verdict of a credential check.
 *
 * The check itself is performed where the credential is — the data plane, which
 * resolves the reference to serve a request. This module never fetches a secret
 * back to check it; only Kaana inference can resolve it.
 *
 * An `invalid` verdict also DISABLES the connection, in the same transaction and
 * with its own audit row. Two rows rather than one, because two things happened
 * and an audit trail that merges them cannot answer "was it disabled because the
 * key failed, or did someone disable it".
 */
export async function recordProviderConnectionValidation(input: {
  readonly connectionId: string;
  readonly credentialHandle: string;
  readonly credentialRevision: number;
  readonly state: ProviderConnectionValidationStateValue;
  readonly failureCode?: ProviderConnectionValidationFailureCode;
  /**
   * Who asked for the check. `{kind:'platform'}` when the data plane reported the
   * verdict itself, which is a different fact from a member requesting one and is
   * now recorded as one.
   */
  readonly actor: ProviderConnectionActor;
}): Promise<RecordValidationResult> {
  return getDb().transaction(async (tx): Promise<RecordValidationResult> => {
    const existing = await lockProviderConnectionRow(tx, input.connectionId);
    if (existing === undefined) return { status: "unknown-connection" };
    if (existing.custodyState !== "ready")
      return { status: "generation-not-ready" };
    if (
      existing.credentialHandle !== input.credentialHandle ||
      existing.credentialRevision !== input.credentialRevision
    ) {
      return { status: "stale-generation" };
    }
    if (existing.status === "revoked") return { status: "revoked" };

    const rejected = input.state === "invalid" || input.state === "expired";
    const nextStatus: ProviderConnectionStatus = rejected
      ? "disabled"
      : input.state === "valid" && existing.status === "pending_validation"
        ? "active"
        : input.state === "unvalidated" && existing.status === "active"
          ? "pending_validation"
          : existing.status;

    const [row] = await tx
      .update(inferenceProviderConnections)
      .set({
        validationState: input.state,
        validationFailureCode:
          input.state === "invalid" ? (input.failureCode ?? "unknown") : null,
        lastValidatedAt: new Date(),
        status: nextStatus,
      })
      .where(eq(inferenceProviderConnections.id, input.connectionId))
      .returning();

    await appendAuditEvent(tx, {
      connectionId: row.id,
      ownerAccountId: row.ownerAccountId,
      environment: row.environment,
      eventType: "validated",
      actor: input.actor,
      metadata: {
        credentialHandle: input.credentialHandle,
        credentialRevision: input.credentialRevision,
        validationState: row.validationState,
        failureCode: row.validationFailureCode,
      },
    });

    if (rejected && existing.status !== "disabled") {
      await appendAuditEvent(tx, {
        connectionId: row.id,
        ownerAccountId: row.ownerAccountId,
        environment: row.environment,
        eventType: "disabled",
        // Nobody disabled it: the provider's answer did. Naming a person here
        // would be an accusation, so the actor is Oxy's own machinery.
        actor: { kind: "platform" },
        metadata: { previousStatus: existing.status, reason: input.state },
      });
    }

    return { status: "recorded", connection: toProviderConnection(row) };
  });
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function providerConnectionOperationActor(
  actor: ProviderConnectionActor,
): string {
  return actor.kind === "user" ? `user:${actor.userId}` : actor.kind;
}

function providerConnectionActorFromOperation(
  operationActor: string,
): ProviderConnectionActor {
  if (operationActor === "service") return { kind: "service" };
  if (operationActor === "platform") return { kind: "platform" };
  if (
    operationActor.startsWith("user:") &&
    operationActor.length > "user:".length
  ) {
    return { kind: "user", userId: operationActor.slice("user:".length) };
  }
  throw new Error("provider credential operation has an invalid Oxy actor");
}

function outcomeRequestForOperation(
  operation: InferenceProviderCredentialOperationRow,
): KaanaCredentialOutcomeRequest {
  const identity = {
    schemaVersion: 1 as const,
    operationId: operation.id,
    provider: operation.provider,
    ownerAccountId: operation.ownerAccountId,
    connectionId: operation.connectionId,
    environment: operation.environment,
  };
  switch (operation.action) {
    case "create":
      return kaanaCredentialOutcomeRequestSchema.parse({
        ...identity,
        action: "create",
      });
    case "rotate":
      return kaanaCredentialOutcomeRequestSchema.parse({
        ...identity,
        action: "rotate",
        credentialHandle: operation.credentialHandle,
        expectedRevision: operation.expectedRevision,
      });
    case "revoke":
      return kaanaCredentialOutcomeRequestSchema.parse({
        ...identity,
        action: "revoke",
        credentialHandle: operation.credentialHandle,
        expectedRevision: operation.expectedRevision,
      });
  }
}

function credentialOutcomeMatchesOperation(
  operation: InferenceProviderCredentialOperationRow,
  outcome: KaanaCredentialOutcome,
): outcome is Extract<KaanaCredentialOutcome, { status: "applied" }> {
  if (
    outcome.status !== "applied" ||
    outcome.operationId !== operation.id ||
    outcome.action !== operation.action
  ) {
    return false;
  }
  if (operation.action === "create") {
    return outcome.revision === 1;
  }
  return (
    operation.credentialHandle !== null &&
    operation.expectedRevision !== null &&
    outcome.credentialHandle === operation.credentialHandle &&
    outcome.revision === operation.expectedRevision + 1
  );
}

/** Atomically commit one exact applied Kaana outcome and its customer audit. */
async function applyCredentialOperation(
  operationId: string,
  outcome: KaanaCredentialOutcome,
): Promise<ProviderConnection> {
  return getDb().transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(inferenceProviderCredentialOperations)
      .where(eq(inferenceProviderCredentialOperations.id, operationId))
      .limit(1)
      .for("update");
    if (
      operation === undefined ||
      !credentialOutcomeMatchesOperation(operation, outcome)
    ) {
      throw new Error(
        "provider credential outcome does not match its durable operation",
      );
    }

    if (operation.state === "applied") {
      if (
        operation.outcomeCredentialHandle !== outcome.credentialHandle ||
        operation.outcomeRevision !== outcome.revision
      ) {
        throw new Error(
          "applied provider credential operation has a different durable outcome",
        );
      }
      const [current] = await tx
        .select()
        .from(inferenceProviderConnections)
        .where(eq(inferenceProviderConnections.id, operation.connectionId))
        .limit(1);
      if (current === undefined) {
        throw new Error(
          "applied provider credential operation lost its connection",
        );
      }
      return toProviderConnection(current);
    }
    if (!["pending", "reconciliation"].includes(operation.state)) {
      throw new Error(
        "provider credential operation is not recoverable automatically",
      );
    }

    const [before] = await tx
      .select()
      .from(inferenceProviderConnections)
      .where(
        and(
          eq(inferenceProviderConnections.id, operation.connectionId),
          eq(inferenceProviderConnections.provider, operation.provider),
          eq(
            inferenceProviderConnections.ownerAccountId,
            operation.ownerAccountId,
          ),
          eq(inferenceProviderConnections.environment, operation.environment),
        ),
      )
      .limit(1);
    if (before === undefined) {
      throw new Error(
        "provider credential operation lost its exact connection identity",
      );
    }

    let row: InferenceProviderConnectionRow | undefined;
    switch (operation.action) {
      case "create": {
        [row] = await tx
          .update(inferenceProviderConnections)
          .set({
            custodyState: "ready",
            credentialHandle: outcome.credentialHandle,
            credentialRevision: outcome.revision,
          })
          .where(
            and(
              eq(inferenceProviderConnections.id, operation.connectionId),
              inArray(inferenceProviderConnections.custodyState, [
                "pending",
                "reconcile",
              ]),
              isNull(inferenceProviderConnections.credentialHandle),
              isNull(inferenceProviderConnections.credentialRevision),
            ),
          )
          .returning();
        break;
      }
      case "rotate": {
        if (
          operation.credentialHandle === null ||
          operation.expectedRevision === null
        ) {
          throw new Error(
            "provider credential rotate operation lost exact selectors",
          );
        }
        [row] = await tx
          .update(inferenceProviderConnections)
          .set({
            custodyState: "ready",
            credentialRevision: outcome.revision,
            status: sql`case when ${inferenceProviderConnections.status} = 'active' then 'pending_validation' else ${inferenceProviderConnections.status} end`,
            validationState: "unvalidated",
            validationFailureCode: null,
            rotatedAt: new Date(),
          })
          .where(
            and(
              eq(inferenceProviderConnections.id, operation.connectionId),
              eq(inferenceProviderConnections.custodyState, "reconcile"),
              eq(
                inferenceProviderConnections.credentialHandle,
                operation.credentialHandle,
              ),
              eq(
                inferenceProviderConnections.credentialRevision,
                operation.expectedRevision,
              ),
            ),
          )
          .returning();
        break;
      }
      case "revoke": {
        if (
          operation.credentialHandle === null ||
          operation.expectedRevision === null
        ) {
          throw new Error(
            "provider credential revoke operation lost exact selectors",
          );
        }
        [row] = await tx
          .update(inferenceProviderConnections)
          .set({
            status: "revoked",
            custodyState: "revoked",
            credentialRevision: outcome.revision,
          })
          .where(
            and(
              eq(inferenceProviderConnections.id, operation.connectionId),
              eq(inferenceProviderConnections.status, "revoked"),
              eq(inferenceProviderConnections.custodyState, "reconcile"),
              eq(
                inferenceProviderConnections.credentialHandle,
                operation.credentialHandle,
              ),
              eq(
                inferenceProviderConnections.credentialRevision,
                operation.expectedRevision,
              ),
            ),
          )
          .returning();
        break;
      }
    }
    if (row === undefined) {
      throw new Error(
        "provider credential operation lost its fenced connection row",
      );
    }

    const [applied] = await tx
      .update(inferenceProviderCredentialOperations)
      .set({
        state: "applied",
        outcomeCredentialHandle: outcome.credentialHandle,
        outcomeRevision: outcome.revision,
      })
      .where(
        and(
          eq(inferenceProviderCredentialOperations.id, operation.id),
          inArray(inferenceProviderCredentialOperations.state, [
            "pending",
            "reconciliation",
          ]),
        ),
      )
      .returning({ id: inferenceProviderCredentialOperations.id });
    if (applied === undefined) {
      throw new Error(
        "provider credential operation lost its unresolved ledger row",
      );
    }

    const actor = providerConnectionActorFromOperation(
      operation.operationActor,
    );
    switch (operation.action) {
      case "create":
        await appendAuditEvent(tx, {
          connectionId: row.id,
          ownerAccountId: row.ownerAccountId,
          environment: row.environment,
          eventType: "created",
          actor,
          metadata: {
            provider: row.provider,
            scopeKind: row.scopeKind,
            credentialRevision: outcome.revision,
            termsAcknowledged: row.providerTermsAcknowledgementRequired,
          },
        });
        break;
      case "rotate":
        await appendAuditEvent(tx, {
          connectionId: row.id,
          ownerAccountId: row.ownerAccountId,
          environment: row.environment,
          eventType: "rotated",
          actor,
          metadata: {
            credentialRevision: outcome.revision,
          },
        });
        break;
      case "revoke":
        await appendAuditEvent(tx, {
          connectionId: row.id,
          ownerAccountId: row.ownerAccountId,
          environment: row.environment,
          eventType: "revoked",
          actor,
          metadata: {
            previousStatus: operation.previousConnectionStatus,
            credentialRevoked: true,
            credentialRevision: outcome.revision,
          },
        });
        break;
    }

    return toProviderConnection(row);
  });
}

/** Fence an uncertain or conflicting cross-service result out of all routing. */
async function markCredentialOperation(
  connectionId: string,
  operationId: string,
  state: Extract<ProviderCredentialOperationState, "reconciliation" | "manual">,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [operation] = await tx
      .update(inferenceProviderCredentialOperations)
      .set({ state })
      .where(
        and(
          eq(inferenceProviderCredentialOperations.id, operationId),
          eq(inferenceProviderCredentialOperations.connectionId, connectionId),
          inArray(
            inferenceProviderCredentialOperations.state,
            state === "manual"
              ? ["pending", "reconciliation", "manual"]
              : ["pending", "reconciliation"],
          ),
        ),
      )
      .returning({ id: inferenceProviderCredentialOperations.id });
    if (operation === undefined) return;
    await tx
      .update(inferenceProviderConnections)
      .set({ custodyState: "reconcile" })
      .where(eq(inferenceProviderConnections.id, connectionId));
  });
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
  if (cause === null || typeof cause !== "object") return false;
  const detail = cause as { code?: unknown; constraint_name?: unknown };
  return (
    detail.code === "23505" &&
    detail.constraint_name === "inference_provider_connections_live_scope_key"
  );
}
