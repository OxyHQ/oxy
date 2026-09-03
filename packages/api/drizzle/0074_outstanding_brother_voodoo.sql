-- oxy:deploy-phase=post
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_availability_scope_check";--> statement-breakpoint
UPDATE "inference_deployments"
SET "availability_scope" = 'platform_internal'
WHERE "availability_scope" = 'internal_alia';--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_availability_scope_check" CHECK ("inference_deployments"."availability_scope" in ('platform_internal', 'public_payg', 'enterprise', 'byok_only', 'oxy_hosted'));
