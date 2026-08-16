/**
 * `inference_routing_policy_versions` — one immutable revision of a customer's
 * routing configuration, and the thing a request records having executed under.
 *
 * The epic's requirement is "version routing policies so a request records the
 * exact policy used". That is only worth anything if the version cannot change
 * afterwards, so this table is APPEND-ONLY except for `is_current`, enforced by
 * `INFERENCE_ROUTING_POLICY_VERSION_IMMUTABILITY_DDL` rather than by convention —
 * a CHECK sees only the new row and can never express "nothing changed".
 * `usage_receipts.routing_policy_version_id` points here `ON DELETE RESTRICT`,
 * so a version a charge names cannot be removed either.
 *
 * `version` is the CUSTOMER's own revision number, unrelated to the wire
 * contract's `schemaVersion`. They are two clocks: a customer edits their policy
 * without any contract change, and a contract change renumbers nobody's policy.
 *
 * ## Contradictions that are UNREPRESENTABLE here, not merely rejected
 *
 * `routingPolicySchema`'s refinement (in `@oxyhq/contracts`) rejects the
 * contradictory combinations on the wire. This table's job is to make as many of
 * them as possible impossible to STORE, so that a future writer that skips the
 * wire schema — a script, a `psql` session, a second service — cannot produce
 * one:
 *
 *  | Contradiction | Made impossible by |
 *  |---|---|
 *  | a provider both required and denied | `not (allowlist && denylist)` |
 *  | a region both allowed and denied | `not (allowed && denied)` |
 *  | fallback disabled AND same-model failover on | one CHECK on this row |
 *  | fallback disabled AND a cross-model destination | the composite foreign key on `inference_routing_policy_fallbacks` |
 *  | Oxy-hosted-only AND BYOK required | one CHECK on this row |
 *  | two price ceilings for one unit | the primary key of `inference_routing_policy_price_caps` |
 *  | price ceilings in mixed currencies | there is ONE currency column, here, and the caps carry none of their own |
 *  | a default target that names both a model and a profile | the default-target CHECK below |
 *
 * The last two are the ones that could not be expressed on the wire at all: the
 * contract has to compare currencies across an array because a wire object is
 * flat, whereas storage can simply not have a second place to put a currency.
 *
 * ## What is NOT constrained here, deliberately
 *
 * The FORMAT of a provider slug, a region or a licence id inside the `text[]`
 * columns. Those are validated by the contract's own leaf schemas on the write
 * path (`inferenceProviderSlugSchema`, `inferenceRegionSchema`), and a malformed
 * slug is not a contradiction — it is a value that matches no route, which the
 * data plane already answers by serving nothing. `inference_deployments.regions`
 * makes the same call for the same reason.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { currencyCodeCheck, exactAmount } from './ledgerColumns';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { inferenceModels } from './inferenceModels';
import { inferenceRoutingPolicies } from './inferenceRoutingPolicies';
import { inferenceRoutingProfiles } from './inferenceRoutingProfiles';
import { users } from './users';

/**
 * What a policy resolves to when a caller names no model. Mirrors
 * `routingTargetSchema`'s discriminant; NULL means "every request must name its
 * own model", which is a third state the wire carries as an absent field.
 */
export const ROUTING_POLICY_TARGET_KINDS = ['model', 'routing_profile'] as const;

export type RoutingPolicyTargetKind = (typeof ROUTING_POLICY_TARGET_KINDS)[number];

/**
 * What to optimise for among the routes that qualify.
 *
 * Deliberately NOT the same tuple as `ROUTING_PROFILE_OPTIMISATIONS`, which also
 * carries `quality`: a profile is a curated strategy that can rank by an
 * editorial quality signal Oxy maintains, while a policy is a customer
 * constraint set and has no such signal to sort by. The two sets are checked
 * against their own contracts in `__tests__/inferenceRoutingPolicy.test.ts`.
 */
export const ROUTING_POLICY_OPTIMISATIONS = [
  'price',
  'latency',
  'throughput',
  'balanced',
] as const;

export type RoutingPolicyOptimisation = (typeof ROUTING_POLICY_OPTIMISATIONS)[number];

/** A tri-state preference: never, if available, or only. */
export const ROUTING_POLICY_PREFERENCES = ['disabled', 'prefer', 'require'] as const;

export type RoutingPolicyPreference = (typeof ROUTING_POLICY_PREFERENCES)[number];

export const inferenceRoutingPolicyVersions = pgTable(
  'inference_routing_policy_versions',
  {
    id: generatedId(),

    /**
     * `CASCADE`: a version of a policy that no longer exists configures nothing.
     * The cascade is not a way to erase history — a version any receipt names is
     * held by that receipt's `RESTRICT`, so the delete is refused rather than
     * quietly taking the explanation of a charge with it.
     */
    routingPolicyId: text()
      .notNull()
      .references(() => inferenceRoutingPolicies.id, { onDelete: 'cascade' }),

    /** The customer's own revision number, from 1, never reused. */
    version: integer().notNull(),

    /**
     * Which version new requests are served under.
     *
     * A boolean with a PARTIAL UNIQUE INDEX rather than a `current_version_id`
     * column on the policy: that would be a circular foreign key for a fact that
     * fits in a flag, and this shape gives at most one current version per policy
     * either way. It is the ONE column the immutability trigger does not protect,
     * exactly as `inference_model_revisions.is_current` is — superseding a
     * version is not editing it.
     */
    isCurrent: boolean().notNull().default(false),

    // ---- default target (epic: per-application default model or profile) ----

    /** NULL means every request must name its own model. */
    defaultTargetKind: text({ enum: ROUTING_POLICY_TARGET_KINDS }),

    /**
     * The unpinned form of a default model: follow this model's current revision.
     *
     * `RESTRICT` on all three target references. A default silently disappearing
     * because the catalogue entry it named was removed would turn "serve my
     * default" into "every request must name a model", which is a behaviour
     * change no customer asked for and nothing would report.
     */
    defaultModelId: text().references(() => inferenceModels.id, { onDelete: 'restrict' }),

    /** The pinned form: exactly these weights. */
    defaultModelRevisionId: text().references(() => inferenceModelRevisions.id, {
      onDelete: 'restrict',
    }),

    /** A catalogue routing profile — `auto`, `fast`, `quality`. */
    defaultRoutingProfileId: text().references(() => inferenceRoutingProfiles.id, {
      onDelete: 'restrict',
    }),

    // ---- provider and residency constraints ---------------------------------

    /** Empty means "no allowlist": every provider qualifies unless denied. */
    providerAllowlist: text().array().notNull(),
    providerDenylist: text().array().notNull(),

    /** Empty means "no residency constraint". */
    allowedRegions: text().array().notNull(),
    deniedRegions: text().array().notNull(),

    // ---- data handling ------------------------------------------------------

    requireZeroDataRetention: boolean().notNull(),
    prohibitTrainingOnCustomerData: boolean().notNull(),

    // ---- price ceilings -----------------------------------------------------

    /**
     * The single currency every ceiling on this version is quoted in, per-unit
     * ceilings included — they live in `inference_routing_policy_price_caps` and
     * carry no currency of their own, so "every price ceiling in one policy must
     * use the same currency" is not a rule anything has to check.
     *
     * NULL when the version sets no ceiling at all. A cap row cannot then exist:
     * its composite foreign key has nothing to match.
     */
    priceCeilingCurrency: text(),

    /** A ceiling on the whole request, as opposed to per metered unit. */
    maxPricePerRequestAmount: exactAmount(),

    // ---- selection ----------------------------------------------------------

    optimiseFor: text({ enum: ROUTING_POLICY_OPTIMISATIONS }).notNull(),

    /** Serve only from Oxy's own hosting of open-weight models. */
    oxyHostedOnly: boolean().notNull(),

    /** Empty means unconstrained. SPDX-style ids, matched against the catalogue. */
    allowedLicenseIds: text().array().notNull(),
    requireCommercialUseRights: boolean().notNull(),

    // ---- fallback -----------------------------------------------------------

    /**
     * Fail the request rather than serve it from anywhere else.
     *
     * This is one half of the composite foreign key target below: a cross-model
     * destination row carries a copy of this flag and CHECKs that it is false, so
     * "fallback disabled, and here are the models to fall back to" cannot be
     * written down.
     */
    fallbackDisabled: boolean().notNull(),

    /**
     * Move between deployments of the SAME model revision on failure.
     *
     * Distinct from cross-model fallback and safe by default: serving the same
     * weights from another endpoint is an availability decision, whereas serving
     * DIFFERENT weights is a substitution the customer must have authorised by
     * name (see `inference_routing_policy_fallbacks`).
     */
    sameModelDeploymentFallback: boolean().notNull(),

    // ---- capacity and credentials -------------------------------------------

    /** Whether the customer's own provider credentials may or must be used. */
    byokPreference: text({ enum: ROUTING_POLICY_PREFERENCES }).notNull(),

    /** Enterprise reserved capacity rather than shared endpoints. */
    dedicatedCapacity: text({ enum: ROUTING_POLICY_PREFERENCES }).notNull(),

    /** Who authored this revision. Audit only; never an authorisation input. */
    createdByUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * No `updated_at`. The absence IS the append-only contract, and the
     * immutability trigger is what enforces it against a writer that ignores the
     * convention.
     */
    createdAt: createdAt(),
  },
  (t) => [
    unique('inference_routing_policy_versions_version_key').on(t.routingPolicyId, t.version),

    /**
     * The two composite foreign key TARGETS. Both must be `unique()`
     * constraints, never `uniqueIndex()`: drizzle-kit emits every foreign key
     * before every `CREATE UNIQUE INDEX`, so an index target does not exist yet
     * when the constraint is added and the migration fails at apply time with
     * `42830`.
     */
    unique('inference_routing_policy_versions_currency_key').on(t.id, t.priceCeilingCurrency),
    unique('inference_routing_policy_versions_fallback_key').on(t.id, t.fallbackDisabled),

    /** At most one current version per policy. */
    uniqueIndex('inference_routing_policy_versions_current_key')
      .on(t.routingPolicyId)
      .where(sql`${t.isCurrent}`),

    check('inference_routing_policy_versions_version_range', sql`${t.version} >= 1`),

    check(
      'inference_routing_policy_versions_optimise_for_check',
      sql`${t.optimiseFor} in (${sql.raw(inList(ROUTING_POLICY_OPTIMISATIONS))})`
    ),
    check(
      'inference_routing_policy_versions_byok_check',
      sql`${t.byokPreference} in (${sql.raw(inList(ROUTING_POLICY_PREFERENCES))})`
    ),
    check(
      'inference_routing_policy_versions_capacity_check',
      sql`${t.dedicatedCapacity} in (${sql.raw(inList(ROUTING_POLICY_PREFERENCES))})`
    ),
    check(
      'inference_routing_policy_versions_target_kind_check',
      sql`${t.defaultTargetKind} is null or ${t.defaultTargetKind} in (${sql.raw(inList(ROUTING_POLICY_TARGET_KINDS))})`
    ),

    /**
     * The default target names exactly one thing, or nothing at all.
     *
     * Three arms rather than a pair of `is not null` clauses, because the
     * degenerate rows differ: no target is legitimate ("every request names its
     * own model"), a kind with no target is a policy that resolves to nothing,
     * and a model kind that names both a model AND a pinned revision is two
     * different defaults in one row. The inner exclusive-or is written
     * `(a is null) <> (b is null)`, which is FALSE when both are null and FALSE
     * when both are set — a CHECK rejects only FALSE, so both are refused.
     *
     * **`is not distinct from`, never `=`, because `default_target_kind` is
     * NULLABLE.** With a plain `=`, a row carrying a target but NO kind
     * evaluates every arm to FALSE or NULL, the disjunction is NULL, and a CHECK
     * rejects only FALSE — so the row is ADMITTED. That is not hypothetical: it
     * is what this constraint did on its first draft, and
     * `__tests__/inferenceRoutingPolicy.test.ts` is what caught it. `is not
     * distinct from` returns FALSE rather than NULL for a NULL left side, which
     * is the whole difference.
     */
    check(
      'inference_routing_policy_versions_target_check',
      sql`(
        ${t.defaultTargetKind} is null
        and ${t.defaultModelId} is null
        and ${t.defaultModelRevisionId} is null
        and ${t.defaultRoutingProfileId} is null
      ) or (
        ${t.defaultTargetKind} is not distinct from 'routing_profile'
        and ${t.defaultRoutingProfileId} is not null
        and ${t.defaultModelId} is null
        and ${t.defaultModelRevisionId} is null
      ) or (
        ${t.defaultTargetKind} is not distinct from 'model'
        and ${t.defaultRoutingProfileId} is null
        and ((${t.defaultModelId} is null) <> (${t.defaultModelRevisionId} is null))
      )`
    ),

    /**
     * A provider named by both lists can never be selected: the allowlist is a
     * REQUIREMENT, so the policy would refuse every route including the one it
     * demands. `&&` is array overlap and is FALSE when either side is empty, so
     * "no allowlist" and "no denylist" both pass — which is what an empty array
     * means here.
     */
    check(
      'inference_routing_policy_versions_provider_conflict',
      sql`not (${t.providerAllowlist} && ${t.providerDenylist})`
    ),
    check(
      'inference_routing_policy_versions_region_conflict',
      sql`not (${t.allowedRegions} && ${t.deniedRegions})`
    ),

    /**
     * Fallback disabled is an instruction to FAIL rather than serve elsewhere.
     * Combined with same-model failover it is not a strict policy but an
     * ambiguous one, and an ambiguity resolves differently in each executor.
     */
    check(
      'inference_routing_policy_versions_fallback_conflict',
      sql`not (${t.fallbackDisabled} and ${t.sameModelDeploymentFallback})`
    ),

    /**
     * A BYOK route runs on the customer's own upstream provider account, which
     * is by definition not Oxy's hosting.
     */
    check(
      'inference_routing_policy_versions_hosting_conflict',
      sql`not (${t.oxyHostedOnly} and ${t.byokPreference} = 'require')`
    ),

    check(
      'inference_routing_policy_versions_currency_format',
      sql`${t.priceCeilingCurrency} is null or ${currencyCodeCheck(t.priceCeilingCurrency)}`
    ),
    check(
      'inference_routing_policy_versions_request_cap_check',
      sql`${t.maxPricePerRequestAmount} is null
        or (${t.maxPricePerRequestAmount} >= 0 and ${t.priceCeilingCurrency} is not null)`
    ),

    /** "The version in force for this policy" — the resolution read. */
    index('inference_routing_policy_versions_policy_id_idx').on(t.routingPolicyId, t.version),
  ]
);

export type InferenceRoutingPolicyVersionRow =
  typeof inferenceRoutingPolicyVersions.$inferSelect;

/**
 * The one column an UPDATE may touch — superseding a version is not editing it.
 *
 * Read by `inferenceRoutingImmutability.ts`, which builds the trigger around it,
 * and by the schema test, which drives an UPDATE per column and fails naming the
 * one that stopped being refused.
 */
export const ROUTING_POLICY_VERSION_MUTABLE_COLUMN = 'is_current';
