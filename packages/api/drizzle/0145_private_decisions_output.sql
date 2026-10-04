-- oxy:deploy-phase=pre
-- Structured decisions are genuine model outputs. Request/input vocabulary is unchanged.
ALTER TABLE "inference_models" DROP CONSTRAINT "inference_models_output_modalities_check";--> statement-breakpoint
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

  IF outputs IS NOT NULL AND NOT (outputs <@ array['text', 'decisions']::text[]) THEN
    RAISE EXCEPTION 'inference_model_revisions.provenance_marking is required for a model whose output is not text-only (model %, outputs %): declare a marking, or none if it marks nothing', new.model_id, outputs
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_model_output_declares_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unmarked text;
BEGIN
  IF new.output_modalities <@ array['text', 'decisions']::text[] THEN
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
