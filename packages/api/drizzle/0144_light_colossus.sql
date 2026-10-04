-- oxy:deploy-phase=pre
-- Nullable metadata only. The replacement partial index covers every pre-existing
-- ordinary row (all metadata is NULL) with the same columns/name and uniqueness.
-- DDL applies transactionally; no existing identity, permission or legal fact changes.
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_revision_provider_scope_key";--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD COLUMN "private_auto_source_approval" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_deployments_revision_provider_scope_key" ON "inference_deployments" USING btree ("model_revision_id","provider_slug","availability_scope") WHERE "inference_deployments"."private_auto_source_approval" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_deployments_private_auto_route_key" ON "inference_deployments" USING btree ("internal_route_id") WHERE "inference_deployments"."private_auto_source_approval" is not null;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_private_auto_stays_private" CHECK ("inference_deployments"."private_auto_source_approval" is null or coalesce((jsonb_typeof("inference_deployments"."private_auto_source_approval") = 'object'
        and "inference_deployments"."private_auto_source_approval"->>'purpose' = 'private_auto_classifier'
        and "inference_deployments"."private_auto_source_approval"->>'classifierVersion' = 'jev-auto-v1'
        and "inference_deployments"."internal_route_id" is not null
        and "inference_deployments"."internal_route_id" = "inference_deployments"."private_auto_source_approval"->>'deploymentId'
        and "inference_deployments"."provider_slug" = "inference_deployments"."private_auto_source_approval"->>'provider'
        and "inference_deployments"."price_version_id" = "inference_deployments"."private_auto_source_approval"->>'priceVersionId'
        and "inference_deployments"."private_auto_source_approval"->'principal'->>'lane' = 'service_token'
        and "inference_deployments"."private_auto_source_approval"->'principal'->>'environment' = 'production'
        and "inference_deployments"."private_auto_source_approval"->'review'->>'internalUseAllowed' = 'true'
        and "inference_deployments"."scoped_execution" is null
        and "inference_deployments"."availability_scope" = 'platform_internal' and "inference_deployments"."auto_approval_policy_id" is null
        and "inference_deployments"."status" in ('disabled', 'retired')
        and "inference_deployments"."permission_state" in ('pending_review', 'rejected', 'retired')), false));