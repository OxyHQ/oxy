-- oxy:deploy-phase=pre
--
-- A model whose output is not text must DECLARE a content-provenance marking
-- (#972 workstream 12: "support content-provenance/marking metadata where a
-- modality requires it").
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and indexes
-- from a schema file; it cannot emit a trigger, and this rule cannot be a CHECK
-- for a second reason besides: the two facts live in two tables.
-- `output_modalities` is a MODEL LINE's capability on `inference_models`, and
-- `provenance_marking` describes SPECIFIC weights so it lives on
-- `inference_model_revisions`. A CHECK sees only its own row and can never join.
--
-- The authoritative text lives in the schema, as
-- `INFERENCE_REVISION_PROVENANCE_DDL` / `INFERENCE_MODEL_PROVENANCE_DDL` in
-- `src/db/schema/inferenceModelProvenance.ts`, so a regeneration of the table
-- migrations has something to restore this file from — and
-- `src/db/schema/__tests__/inferenceCatalogue.test.ts` fails naming the missing
-- trigger, AND compares this file against those constants, so the two cannot
-- drift. Same arrangement as `0036_inference_revision_immutability.sql` and
-- `0043_application_credential_audit_immutability.sql`.
--
-- WHAT IT REFUSES
--
-- The revision's safety object was already present-or-absent as a WHOLE
-- (`inference_model_revisions_safety_is_whole`). Nothing said WHEN it must be
-- present, so a model emitting images, audio or video could ship with the whole
-- object absent — which is the case the requirement is about, since a person
-- cannot tell synthetic media from a recording without something marking it.
--
-- BOTH directions, because either alone leaves the state reachable:
--
--   1. a revision INSERTed or UPDATEd with no marking under a model whose output
--      is not text-only. `UPDATE` too: the safety columns are deliberately NOT
--      part of the revision immutability trigger (0036), so a marking that can be
--      set could otherwise be un-set.
--   2. a model whose `output_modalities` is WIDENED past text while a revision of
--      it still declares nothing. Without this, "create a text model, add
--      revisions, then make it an image model" walks straight around (1).
--
-- No INSERT arm on `inference_models`: a model has no revisions at the moment it
-- is inserted. With those two the invariant is inductive — every transition INTO
-- "an unmarked revision under a non-text model" is refused, so the state is
-- unreachable.
--
-- `text` is the only exemption and `embedding` is deliberately inside the rule:
-- an embedding cannot carry a watermark, but `none` IS a declaration and the
-- vocabulary exists to record it, so the burden is one field rather than a
-- capability. The alternative — naming image/audio/video as "the marked ones" —
-- would be a second taxonomy to keep in agreement with `INFERENCE_MODALITIES` and
-- would default to the permissive reading. The full argument is in the schema
-- module.
--
-- WHY `pre`
--
-- The test is whether a RUNNING IMAGE writes a value this migration forbids.
-- Nothing in any image writes these two tables at all: `insert(inferenceModels)`
-- and `insert(inferenceModelRevisions)` appear nowhere outside `__tests__`, every
-- other reference is a SELECT or a join, and `scripts/seed-inference-catalogue.ts`
-- seeds publishers ONLY — its own header explains that a model cannot be seeded
-- without a capability sheet and a licence nobody has recorded. Production
-- confirms it: `inference_models` and `inference_model_revisions` are both 0 rows
-- (counted read-only against task definition `oxy-oxy-api:206`, beside controls
-- `users 69465` and, at the time of the count, `migrations_applied 47` — the whole
-- chain through `0047` — so a zero cannot be an empty or unmigrated database). So
-- nothing existing violates this and nothing writing violates it, which puts it in
-- `pre`.
--
-- `pre` is also the safer side: a zero-capacity deploy exits before the
-- post-deploy migration step entirely, and a skipped `post` never lands later —
-- every subsequent `pre` queues behind it until somebody unblocks it by hand.
--
-- NO BACK-FILL, because there is nothing to back-fill. Both tables are empty
-- everywhere, and the constraint admits every row a text-only model has.
--
-- `SQLSTATE 23514` (check_violation) rather than a bespoke code, so
-- `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
-- failure — a caller must never have to string-match a message.
--
-- STAMPING or VERIFYING a marking on generated content is NOT here. That is the
-- data plane's work and only matters once Oxy serves a non-text modality; this is
-- the catalogue refusing to hold an undeclared one.

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

  IF outputs IS NOT NULL AND NOT (outputs <@ array['text']::text[]) THEN
    RAISE EXCEPTION 'inference_model_revisions.provenance_marking is required for a model whose output is not text-only (model %, outputs %): declare a marking, or none if it marks nothing', new.model_id, outputs
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_model_revisions_declares_provenance
BEFORE INSERT OR UPDATE ON inference_model_revisions
FOR EACH ROW EXECUTE FUNCTION inference_revision_declares_provenance();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_model_output_declares_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unmarked text;
BEGIN
  IF new.output_modalities <@ array['text']::text[] THEN
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
--> statement-breakpoint
CREATE TRIGGER inference_models_output_declares_provenance
BEFORE UPDATE ON inference_models
FOR EACH ROW EXECUTE FUNCTION inference_model_output_declares_provenance();
