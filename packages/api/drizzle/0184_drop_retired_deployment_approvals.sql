-- oxy:deploy-phase=post
--
-- The one-off scoped and Private Auto decisions permits were deleted (oxy#1809,
-- #1811): decisions are a kaana.ai/v1 grant, and nothing reads or writes
-- `scoped_execution` or `private_auto_source_approval` any more.
--
--  * the two deployment rows that still carry them go first: the disabled,
--    pending_review Jev routes of 2026-10-05, which no grant, catalogue or
--    credential validation references (ON DELETE RESTRICT refuses otherwise),
--    together with their current routing scorecards, which are keyed by the
--    same Kaana route ids; the scorecard events stay as history;
--  * the partial key that let those rows share a (revision, provider, scope)
--    becomes the plain unique key, and the Private Auto key and check go;
--  * the two columns are dropped.
--
-- POST: the previous image reads both columns on every catalogue query.
DELETE FROM "inference_deployment_routing_scores" WHERE "deployment_id" IN (SELECT "internal_route_id" FROM "inference_deployments" WHERE ("scoped_execution" IS NOT NULL OR "private_auto_source_approval" IS NOT NULL) AND "internal_route_id" IS NOT NULL) AND "deployment_id" NOT IN (SELECT "internal_route_id" FROM "inference_deployments" WHERE "scoped_execution" IS NULL AND "private_auto_source_approval" IS NULL AND "internal_route_id" IS NOT NULL);--> statement-breakpoint
DELETE FROM "inference_deployments" WHERE "scoped_execution" IS NOT NULL OR "private_auto_source_approval" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_private_auto_stays_private";--> statement-breakpoint
DROP INDEX "inference_deployments_private_auto_route_key";--> statement-breakpoint
DROP INDEX "inference_deployments_revision_provider_scope_key";--> statement-breakpoint
CREATE UNIQUE INDEX "inference_deployments_revision_provider_scope_key" ON "inference_deployments" USING btree ("model_revision_id","provider_slug","availability_scope");--> statement-breakpoint
ALTER TABLE "inference_deployments" DROP COLUMN "scoped_execution";--> statement-breakpoint
ALTER TABLE "inference_deployments" DROP COLUMN "private_auto_source_approval";
