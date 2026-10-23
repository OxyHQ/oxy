-- oxy:deploy-phase=pre
ALTER TABLE "application_workload_identities" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_environment_check" CHECK ("application_workload_identities"."environment" in ('development', 'staging', 'production'));