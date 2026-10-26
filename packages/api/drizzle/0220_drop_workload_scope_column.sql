-- oxy:deploy-phase=post
-- Rollback prerequisite: the explicit-column workload writer from PR #1996
-- must already be the deployed previous image (API and asset workers).
-- Only the inert workload scope column/check are removed. External scope
-- ceilings and every binding/attribution relation remain unchanged.
-- The shared migrator bounds lock acquisition to 3s and each migration to 120s.
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP COLUMN "scopes";