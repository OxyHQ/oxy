-- oxy:deploy-phase=pre
ALTER TABLE "inference_deployments" ADD COLUMN "platform_fee_price_version_id" text;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_platform_fee_price_version_id_price_versions_id_fk" FOREIGN KEY ("platform_fee_price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_platform_fee_only_for_byok" CHECK ("inference_deployments"."platform_fee_price_version_id" is null or "inference_deployments"."availability_scope" = 'byok_only');
