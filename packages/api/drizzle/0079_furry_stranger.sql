-- oxy:deploy-phase=pre
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_availability_scope_check";--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_availability_scope_check" CHECK ("inference_deployments"."availability_scope" in ('internal_alia', 'platform_internal', 'public_payg', 'enterprise', 'byok_only', 'oxy_hosted'));
