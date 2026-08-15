/**
 * `inference_model_revisions` — an IMMUTABLE released version of a model.
 *
 * The third of ADR 0008's six concepts, and the one the ADR's central promise
 * rests on: *once published, a revision id never refers to different weights.*
 * A behaviour change ships as a new revision; it never mutates an existing one.
 *
 * Evaluation results, safety metadata and artifact digests hang here rather than
 * on the model, because they describe SPECIFIC weights. An eval score attached
 * to a model line would silently become a claim about whatever shipped last.
 *
 * ## Immutability is enforced by a trigger, not by convention
 *
 * A CHECK constraint sees only the new row, never the old, so it cannot express
 * "this column may not change". The mechanism is therefore a `BEFORE UPDATE`
 * trigger — the same shape `transparency_checkpoints` already uses, and for a
 * related reason: something downstream has committed to the value.
 *
 * The authoritative text is {@link INFERENCE_REVISION_IMMUTABILITY_DDL} in this
 * file, so a regeneration of the table migration has something to restore the
 * hand-written migration from, and `schema/__tests__/inferenceCatalogue.test.ts`
 * fails naming the trigger if it is ever dropped.
 *
 * What it protects, and why each one:
 *
 * | column | what breaks if it changes |
 * |---|---|
 * | `model_id` | the revision moves to a different model; every pinned `<publisher>/<model>@<revision>` a customer holds now resolves elsewhere |
 * | `revision` | the same, from the other side — the label a customer pinned now names different weights |
 * | `released_at` | reproducing a receipt against "the revision current at time T" silently picks a different row |
 * | `artifact_digest` | the digest is the identity of the served weights; changing it makes the record claim provenance it does not have |
 *
 * `is_current`, `retired_at`, `model_card_url` and the safety columns are
 * deliberately NOT protected: which revision a bare `<publisher>/<model>`
 * resolves to is a live editorial decision, retirement is an event that happens
 * later, and a model card being republished at a new URL changes nothing about
 * the weights.
 *
 * `BEFORE UPDATE` only — an `ON DELETE` guard would block the CASCADE from a
 * model delete and turn a deliberate removal into a confusing constraint error.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { inferenceModels } from './inferenceModels';
import { REVISION_CHECK_PATTERN } from './inferenceSlug';

/** Default content filtering. Mirrors `modelSafetyMetadataSchema`. */
export const CONTENT_FILTERING_DEFAULTS = ['none', 'provider_default', 'strict'] as const;

export type ContentFilteringDefault = (typeof CONTENT_FILTERING_DEFAULTS)[number];

/** Content-provenance marking. Mirrors `modelSafetyMetadataSchema`. */
export const PROVENANCE_MARKINGS = [
  'none',
  'visible_watermark',
  'invisible_watermark',
  'c2pa',
] as const;

export type ProvenanceMarking = (typeof PROVENANCE_MARKINGS)[number];

export const inferenceModelRevisions = pgTable(
  'inference_model_revisions',
  {
    id: generatedId(),

    /**
     * The model line this is a version of.
     *
     * `CASCADE`: a model removed from the catalogue takes its revisions with it.
     * That is safe here in a way it would not be for a receipt, because nothing
     * financial references this table — the ledger's `price_versions` stores
     * `model_reference` as plain TEXT precisely so a settled receipt stays
     * reproducible after a catalogue row is gone (agreed with the ledger's
     * owner; see that table's header).
     */
    modelId: text()
      .notNull()
      .references(() => inferenceModels.id, { onDelete: 'cascade' }),

    /** The immutable label, e.g. `2026-05-01`. Case-PRESERVING. */
    revision: text().notNull(),

    /**
     * Whether a bare `<publisher>/<model>` resolves here.
     *
     * A boolean with a PARTIAL UNIQUE INDEX rather than a `current_revision_id`
     * column on `inference_models`, which would be a circular foreign key
     * between the two tables — a real cost (`CONVENTIONS.md` requires verifying
     * any circular FK against `pg_constraint`, because drizzle has silently
     * dropped one) for no gain. The database enforces AT MOST ONE current
     * revision per model either way.
     *
     * There is deliberately no constraint requiring at least one: a model whose
     * revisions are all retired has none, and the catalogue read treats "no
     * current revision" as not servable. That is the default-deny reading.
     */
    isCurrent: boolean().notNull().default(false),

    releasedAt: timestamptz().notNull(),
    /** Set when the revision stops being servable. NULL while it is live. */
    retiredAt: timestamptz(),

    /**
     * Digest of the served artifact, where Oxy hosts the weights itself.
     * `sha256:<64 lowercase hex>`, matching `modelRevisionSchema`.
     */
    artifactDigest: text(),
    modelCardUrl: text(),

    /* ---- safety metadata (`modelSafetyMetadataSchema`, optional as a whole) */

    /**
     * The DISCRIMINANT for the optional safety object: NULL means the revision
     * carries no safety metadata at all. See the biconditional CHECK below —
     * the two required fields of that object are present together or absent
     * together, so a half-filled object cannot exist.
     */
    contentFilteringDefault: text({ enum: CONTENT_FILTERING_DEFAULTS }),
    provenanceMarking: text({ enum: PROVENANCE_MARKINGS }),
    safetyCardUrl: text(),
    /**
     * Absent is NULL, never `'{}'` — `CONVENTIONS.md`: `default: undefined` on an
     * array means absent, which is a nullable column with NO default, and an
     * empty array is a different value from "not recorded".
     */
    knownLimitations: text().array(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** One revision label per model. The pin `<model>@<revision>` is definite. */
    unique('inference_model_revisions_model_id_revision_key').on(t.modelId, t.revision),

    check(
      'inference_model_revisions_revision_format',
      sql`${t.revision} ~ ${sql.raw(REVISION_CHECK_PATTERN)}`
    ),
    check(
      'inference_model_revisions_artifact_digest_format',
      sql`${t.artifactDigest} is null or ${t.artifactDigest} ~ ${sql.raw(String.raw`'^sha256:[a-f0-9]{64}$'`)}`
    ),

    /**
     * At most one current revision per model.
     *
     * A partial unique index, so the many rows with `is_current = false` do not
     * collide with one another. `uniqueIndex().where(...)` is the sanctioned
     * shape for a Mongo `partialFilterExpression`; here there was no Mongo
     * original, but it is the same tool for the same job.
     */
    uniqueIndex('inference_model_revisions_one_current_per_model')
      .on(t.modelId)
      .where(sql`${t.isCurrent}`),

    /**
     * The safety object is present or absent as a WHOLE.
     *
     * A biconditional is right here, unusually — `contentFilteringDefault` and
     * `provenanceMarking` are both REQUIRED fields of `modelSafetyMetadataSchema`,
     * so one without the other is not a partially-known state, it is an object
     * that would fail to serialize. The optional members of that object
     * (`safetyCardUrl`, `knownLimitations`) are not part of the test.
     */
    check(
      'inference_model_revisions_safety_is_whole',
      sql`(${t.contentFilteringDefault} is null) = (${t.provenanceMarking} is null)`
    ),
    check(
      'inference_model_revisions_content_filtering_check',
      sql`${t.contentFilteringDefault} is null or ${t.contentFilteringDefault} in (${sql.raw(inList(CONTENT_FILTERING_DEFAULTS))})`
    ),
    check(
      'inference_model_revisions_provenance_marking_check',
      sql`${t.provenanceMarking} is null or ${t.provenanceMarking} in (${sql.raw(inList(PROVENANCE_MARKINGS))})`
    ),

    /**
     * A retired revision cannot have been retired before it was released. Not a
     * pedantic bound: `released_at` is what "the revision current at time T"
     * resolves against, and an inverted pair makes that question unanswerable.
     */
    check(
      'inference_model_revisions_retired_after_released',
      sql`${t.retiredAt} is null or ${t.retiredAt} > ${t.releasedAt}`
    ),

    /** "Every revision of this model, newest first" — the catalogue's own read. */
    index('inference_model_revisions_model_id_released_at_idx').on(t.modelId, t.releasedAt),
  ]
);

export type InferenceModelRevisionRow = typeof inferenceModelRevisions.$inferSelect;

/**
 * The immutability trigger, as DDL.
 *
 * Lives in the schema — not only in `drizzle/00xx_inference_catalogue.sql` —
 * because drizzle-kit emits tables, constraints and indexes from a schema file
 * and CANNOT emit a trigger. Regenerating the table migration would otherwise
 * silently drop it, and nothing re-verifies a stored revision on read: the
 * failure would be a customer's pinned revision quietly resolving to different
 * weights, with no error anywhere.
 *
 * `RAISE ... USING ERRCODE = '23514'` so a caller sees `check_violation`, the
 * same SQLSTATE a CHECK would have produced if a CHECK could express this.
 */
export const INFERENCE_REVISION_IMMUTABILITY_DDL = `
CREATE OR REPLACE FUNCTION inference_model_revision_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN new.model_id IS DISTINCT FROM old.model_id THEN 'model_id'
    WHEN new.revision IS DISTINCT FROM old.revision THEN 'revision'
    WHEN new.released_at IS DISTINCT FROM old.released_at THEN 'released_at'
    WHEN new.artifact_digest IS DISTINCT FROM old.artifact_digest THEN 'artifact_digest'
    ELSE null
  END;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'inference_model_revisions.% is immutable: a published revision always names the same weights, and customers pin it', changed
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END;
$$;
`.trim();

/** The trigger itself, separated so each statement lands on its own breakpoint. */
export const INFERENCE_REVISION_IMMUTABILITY_TRIGGER_DDL = `
CREATE TRIGGER inference_model_revisions_identity_immutable
BEFORE UPDATE ON inference_model_revisions
FOR EACH ROW EXECUTE FUNCTION inference_model_revision_identity_immutable();
`.trim();

/** The trigger's name, so a test can assert its existence without a literal. */
export const INFERENCE_REVISION_IMMUTABILITY_TRIGGER_NAME =
  'inference_model_revisions_identity_immutable';

/**
 * The columns the trigger refuses to change, as SQL names.
 *
 * Read by the schema test, which drives an UPDATE per column and asserts each
 * is rejected — so adding a column here without adding it to the DDL fails, and
 * removing one from the DDL without removing it here fails too. Neither half
 * can drift alone.
 */
export const INFERENCE_REVISION_IMMUTABLE_COLUMNS = [
  'model_id',
  'revision',
  'released_at',
  'artifact_digest',
] as const;
