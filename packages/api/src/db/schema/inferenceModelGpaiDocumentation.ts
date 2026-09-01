/**
 * `inference_model_gpai_documentation` — the EU AI Act / GPAI documentation
 * record for ONE model revision (issue #972 §12).
 *
 * The catalogue already held six of the things §12 names — model card, licence,
 * provenance and base model, evaluation results, safety results, artifact digest.
 * What it held nothing of was the documentation set that makes a first-party
 * release DOCUMENTED in the sense Regulation (EU) 2024/1689 uses the word: what
 * the model is for, what it is built out of, how much compute and energy went
 * into it, where the training-content summary and the copyright policy are, and
 * whether it carries the systemic-risk classification.
 *
 * Field-by-field, each column names the obligation it serves.
 * `@oxyhq/contracts`' `inference/modelDocumentation.ts` carries the same mapping
 * for the wire shape; this file is the storage half.
 *
 * ## It hangs off the REVISION, and it is 1:1 with it
 *
 * Architecture, parameter count, training compute, training time and energy all
 * describe SPECIFIC WEIGHTS, so they belong beside `artifact_digest` and the
 * evaluation results rather than on the model line — the same argument
 * `inference_model_evaluations` makes. Attached to a model, "4.2e25 FLOP" would
 * silently become a claim about whatever shipped last.
 *
 * A separate table rather than fourteen columns on `inference_model_revisions`,
 * for two reasons that both point the same way. The object is optional AS A
 * WHOLE, and here the row's own existence expresses that — so unlike the safety
 * object, which needed
 * `inference_model_revisions_safety_is_whole` to stop a half-filled version
 * existing, no discriminant column is required. And the catalogue's hot listing
 * read (`listCatalogueForViewer`) selects every revision of every model in one
 * query; widening that row by fourteen columns to carry documentation the listing
 * does not serve would be paid on every `GET /models`.
 *
 * ## Mutable, unlike the revision it describes — and that is Article 51
 *
 * `inference_model_revisions` protects `model_id`, `revision`, `released_at` and
 * `artifact_digest` with a trigger, because customers pin a revision. This table
 * has no such trigger, deliberately: the Commission may designate a model as
 * carrying systemic risk AFTER it was released (Article 51(1)(b)), and a
 * republished copyright policy or training-content summary moves. That is the same
 * call `inference_model_revisions` already made for `model_card_url` — "a model
 * card being republished at a new URL changes nothing about the weights".
 *
 * What is NOT kept is a HISTORY of the documentation. `recorded_at` and
 * `recorded_by_user_id` say who last stated this and when; the previous statement
 * is gone. That is a real limit and it is named rather than implied: the
 * immutable thing in this schema is the REVISION, and documentation about it is
 * republished. A workflow that needs the earlier text needs an append-only
 * documentation table, which this is not.
 *
 * ## Every conditional in the contract is ALSO a CHECK here
 *
 * Article 53(2) exempts a free-and-open-source release that is not a
 * systemic-risk model from the Annex XI/XII documentation set; it does not exempt
 * Article 53(1)(c) or (d). Article 51(2)'s presumption IS a compute figure.
 * Article 55(1)(a) applies to every systemic-risk model. All four are properties
 * of ONE row, so all four are expressible as CHECK constraints, and they are —
 * the zod refinement is the readable message and the constraint is the control.
 * A compliance record whose only guard is the route that writes it is a
 * compliance record one `psql` session away from being inconsistent.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { users } from './users';

/**
 * Annex XI §1(4) / Annex XII §1(a), "methods of distribution". Mirrors
 * `modelDistributionMethodSchema`.
 *
 * Held against the contract by `schema/__tests__/inferenceModelDocumentation.test.ts`,
 * which parses a fixture per value — a rename or a removal upstream goes red.
 */
export const MODEL_DISTRIBUTION_METHODS = ['oxy_api', 'downloadable_weights'] as const;

export type ModelDistributionMethodValue = (typeof MODEL_DISTRIBUTION_METHODS)[number];

/** Article 51. Mirrors `modelSystemicRiskTierSchema`. */
export const MODEL_SYSTEMIC_RISK_TIERS = [
  'not_designated',
  'presumed_by_training_compute',
  'designated_by_commission',
] as const;

export type ModelSystemicRiskTierValue = (typeof MODEL_SYSTEMIC_RISK_TIERS)[number];

/**
 * Article 51(2)'s presumption threshold in floating point operations, as SQL.
 *
 * Mirrors `SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS`; the test holds the two equal.
 * Spelled `1e25` rather than the digits so the constraint reads as the Act does.
 */
export const SYSTEMIC_RISK_COMPUTE_THRESHOLD_SQL = '1e25';

/**
 * `training_compute_flops`' format, as a Postgres ARE pattern. Mirrors
 * `trainingComputeFlopsSchema`.
 *
 * Load-bearing beyond validation: the threshold CHECK below CASTS this column to
 * `double precision`, and a value this pattern rejects would make that cast raise
 * `22P02` from inside a constraint. See that constraint for how the ordering is
 * forced.
 */
const TRAINING_COMPUTE_CHECK_PATTERN = String.raw`'^(0|[1-9][0-9]*)(\.[0-9]+)?(e\+?(0|[1-9][0-9]?))?$'`;

export const inferenceModelGpaiDocumentation = pgTable(
  'inference_model_gpai_documentation',
  {
    id: generatedId(),

    /**
     * The revision this documents.
     *
     * `CASCADE`, like `inference_model_evaluations`: documentation for a revision
     * that no longer exists describes nothing, and there is no independent
     * subject left to attach it to.
     */
    modelRevisionId: text()
      .notNull()
      .references(() => inferenceModelRevisions.id, { onDelete: 'cascade' }),

    /* ---- served to downstream developers (Annex XII + Art 53(1)(c),(d)) --- */

    /** Annex XI §1(2), Annex XII §1(a): the tasks the model is intended for. */
    intendedTasks: text(),
    /**
     * Annex XI §1(4), Annex XII §1(a). A native array: two possible values,
     * never queried by element, closed set enforced by a containment CHECK.
     */
    distributionMethods: text().array().notNull(),
    /** Annex XI §1(5): the architecture. */
    architecture: text(),
    /**
     * Annex XI §1(5): the number of parameters.
     *
     * `bigint`, because `integer` tops out at 2.1e9 and a parameter count passed
     * that years ago. `mode: 'number'` so drizzle's RESULT MAPPER converts the
     * `int8` the driver hands back as a string — that conversion is the mapper's,
     * so a raw `db.execute` over this column would still see a string.
     */
    parameterCount: bigint({ mode: 'number' }),
    /** Article 53(1)(d): the publicly available summary of training content. */
    trainingDataSummaryUrl: text().notNull(),
    /**
     * Article 53(1)(c): the policy for complying with Union copyright law,
     * including the Article 4(3) Directive (EU) 2019/790 rights reservation.
     * `NOT NULL` — Article 53(2)'s exemption does not reach it.
     */
    copyrightPolicyUrl: text().notNull(),
    /** Article 51. */
    systemicRisk: text({ enum: MODEL_SYSTEMIC_RISK_TIERS }).notNull(),
    /**
     * Whether the release is free and open-source in the sense of Article 53(2).
     * Distinct from `inference_models.commercial_use_allowed`, which answers
     * whether OXY may serve the model: a licence can permit commercial use and
     * still not permit access, modification and redistribution of the weights,
     * and it is the second question the exemption turns on.
     */
    freeAndOpenSourceRelease: boolean().notNull(),

    /* ---- PROTECTED: Annex XI §2 and Article 55(1)(a) --------------------- */

    /**
     * Annex XI §2(b): the computational resources used for training.
     *
     * TEXT, for the reason `inference_model_evaluations.score` is text and one
     * more besides: this is a published figure well outside the
     * exactly-representable integer range, and `numeric` would invent a precision
     * nobody claimed. The one comparison made of it is a magnitude test against
     * Article 51(2)'s threshold, which the CHECK below performs on a cast.
     *
     * In `protectedColumns.ts`: Annex XI Section 2 is documentation for the AI
     * Office and national competent authorities, not for downstream providers.
     */
    trainingComputeFlops: text(),
    /** Annex XI §2(b): the training time. PROTECTED. */
    trainingTimeHours: doublePrecision(),
    /** Annex XI §2(c): the known or estimated energy consumption. PROTECTED. */
    energyConsumptionMwh: doublePrecision(),
    /**
     * Article 55(1)(a): the model evaluation including adversarial testing.
     * A POINTER; the catalogue holds no report. PROTECTED.
     */
    adversarialTestingReportUrl: text(),

    /* ---- who stated this, and when --------------------------------------- */

    recordedAt: timestamptz().notNull(),
    /**
     * The staff member who last stated this documentation.
     *
     * `SET NULL`, matching `inference_deployments.permission_state_changed_by_user_id`:
     * the record must survive that person's account being erased, and the
     * alternative — deleting the documentation — would let an erasure request
     * silently take a compliance record with it.
     */
    recordedByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * ONE documentation record per revision. This is what makes the object's
     * whole-or-absent optionality the row's own existence, so no discriminant
     * column is needed — and it is also the lookup index for every read.
     */
    unique('inference_model_gpai_documentation_model_revision_id_key').on(t.modelRevisionId),

    /**
     * `cardinality`, never `array_length` — `array_length(col, 1)` is NULL on an
     * empty array and a CHECK rejects only FALSE, so `>= 1` would ADMIT `{}`.
     */
    check(
      'inference_model_gpai_documentation_distribution_methods_check',
      sql`cardinality(${t.distributionMethods}) >= 1 and ${t.distributionMethods} <@ ${sql.raw(textArrayLiteral(MODEL_DISTRIBUTION_METHODS))}`
    ),
    check(
      'inference_model_gpai_documentation_systemic_risk_check',
      sql`${t.systemicRisk} in (${sql.raw(inList(MODEL_SYSTEMIC_RISK_TIERS))})`
    ),
    check(
      'inference_model_gpai_documentation_training_compute_format',
      sql`${t.trainingComputeFlops} is null or ${t.trainingComputeFlops} ~ ${sql.raw(TRAINING_COMPUTE_CHECK_PATTERN)}`
    ),

    /**
     * **Article 53(2), as a constraint.**
     *
     * The Annex XI set is required of every release EXCEPT a free-and-open-source
     * one that is not a model with systemic risk — and that carve-out is the
     * Act's own: Article 53(2) says the exemption does not apply to systemic-risk
     * models. Written as a disjunction so the exempt state is the readable
     * left-hand side rather than a negated pile.
     */
    check(
      'inference_model_gpai_documentation_annex_xi_or_exempt',
      sql`(${t.freeAndOpenSourceRelease} and ${t.systemicRisk} = 'not_designated') or (${t.intendedTasks} is not null and ${t.architecture} is not null and ${t.parameterCount} is not null and ${t.trainingTimeHours} is not null and ${t.energyConsumptionMwh} is not null)`
    ),

    /**
     * Article 51(2): the presumption IS the compute figure. Declaring the tier
     * without it asserts a threshold was crossed while withholding the only thing
     * that says so.
     */
    check(
      'inference_model_gpai_documentation_presumption_has_compute',
      sql`${t.systemicRisk} <> 'presumed_by_training_compute' or ${t.trainingComputeFlops} is not null`
    ),

    /**
     * The other direction, and the one a record could otherwise contradict
     * itself in: compute at or above 10^25 FLOP cannot sit beside
     * `not_designated`.
     *
     * A `CASE`, not an `and`, and that is not stylistic. Postgres does not define
     * the evaluation order of `AND` subexpressions, and the format CHECK above is
     * a SEPARATE constraint whose order relative to this one is likewise
     * undefined — so a malformed value could reach `::double precision` and raise
     * `22P02` from inside a constraint instead of the `23514` a caller handles.
     * `CASE` guarantees its branches are evaluated in order, which makes the
     * format test a genuine guard for the cast rather than a hope about the
     * planner.
     */
    check(
      'inference_model_gpai_documentation_compute_matches_risk',
      sql`${t.trainingComputeFlops} is null or case when ${t.trainingComputeFlops} ~ ${sql.raw(TRAINING_COMPUTE_CHECK_PATTERN)} then not (${t.trainingComputeFlops}::double precision >= ${sql.raw(SYSTEMIC_RISK_COMPUTE_THRESHOLD_SQL)} and ${t.systemicRisk} = 'not_designated') else false end`
    ),

    /** Article 55(1)(a), for every systemic-risk model however classified. */
    check(
      'inference_model_gpai_documentation_systemic_risk_has_report',
      sql`${t.systemicRisk} = 'not_designated' or ${t.adversarialTestingReportUrl} is not null`
    ),
  ]
);

export type InferenceModelGpaiDocumentationRow =
  typeof inferenceModelGpaiDocumentation.$inferSelect;

/**
 * The Annex XI Section 2 / Article 55(1)(a) columns, as TypeScript property
 * names.
 *
 * Read by `protectedColumns.ts` and by the schema test, so the set that is
 * withheld from the customer projection is stated once. A column added to the
 * internal group without being added here would silently become customer-visible.
 */
export const GPAI_DOCUMENTATION_INTERNAL_COLUMNS = [
  'trainingComputeFlops',
  'trainingTimeHours',
  'energyConsumptionMwh',
  'adversarialTestingReportUrl',
] as const;
