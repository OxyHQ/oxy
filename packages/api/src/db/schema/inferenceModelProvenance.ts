/**
 * A model whose output is not text must DECLARE its content-provenance marking
 * (issue #972 workstream 12: "support content-provenance/marking metadata where a
 * modality requires it").
 *
 * ## What was already there, and the half that was missing
 *
 * `inference_model_revisions` can hold a marking — `provenanceMarking` ∈
 * `none / visible_watermark / invisible_watermark / c2pa` — and the safety object
 * it belongs to is well guarded: `inference_model_revisions_safety_is_whole`
 * makes it present or absent as a whole, so a half-filled object cannot exist.
 *
 * Nothing said WHEN it has to be present. A model that emits images, audio or
 * video could ship with the whole safety object absent, which is exactly the case
 * the requirement is about: a person cannot tell synthetic media from a recording
 * without something marking it, and "we never recorded whether this model marks
 * its output" is the answer nobody can act on later.
 *
 * ## Why this is a TRIGGER and could not be a CHECK
 *
 * The two facts live in two tables. `output_modalities` is on
 * `inference_models` — a model line's capability, deliberately not copied onto
 * every revision (see that file's header) — and `provenance_marking` is on
 * `inference_model_revisions`, because it describes SPECIFIC weights. A CHECK
 * constraint sees only its own row and can never join, so the rule is not
 * expressible as one. That is the same wall `INFERENCE_REVISION_IMMUTABILITY_DDL`
 * hit for a different reason ("a CHECK sees only the new row, never the old"), and
 * this takes the same way around it: `plpgsql`, `BEFORE` triggers, and
 * `ERRCODE = '23514'` so a caller sees `check_violation` — the SQLSTATE a CHECK
 * would have raised — and `@oxyhq/db`'s `isCheckViolation` recognises it without
 * anybody string-matching a message.
 *
 * The DDL is authoritative HERE rather than only in
 * `0050_inference_model_provenance_marking.sql`, for the reason every trigger in
 * this schema is: drizzle-kit emits tables, constraints and indexes from a schema
 * file and CANNOT emit a trigger, so regenerating a table migration would
 * silently drop it. `schema/__tests__/inferenceCatalogue.test.ts` fails naming
 * either trigger if it disappears.
 *
 * ## BOTH directions, because either alone leaves the state reachable
 *
 * 1. {@link INFERENCE_REVISION_PROVENANCE_TRIGGER_DDL} — a revision INSERTed or
 *    UPDATEd with no marking under a model whose output is not text-only.
 *    `UPDATE` as well as `INSERT`: the safety columns are deliberately NOT part
 *    of the revision immutability trigger (a republished model card changes
 *    nothing about the weights), so a marking that could be set could otherwise
 *    be un-set.
 * 2. {@link INFERENCE_MODEL_PROVENANCE_TRIGGER_DDL} — a model whose
 *    `output_modalities` is WIDENED past text while a revision of it still
 *    declares nothing. Without this, the order "create a text model, add
 *    revisions, then make it an image model" walks straight around (1).
 *
 * There is no INSERT arm on `inference_models`: a model has no revisions at the
 * moment it is inserted, so there is nothing to be inconsistent with. With those
 * two, the invariant is inductive — every transition into "an unmarked revision
 * under a non-text model" is refused, so the state is unreachable.
 *
 * ## `text` is the only exemption, and `embedding` is deliberately NOT one
 *
 * The test is `output_modalities <@ array['text']` — text-only passes, anything
 * else must declare. An embedding-output model is therefore inside the rule, which
 * is a deliberate call and worth stating: an embedding is not perceptible content
 * and cannot carry a watermark, but `none` IS a declaration and the vocabulary
 * exists to record it. The burden is one field saying "this model marks nothing",
 * not a capability. The alternative — a second modality taxonomy naming
 * image/audio/video as "the marked ones" — would be a list to keep in agreement
 * with `INFERENCE_MODALITIES` and a judgement to re-make every time a modality is
 * added, and the default it implies is the permissive one.
 *
 * ## What is NOT here
 *
 * STAMPING or VERIFYING a marking on generated content. That is the data plane's
 * work and it only matters once Oxy serves a non-text modality at all; this is
 * the catalogue refusing to hold an undeclared one. Out of scope for #972
 * workstream 12, and named so nobody reads this as the enforcement.
 */

import { textArrayLiteral } from '@oxyhq/db';

/**
 * The output modalities that need no marking declared. ONE member, and the tuple
 * exists so the DDL below and this reasoning cannot drift apart — the emitted SQL
 * renders from it.
 */
export const PROVENANCE_EXEMPT_OUTPUT_MODALITIES = ['text'] as const;

/** `array['text']::text[]`, as the DDL spells it. */
const EXEMPT_MODALITIES_SQL = textArrayLiteral(PROVENANCE_EXEMPT_OUTPUT_MODALITIES);

/**
 * Refuse a revision that declares no marking under a non-text-output model.
 *
 * Reads the model's modalities rather than trusting a copy, because there is no
 * copy. `outputs IS NULL` means the model row is not visible yet — a `BEFORE ROW`
 * trigger runs before the foreign key's own (AFTER) check — so the row is left to
 * that constraint to refuse rather than reported as a provenance problem.
 */
export const INFERENCE_REVISION_PROVENANCE_DDL = `
CREATE OR REPLACE FUNCTION inference_revision_declares_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outputs text[];
BEGIN
  IF new.provenance_marking IS NOT NULL THEN
    RETURN new;
  END IF;

  SELECT m.output_modalities INTO outputs
  FROM inference_models m
  WHERE m.id = new.model_id;

  IF outputs IS NOT NULL AND NOT (outputs <@ ${EXEMPT_MODALITIES_SQL}) THEN
    RAISE EXCEPTION 'inference_model_revisions.provenance_marking is required for a model whose output is not text-only (model %, outputs %): declare a marking, or none if it marks nothing', new.model_id, outputs
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;
`.trim();

/** The trigger itself, separated so each statement lands on its own breakpoint. */
export const INFERENCE_REVISION_PROVENANCE_TRIGGER_DDL = `
CREATE TRIGGER inference_model_revisions_declares_provenance
BEFORE INSERT OR UPDATE ON inference_model_revisions
FOR EACH ROW EXECUTE FUNCTION inference_revision_declares_provenance();
`.trim();

/**
 * Refuse widening a model's output modalities past text while a revision of it
 * declares no marking.
 *
 * The unchanged-modalities early return is not an optimisation for its own sake:
 * a model that is ALREADY non-text can only have marked revisions (the other
 * trigger refuses the rest), so re-checking them on an unrelated edit — a
 * deprecation status, a model card URL — could only ever cost a query.
 */
export const INFERENCE_MODEL_PROVENANCE_DDL = `
CREATE OR REPLACE FUNCTION inference_model_output_declares_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unmarked text;
BEGIN
  IF new.output_modalities <@ ${EXEMPT_MODALITIES_SQL} THEN
    RETURN new;
  END IF;
  IF new.output_modalities IS NOT DISTINCT FROM old.output_modalities THEN
    RETURN new;
  END IF;

  SELECT r.revision INTO unmarked
  FROM inference_model_revisions r
  WHERE r.model_id = new.id AND r.provenance_marking IS NULL
  LIMIT 1;

  IF unmarked IS NOT NULL THEN
    RAISE EXCEPTION 'inference_models.output_modalities cannot become non-text while revision % declares no provenance_marking: declare one on every revision first', unmarked
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;
`.trim();

export const INFERENCE_MODEL_PROVENANCE_TRIGGER_DDL = `
CREATE TRIGGER inference_models_output_declares_provenance
BEFORE UPDATE ON inference_models
FOR EACH ROW EXECUTE FUNCTION inference_model_output_declares_provenance();
`.trim();

/** The trigger names, so a test asserts their existence without a literal. */
export const INFERENCE_REVISION_PROVENANCE_TRIGGER_NAME =
  'inference_model_revisions_declares_provenance';

export const INFERENCE_MODEL_PROVENANCE_TRIGGER_NAME =
  'inference_models_output_declares_provenance';
