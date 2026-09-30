-- oxy:deploy-phase=pre
--
-- Per-route accepted request parameters (OxyHQ/Kaana#124): the caller controls
-- Kaana's inventory reports an exact deployment's upstream accepts. NULL is
-- unknown and filters nothing; the edge never signs a route whose known set
-- lacks a control the request carries, because Kaana's Translate refuses it.
--
-- PRE: one nullable column and a CHECK that holds trivially on every existing
-- row (the column is NULL on it). The image still serving never names the
-- column; the arriving one reads and writes it. `inference_deployments` is a
-- small catalogue table, so the CHECK is validated in place.
ALTER TABLE "inference_deployments" ADD COLUMN "accepted_parameters" text[];--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_accepted_parameters_check" CHECK ("inference_deployments"."accepted_parameters" is null or "inference_deployments"."accepted_parameters" <@ array['maxOutputTokens', 'reasoning.effort', 'responseFormat', 'sampling.frequencyPenalty', 'sampling.presencePenalty', 'sampling.seed', 'sampling.stopSequences', 'sampling.temperature', 'sampling.topP', 'toolChoice', 'tools']::text[]);
