-- oxy:deploy-phase=pre
-- I10 lineage regenerated on the verified combined migration chain.
ALTER TABLE "inference_metered_usage" ADD COLUMN "parent_request_id" text;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD COLUMN "final_authorized_model_reference" text;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD COLUMN "final_authorized_provider" text;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD COLUMN "final_authorized_deployment_id" text;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD COLUMN "final_authorized_ceiling_amount" numeric(30, 12);--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD COLUMN "final_authorized_ceiling_currency" text;--> statement-breakpoint
CREATE INDEX "inference_metered_usage_parent_idx" ON "inference_metered_usage" USING btree ("parent_request_id");--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_parent_check" CHECK ("inference_metered_usage"."parent_request_id" is null or ("inference_metered_usage"."parent_request_id" <> "inference_metered_usage"."request_id" and length("inference_metered_usage"."parent_request_id") > 0));--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_final_authorization_check" CHECK (("inference_metered_usage"."final_authorized_model_reference" is null and "inference_metered_usage"."final_authorized_provider" is null
        and "inference_metered_usage"."final_authorized_deployment_id" is null and "inference_metered_usage"."final_authorized_ceiling_amount" is null
        and "inference_metered_usage"."final_authorized_ceiling_currency" is null) or
        ("inference_metered_usage"."final_authorized_model_reference" is not null and "inference_metered_usage"."final_authorized_provider" is not null
        and "inference_metered_usage"."final_authorized_deployment_id" is not null
        and ("inference_metered_usage"."final_authorized_ceiling_amount" is null) = ("inference_metered_usage"."final_authorized_ceiling_currency" is null)
        and ("inference_metered_usage"."final_authorized_ceiling_currency" is null or "inference_metered_usage"."final_authorized_ceiling_currency" ~ '^[A-Z]{3}$')));