/**
 * `inference_models` — a model line, `<publisher>/<model>`.
 *
 * The second of ADR 0008's six concepts, and the one a customer writes in their
 * code. A model is a long-lived product identity whose behaviour changes as
 * revisions ship; it is NOT an artifact, which is why nothing here identifies
 * specific weights.
 *
 * ## What is deliberately NOT here
 *
 * - **Provider, region, price, availability, health.** Those belong to a
 *   DEPLOYMENT. The same model served by two providers in three regions is not
 *   one thing with attributes — retention policy, residency, commercial
 *   permission and price all differ per route, and flattening them means the
 *   catalogue cannot answer a residency question at all.
 * - **Evaluations, safety metadata and artifact digests.** Those describe
 *   specific weights, so they hang off `inference_model_revisions`.
 * - **`creditMultiplier`.** ADR 0008 retires it with the tier names: pricing
 *   attaches to a `(model reference, provider, price version)` triple, never to
 *   a multiplier on a product tier.
 *
 * ## `model_id` is GENERATED, not written
 *
 * `<publisher>/<model>` is composed by the DATABASE from the two columns it is
 * made of, so no write path — route, service, seed script or `psql` session —
 * can produce a row whose canonical id disagrees with its parts. A serializer
 * composing the same string would be bypassable in exactly the way
 * `CONVENTIONS.md` describes for a Mongoose hook, and the failure would be a
 * model id that resolves to the wrong model rather than an error.
 *
 * `text || text` is IMMUTABLE, which is what makes the expression legal in a
 * generated column at all — the same requirement that rejects `convert_to` and
 * the one-argument `to_tsvector`.
 *
 * `inference_model_revisions` does NOT get the same treatment for its
 * `<model>@<revision>` reference, and the asymmetry is not an oversight: the
 * parts of a revision reference live in two tables, and a generated column can
 * only see its own row. That reference is composed in exactly one function
 * (`composeModelReference` in `services/inferenceCatalogue.service.ts`).
 */

import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, unique, boolean } from 'drizzle-orm/pg-core';
import { createdAt, inList, textArrayLiteral, timestamptz, updatedAt, generatedId } from '@oxyhq/db';
import { inferencePublishers } from './inferencePublishers';
import { MODEL_REFERENCE_CHECK_PATTERN, SLUG_CHECK_PATTERN } from './inferenceSlug';

/**
 * The modalities a model consumes or produces. Mirrors `inferenceModalitySchema`.
 *
 * Held against the contract by `schema/__tests__/inferenceCatalogue.test.ts`,
 * which parses a fixture per value — a rename or a removal upstream goes red.
 */
export const INFERENCE_MODALITIES = ['text', 'image', 'audio', 'video', 'embedding'] as const;

export type InferenceModalityValue = (typeof INFERENCE_MODALITIES)[number];

/**
 * How a model came to exist. Mirrors `modelProvenanceSchema.releaseKind`.
 *
 * This is what stops `alia/*` becoming a re-badging namespace — see the CHECK at
 * the bottom of this file.
 */
export const MODEL_RELEASE_KINDS = [
  'first_party_original',
  'first_party_derived',
  'open_weight',
  'third_party_hosted',
] as const;

export type ModelReleaseKind = (typeof MODEL_RELEASE_KINDS)[number];

/** Deprecation state. Mirrors `modelDeprecationSchema.status`. */
export const MODEL_DEPRECATION_STATUSES = ['active', 'deprecated', 'retired'] as const;

export type ModelDeprecationStatus = (typeof MODEL_DEPRECATION_STATUSES)[number];

/**
 * The publisher namespace reserved for models Alia actually owns or derived.
 * Mirrors `RESERVED_ALIA_PUBLISHER` in `@oxyhq/contracts`.
 */
export const RESERVED_FIRST_PARTY_PUBLISHER = 'alia';

/** The two release kinds the reserved namespace may carry. */
const FIRST_PARTY_RELEASE_KINDS = ['first_party_original', 'first_party_derived'] as const;

/**
 * `<publisher>/<model>`, as SQL. Bare snake_case column names, matching the
 * generated-column expressions on `users` and `user_locations` — the expression
 * is rendered into DDL, where a drizzle Column object would emit its TypeScript
 * property name.
 *
 * `text || text` is IMMUTABLE, which is what makes this legal in a generated
 * column. `||` returns NULL if either side is NULL, but both are NOT NULL, so
 * the composed id is total.
 */
const MODEL_ID_EXPRESSION = sql.raw(`publisher_slug || '/' || slug`);

export const inferenceModels = pgTable(
  'inference_models',
  {
    id: generatedId(),

    /**
     * The publisher's namespace. A real foreign key — see the header of
     * `inferenceModels`' sibling `inferencePublishers` for why that table is
     * keyed on its slug and what it buys.
     *
     * `RESTRICT`: a publisher with models in the catalogue is not deletable.
     * `CASCADE` would silently remove every model of a publisher somebody tidied
     * away, taking their revisions and deployments with them.
     */
    publisherSlug: text()
      .notNull()
      .references(() => inferencePublishers.slug, { onDelete: 'restrict' }),

    /** The model's own segment, e.g. `gpt-5`, `llama-3.1-70b-instruct`. */
    slug: text().notNull(),

    /**
     * `<publisher>/<model>`, composed by the database. Never written; an attempt
     * fails with SQLSTATE `428C9`.
     */
    modelId: text().generatedAlwaysAs(MODEL_ID_EXPRESSION),

    displayName: text().notNull(),
    description: text(),

    /* ---- capabilities (`modelCapabilitiesSchema`) ------------------------ */

    /**
     * Native arrays rather than child tables: at most five values, never queried
     * by element, and the closed set is enforced by a containment CHECK.
     */
    inputModalities: text().array().notNull(),
    outputModalities: text().array().notNull(),

    supportsTools: boolean().notNull(),
    supportsParallelToolCalls: boolean().notNull(),
    supportsStructuredOutput: boolean().notNull(),
    supportsJsonMode: boolean().notNull(),
    supportsReasoning: boolean().notNull(),
    supportsStreaming: boolean().notNull(),
    supportsPromptCaching: boolean().notNull(),
    maxContextTokens: integer().notNull(),
    maxOutputTokens: integer().notNull(),

    /* ---- licence (`modelLicenseSchema`) ---------------------------------- */

    /** SPDX identifier where one exists, otherwise the publisher's own name. */
    licenseId: text().notNull(),
    licenseDisplayName: text().notNull(),
    licenseUrl: text(),
    /**
     * The two questions that decide whether Oxy may serve this to third parties
     * at all. NOT NULL on purpose: "we do not know whether commercial use is
     * permitted" must be answered before a model is in the catalogue, not
     * defaulted to the permissive reading.
     */
    commercialUseAllowed: boolean().notNull(),
    requiresAttribution: boolean().notNull(),
    acceptableUsePolicyUrl: text(),

    /**
     * Whether a DERIVED model's name or distribution must attribute the base
     * model (workstream 11). Distinct from `requires_attribution`, which is
     * about serving the model at all — some open-weight licences additionally
     * constrain what a fine-tune may be CALLED.
     *
     * Not part of the customer-safe projection: it is a fact the catalogue and
     * legal review read, and `@oxyhq/contracts`' `modelLicenseSchema` is
     * `.strict()`, so it cannot be added to the wire without a contracts change.
     */
    baseModelAttributionRequired: boolean().notNull().default(false),

    /* ---- provenance (`modelProvenanceSchema`) ---------------------------- */

    releaseKind: text({ enum: MODEL_RELEASE_KINDS }).notNull(),
    /**
     * The model this one was derived from, as a canonical reference. A plain
     * string, not a foreign key: a base model is frequently one Oxy does not
     * serve and therefore does not hold a row for, and refusing to record a
     * derived model's provenance because its parent is absent would lose exactly
     * the fact that matters for attribution.
     */
    baseModelReference: text(),
    trainingOrganization: text(),

    /* ---- dates (`inferenceDateSchema` — calendar days, not instants) ----- */

    /**
     * `date`, not `timestamptz`: a knowledge cutoff and a release date are
     * published as DAYS, and inventing a timezone for them makes two records of
     * the same published fact compare unequal. The schema-invariant gate
     * forbids `timestamp without time zone`, which this is not.
     */
    knowledgeCutoff: date(),
    releasedOn: date(),

    /* ---- deprecation (`modelDeprecationSchema`) -------------------------- */

    deprecationStatus: text({ enum: MODEL_DEPRECATION_STATUSES }).notNull().default('active'),
    /**
     * Where a customer should go instead. A plain reference for the same reason
     * as `base_model_reference`: the replacement may be a model from a different
     * publisher that this catalogue has not taken on yet.
     */
    replacementModelReference: text(),
    deprecationAnnouncedAt: timestamptz(),
    deprecationSunsetAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * One model per `(publisher, slug)`. This is what makes the generated
     * `model_id` unique too, without a second index over a derived value.
     */
    unique('inference_models_publisher_slug_key').on(t.publisherSlug, t.slug),

    check('inference_models_slug_format', sql`${t.slug} ~ ${sql.raw(SLUG_CHECK_PATTERN)}`),

    /* ---- capability bounds ---------------------------------------------- */

    /**
     * `cardinality`, never `array_length` — `array_length(col, 1)` is NULL on an
     * empty array and a CHECK rejects only FALSE, so `>= 1` would ADMIT `{}`.
     * Membership and cardinality are always two constraints, so both appear.
     */
    check(
      'inference_models_input_modalities_check',
      sql`cardinality(${t.inputModalities}) >= 1 and ${t.inputModalities} <@ ${sql.raw(textArrayLiteral(INFERENCE_MODALITIES))}`
    ),
    check(
      'inference_models_output_modalities_check',
      sql`cardinality(${t.outputModalities}) >= 1 and ${t.outputModalities} <@ ${sql.raw(textArrayLiteral(INFERENCE_MODALITIES))}`
    ),
    check(
      'inference_models_token_limits_check',
      sql`${t.maxContextTokens} > 0 and ${t.maxOutputTokens} > 0`
    ),

    /* ---- closed value sets ---------------------------------------------- */

    check(
      'inference_models_release_kind_check',
      sql`${t.releaseKind} in (${sql.raw(inList(MODEL_RELEASE_KINDS))})`
    ),
    check(
      'inference_models_deprecation_status_check',
      sql`${t.deprecationStatus} in (${sql.raw(inList(MODEL_DEPRECATION_STATUSES))})`
    ),

    /* ---- reference formats ---------------------------------------------- */

    check(
      'inference_models_base_model_reference_format',
      sql`${t.baseModelReference} is null or ${t.baseModelReference} ~ ${sql.raw(MODEL_REFERENCE_CHECK_PATTERN)}`
    ),
    check(
      'inference_models_replacement_reference_format',
      sql`${t.replacementModelReference} is null or ${t.replacementModelReference} ~ ${sql.raw(MODEL_REFERENCE_CHECK_PATTERN)}`
    ),

    /**
     * An ACTIVE model has no sunset date, mirroring `modelDeprecationSchema`.
     * Written as an implication rather than a biconditional: a `deprecated`
     * model whose sunset date is not decided yet is a real and common state, so
     * requiring one in the other direction would refuse a legitimate row.
     */
    check(
      'inference_models_active_has_no_sunset',
      sql`not (${t.deprecationStatus} = 'active' and ${t.deprecationSunsetAt} is not null)`
    ),

    /**
     * **The `alia/*` reservation, in the database.**
     *
     * ADR 0008: the first-party namespace is reserved for models Alia actually
     * owns or derived — never a provider alias, a prompt configuration or a
     * product tier. A model published under it makes a PROVENANCE claim, so an
     * Oxy name on somebody else's weights is worse than a wrong third-party
     * name, not merely untidy.
     *
     * Expressible as a one-row CHECK only because `publisher_slug` is a real
     * column here rather than a join away — which is the whole reason
     * `inference_publishers` is keyed on its slug.
     *
     * An implication, not a biconditional: a first-party release kind under
     * ANOTHER publisher's namespace is legitimate (a model Alia derived and
     * published under a partner's name), so this constrains one direction only.
     */
    check(
      'inference_models_reserved_namespace_is_first_party',
      sql`not (${t.publisherSlug} = ${sql.raw(`'${RESERVED_FIRST_PARTY_PUBLISHER}'`)} and ${t.releaseKind} not in (${sql.raw(inList(FIRST_PARTY_RELEASE_KINDS))}))`
    ),

    /** The catalogue's own read: every model of one publisher. */
    index('inference_models_publisher_slug_idx').on(t.publisherSlug),
    /**
     * Resolving a customer's pinned `<publisher>/<model>` string in one hop.
     * An index over a GENERATED column is ordinary — the value is stored.
     */
    index('inference_models_model_id_idx').on(t.modelId),
  ]
);

export type InferenceModelRow = typeof inferenceModels.$inferSelect;
