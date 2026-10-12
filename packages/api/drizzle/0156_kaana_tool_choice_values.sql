-- oxy:deploy-phase=pre
--
-- Tool-choice values in the per-route accepted-parameter vocabulary
-- (OxyHQ/Kaana#168): `toolChoice.none`, `toolChoice.required` and
-- `toolChoice.function` state which values of `toolChoice` a route takes, so
-- a route that refuses only a FORCED choice (Claude Fable 5.1, Opus 5.5,
-- Sonnet 5.5) still serves `auto` and `none`.
--
-- PRE: a widened CHECK. Every existing row satisfies it (the old vocabulary is
-- a subset), the image still serving writes only old words, and the arriving
-- one may write the new ones. `inference_deployments` is a small catalogue
-- table, so the CHECK is validated in place.
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_accepted_parameters_check";--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_accepted_parameters_check" CHECK ("inference_deployments"."accepted_parameters" is null or "inference_deployments"."accepted_parameters" <@ array['maxOutputTokens', 'reasoning.effort', 'responseFormat', 'sampling.frequencyPenalty', 'sampling.presencePenalty', 'sampling.seed', 'sampling.stopSequences', 'sampling.temperature', 'sampling.topP', 'toolChoice', 'toolChoice.function', 'toolChoice.none', 'toolChoice.required', 'tools']::text[]);