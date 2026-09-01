-- oxy:deploy-phase=pre
--
-- Model-revision immutability (issue #972, workstream 5).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row, never the old.
-- Same shape and same reason as 0005_transparency_immutability.sql.
--
-- The authoritative text lives in the schema, as
-- `INFERENCE_REVISION_IMMUTABILITY_DDL` in
-- `src/db/schema/inferenceModelRevisions.ts`, so a regeneration of 0032 has
-- something to restore this file from -- and
-- `src/db/schema/__tests__/inferenceCatalogue.test.ts` drives an UPDATE per
-- protected column and fails naming the one that stopped being refused.
--
-- WHY `pre`: additive, and it constrains only a table 0032 has just created,
-- which no running image writes to. See 0032's header for the full argument.
--
-- WHAT IT PROTECTS, and what breaks without it. ADR 0008's central promise is
-- that a published revision id never refers to different weights:
--
--   model_id         the revision moves to a different model, so every pinned
--                    <publisher>/<model>@<revision> a customer holds now
--                    resolves elsewhere
--   revision         the same failure from the other side -- the label the
--                    customer pinned now names different weights
--   released_at      "the revision current at time T", which is how a receipt
--                    is reproduced, silently selects a different row
--   artifact_digest  the digest IS the identity of the served weights; changing
--                    it makes the record claim a provenance it does not have
--
-- Deliberately NOT protected: `is_current` (which revision an unpinned model
-- reference resolves to is a live editorial decision), `retired_at` (an event
-- that happens later by definition), `model_card_url` and the safety columns (a
-- republished model card changes nothing about the weights).
--
-- BEFORE UPDATE only: an ON DELETE guard would block the CASCADE from a model
-- delete and turn a deliberate removal into a confusing constraint failure.
--
-- ERRCODE 23514 (`check_violation`) so a caller sees what a CHECK would have
-- raised, if a CHECK could have expressed this.

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
--> statement-breakpoint
CREATE TRIGGER inference_model_revisions_identity_immutable
BEFORE UPDATE ON inference_model_revisions
FOR EACH ROW EXECUTE FUNCTION inference_model_revision_identity_immutable();
