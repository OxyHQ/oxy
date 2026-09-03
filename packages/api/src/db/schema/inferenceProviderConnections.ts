/**
 * `inference_provider_connections` — BYOK, as Oxy is allowed to hold it
 * (issue #972 workstream 10).
 *
 * ## THE ONE RULE
 *
 * **A provider secret never reaches this table.** Not encrypted, not hashed,
 * not "temporarily". What is stored is Kaana's opaque `credential_handle`, its
 * exact revision and lifecycle state.
 * `providerConnectionSchema` in `@oxyhq/contracts` is
 * `.strict()` and carries no field a credential could occupy, and this table is
 * its storage shape column for column — so a producer that tries to attach one
 * fails the parse rather than being silently stripped.
 *
 * Kaana alone stores KMS ciphertext and resolves plaintext inside inference.
 *
 * ## What isolates what — stated exactly, because "encrypted per account" is
 * the kind of claim that reads as a guarantee and is usually a hope
 *
 * Oxy holds no ciphertext, so it enforces no cipher. It enforces three exact
 * control-plane properties:
 *
 *  1. **Only a Kaana-minted opaque handle is admissible.** The closed format
 *     check rejects secret-store locators and credential-shaped strings.
 *  2. **One handle belongs to one connection.** The unique constraint prevents
 *     two metadata rows from authorizing the same Kaana credential.
 *  3. **At most one LIVE connection per (scope, provider, environment).** The
 *     partial unique index below. Without it "which of this customer's OpenAI
 *     keys served the request" has no answer, and a development key can silently
 *     serve production traffic.
 *
 * Account isolation on the READ path is the ordinary one: every query filters on
 * `owner_account_id`, and the routes answer 404 rather than 403 for another
 * account's connection so the id space is not an existence oracle.
 *
 * ## Scope: account, project, application
 *
 * In the unified account graph a project IS an account, so `account` and
 * `project` differ by INHERITANCE, not by id space — an `account` connection is
 * inherited by every descendant, a `project` one applies to that account alone,
 * an `application` one to a single application. `scope_kind` records which the
 * customer chose, and `resolveProviderConnectionForApplication` in the service
 * is the single reader of that precedence.
 *
 * `owner_account_id` is BOTH the owner and the scope's account: the account a
 * connection is scoped to is the account that answers for it. The contract
 * carries the two as separate fields; storing one column rather than two is what
 * stops them disagreeing.
 *
 * ## Billing, and what BYOK is not
 *
 * The upstream provider bills the customer's own account DIRECTLY; Oxy charges
 * only its platform/service fee. That is not recorded here as a per-row flag
 * because it is not a per-row fact — it is what BYOK means, so the contract
 * states it as `upstreamBillsCustomerDirectly: z.literal(true)` and the receipt
 * side already carries the other half (`usage_receipts.platform_fee_only`,
 * workstream 7). A BYOK request still produces an Oxy usage receipt; nothing
 * here changes that.
 *
 * BYOK does NOT override the provider's terms and does NOT permit credential
 * sharing. Where a provider's terms require a per-customer acknowledgement,
 * `inference_providers.byok_terms_acknowledgement_required` says so and the
 * composite foreign key below makes an un-acknowledged connection unwritable.
 *
 * ## Routing preference lives on the ROUTING POLICY, not here
 *
 * `inference_routing_policy_versions.byok_preference` (`disabled | prefer |
 * require`, workstream 6) is the ONE place a customer expresses whether their
 * own credentials may or must be used. This table deliberately carries no
 * second preference field: two places to say the same thing is two places to
 * disagree. What this table adds is the object that preference resolves
 * AGAINST — a `require` policy with no live connection for the provider has
 * nothing to require, which is the resolver's job to answer, not a column's.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { applications } from './applications';
import { inferenceProviders } from './inferenceProviders';
import { users } from './users';

/**
 * How widely a connection applies. Mirrors `providerConnectionScopeSchema`'s
 * discriminant; held against it by `__tests__/inferenceProviderConnections.test.ts`.
 */
export const PROVIDER_CONNECTION_SCOPE_KINDS = ['account', 'project', 'application'] as const;

export type ProviderConnectionScopeKind = (typeof PROVIDER_CONNECTION_SCOPE_KINDS)[number];

/** Lifecycle. `revoked` is terminal; `disabled` is reversible. */
export const PROVIDER_CONNECTION_STATUSES = [
  'pending_validation',
  'active',
  'disabled',
  'revoked',
] as const;

export type ProviderConnectionStatusValue = (typeof PROVIDER_CONNECTION_STATUSES)[number];

/** Cross-service custody state. Only `ready` is eligible for routing. */
export const PROVIDER_CREDENTIAL_CUSTODY_STATES = [
  'pending',
  'ready',
  'reconcile',
  'revoked',
] as const;

export type ProviderCredentialCustodyStateValue =
  (typeof PROVIDER_CREDENTIAL_CUSTODY_STATES)[number];

/** Statuses that claim a scope key and therefore prevent a parallel replacement. */
export const EXCLUSIVE_PROVIDER_CONNECTION_STATUSES = ['pending_validation', 'active'] as const;

/** Outcome of the last credential check. */
export const PROVIDER_CONNECTION_VALIDATION_STATES = [
  'unvalidated',
  'valid',
  'invalid',
  'expired',
] as const;

export type ProviderConnectionValidationStateValue =
  (typeof PROVIDER_CONNECTION_VALIDATION_STATES)[number];

/** Why a check failed. A CLOSED set, so it can be grouped rather than grepped. */
export const PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'network',
  'unknown',
] as const;

export type ProviderConnectionValidationFailureCode =
  (typeof PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES)[number];

/** Environments a credential is issued into. Mirrors `inferenceEnvironmentSchema`. */
export const PROVIDER_CONNECTION_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type ProviderConnectionEnvironment = (typeof PROVIDER_CONNECTION_ENVIRONMENTS)[number];

export const inferenceProviderConnections = pgTable(
  'inference_provider_connections',
  {
    id: generatedId(),

    /**
     * The provider whose credential this is. `RESTRICT`: a provider with live
     * customer connections is not one the catalogue may quietly drop, and the
     * refusal is the signal that those customers have to be dealt with first.
     *
     * Declared as a plain column here and wired by the composite foreign key in
     * the table extras, because the terms flag travels with it.
     */
    provider: text().notNull(),

    /**
     * The account that owns the connection, answers for its use, and whose
     * exact Kaana KMS context names. Also the account the SCOPE names — see the
     * header for why that is one column and not two.
     *
     * `RESTRICT`, unlike `applications.owner_account_id`'s `CASCADE`. A cascade
     * here would delete the metadata while leaving Kaana ciphertext with no Oxy
     * record that can revoke it. Account deletion must revoke these
     * first, which is a deliberate, loud step.
     */
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    scopeKind: text({ enum: PROVIDER_CONNECTION_SCOPE_KINDS }).notNull(),

    /**
     * The single application an `application`-scoped connection applies to.
     * NULL for the other two kinds, and the CHECK below makes that a
     * biconditional rather than a convention.
     *
     * `CASCADE`: an application-scoped connection configures an application that
     * no longer exists. The secret is destroyed on revoke, not on delete — see
     * `revokeProviderConnection`, which is why an application delete is not a
     * silent way to strand one.
     */
    applicationId: text().references(() => applications.id, {
      onDelete: 'cascade',
    }),

    environment: text({ enum: PROVIDER_CONNECTION_ENVIRONMENTS }).notNull(),
    status: text({ enum: PROVIDER_CONNECTION_STATUSES }).notNull(),

    /** Kaana-minted opaque handle; never a secret-store locator. */
    credentialHandle: text(),
    /** Exact immutable Kaana generation paired with the handle (JS safe int64 range). */
    credentialRevision: bigint({ mode: 'number' }),
    /** Cross-service commit state. Anything except `ready` is non-routable. */
    custodyState: text({ enum: PROVIDER_CREDENTIAL_CUSTODY_STATES }).notNull().default('pending'),

    validationState: text({
      enum: PROVIDER_CONNECTION_VALIDATION_STATES,
    }).notNull(),

    /** Required when `invalid`: a failure nobody can act on is not a result. */
    validationFailureCode: text({
      enum: PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES,
    }),

    lastValidatedAt: timestamptz(),

    /**
     * When the customer acknowledged the provider's BYOK terms. NULL is
     * legitimate for a provider that requires none; the composite foreign key
     * plus the CHECK below make it impossible for a provider that does.
     */
    termsAcknowledgedAt: timestamptz(),

    /**
     * Denormalised from `inference_providers`, and NOT free to drift: it is half
     * of the composite foreign key. Never written by a caller — the service
     * reads it off the provider row inside the same statement.
     */
    providerTermsAcknowledgementRequired: boolean().notNull().default(false),

    createdAt: createdAt(),

    /** When the credential behind this connection was last replaced. */
    rotatedAt: timestamptz(),
  },
  (t) => [
    /**
     * `(provider, provider_terms_acknowledgement_required)` →
     * `inference_providers (slug, byok_terms_acknowledgement_required)`.
     *
     * This is what turns "ask for an acknowledgement where the provider needs
     * one" from a service-layer rule into one the database keeps. A row claiming
     * the provider requires nothing while the catalogue says otherwise is
     * refused; and the CHECK below then requires the timestamp whenever the
     * denormalised flag is `true`. `RESTRICT`, so a provider carrying live
     * connections cannot be deleted out from under them.
     */
    foreignKey({
      name: 'inference_provider_connections_provider_terms_fk',
      columns: [t.provider, t.providerTermsAcknowledgementRequired],
      foreignColumns: [
        inferenceProviders.slug,
        inferenceProviders.byokTermsAcknowledgementRequired,
      ],
    }).onDelete('restrict'),

    /**
     * One stored secret, one connection. Partition (2) in the header: two
     * accounts cannot name the same credential, because the second write
     * collides.
     */
    unique('inference_provider_connections_credential_handle_key').on(t.credentialHandle),

    /** Composite target for the durable operation ledger's exact identity FK. */
    unique('inference_provider_connections_operation_identity_key').on(
      t.id,
      t.provider,
      t.ownerAccountId,
      t.environment,
    ),

    /**
     * At most one LIVE connection per scope, provider and environment.
     *
     * `coalesce(application_id, '')` rather than the bare column, because
     * `application_id` is NULL for account- and project-scoped rows and a
     * Postgres unique index is `NULLS DISTINCT` by default — every one of those
     * NULLs would compare unequal to every other, which is exactly the case this
     * index exists to constrain. `nullsNotDistinct()` is the direct spelling but
     * drizzle offers it only on a `unique()` CONSTRAINT, and a constraint cannot
     * be PARTIAL, which this must be. The empty string is safe as the sentinel:
     * an application id is a uuid v7 or a 24-character ObjectId hex, never `''`.
     *
     * Partial on the scope-claiming statuses so a revoked or disabled connection
     * never blocks its own replacement. `pending_validation` is deliberately in
     * this index even though it is not routable for serving: validation must
     * finish before a second credential may claim the same scope.
     *
     * `scope_kind` is IN the key: an account-scoped and a project-scoped
     * connection on the same account for the same provider would both apply to
     * that account, and "which one served the request" would have no answer.
     */
    uniqueIndex('inference_provider_connections_live_scope_key')
      .on(
        t.ownerAccountId,
        t.scopeKind,
        sql`coalesce(${t.applicationId}, '')`,
        t.provider,
        t.environment,
      )
      .where(sql`${t.status} in (${sql.raw(inList(EXCLUSIVE_PROVIDER_CONNECTION_STATUSES))})`),

    // "This account's connections, newest first" — the Console list.
    index('inference_provider_connections_owner_account_id_created_at_idx').on(
      t.ownerAccountId,
      t.createdAt.desc(),
    ),
    // …and the resolver's read, narrowed to one application.
    index('inference_provider_connections_application_id_idx').on(t.applicationId),

    check(
      'inference_provider_connections_scope_kind_check',
      sql`${t.scopeKind} in (${sql.raw(inList(PROVIDER_CONNECTION_SCOPE_KINDS))})`,
    ),
    check(
      'inference_provider_connections_status_check',
      sql`${t.status} in (${sql.raw(inList(PROVIDER_CONNECTION_STATUSES))})`,
    ),
    check(
      'inference_provider_connections_environment_check',
      sql`${t.environment} in (${sql.raw(inList(PROVIDER_CONNECTION_ENVIRONMENTS))})`,
    ),
    check(
      'inference_provider_connections_custody_state_check',
      sql`${t.custodyState} in (${sql.raw(inList(PROVIDER_CREDENTIAL_CUSTODY_STATES))})`,
    ),
    check(
      'inference_provider_connections_validation_state_check',
      sql`${t.validationState} in (${sql.raw(inList(PROVIDER_CONNECTION_VALIDATION_STATES))})`,
    ),
    check(
      'inference_provider_connections_validation_failure_code_check',
      sql`${t.validationFailureCode} is null or ${t.validationFailureCode} in (${sql.raw(
        inList(PROVIDER_CONNECTION_VALIDATION_FAILURE_CODES),
      )})`,
    ),

    /**
     * An application-scoped connection names an application; the other two never
     * do. A biconditional rather than one implication, because both degenerate
     * rows are wrong in their own way: an application scope with no application
     * configures nothing, and an account scope that names one is two different
     * scopes written in one row.
     */
    check(
      'inference_provider_connections_application_scope_check',
      sql`(${t.scopeKind} = 'application') = (${t.applicationId} is not null)`,
    ),

    /**
     * An `invalid` credential must record why the check failed. One direction
     * only: the converse is already covered, since the column is constrained to
     * failure codes and none is meaningful on any other state.
     */
    check(
      'inference_provider_connections_failure_code_required',
      sql`${t.validationState} <> 'invalid' or ${t.validationFailureCode} is not null`,
    ),

    /**
     * `active` means the exact current credential generation passed validation.
     * `providerConnectionSchema` refines the same rule; leaving it to the parse
     * alone would mean a direct write could store a row the serializer then
     * refuses to read back.
     */
    check(
      'inference_provider_connections_active_requires_valid',
      sql`${t.status} <> 'active' or ${t.validationState} = 'valid'`,
    ),

    /** Where the provider's own terms require an acknowledgement, it exists. */
    check(
      'inference_provider_connections_terms_acknowledged',
      sql`not ${t.providerTermsAcknowledgementRequired} or ${t.termsAcknowledgedAt} is not null`,
    ),

    check(
      'inference_provider_connections_credential_handle_format',
      sql`${t.credentialHandle} is null or ${t.credentialHandle} ~ '^kcred_[a-z2-7]{26}$'`,
    ),
    check(
      'inference_provider_connections_credential_reference_pair',
      sql`(${t.credentialHandle} is null) = (${t.credentialRevision} is null)`,
    ),
    check(
      'inference_provider_connections_credential_revision_positive',
      sql`${t.credentialRevision} is null or ${t.credentialRevision} between 1 and 9007199254740991`,
    ),
    check(
      'inference_provider_connections_custody_reference_required',
      sql`${t.custodyState} not in ('ready', 'revoked') or ${t.credentialHandle} is not null`,
    ),
    check(
      'inference_provider_connections_pending_has_no_reference',
      sql`${t.custodyState} <> 'pending' or ${t.credentialHandle} is null`,
    ),
  ],
);

export type InferenceProviderConnectionRow = typeof inferenceProviderConnections.$inferSelect;
