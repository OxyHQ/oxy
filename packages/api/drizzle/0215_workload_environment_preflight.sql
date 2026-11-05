-- oxy:deploy-phase=pre
-- Additive preparation: legacy readers and writers ignore this nullable column.
-- Registry DDL only; the reviewed backfill runs separately after rollout.
-- No default or data rewrite. The small workload registry CHECK accepts NULL.
ALTER TABLE "application_workload_identities" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_environment_check" CHECK ("application_workload_identities"."environment" in ('development', 'staging', 'production'));
