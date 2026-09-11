-- oxy:deploy-phase=pre
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_class" text DEFAULT 'standard_payg' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_state" text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_remaining" numeric(30, 12);--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_remaining_unit" text;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_class" text DEFAULT 'standard_payg' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_state" text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_remaining" numeric(30, 12);--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_remaining_unit" text;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD CONSTRAINT "inference_deployment_routing_score_events_funding_class_check" CHECK ("inference_deployment_routing_score_events"."funding_class" in ('free_entitlement', 'discounted_payg', 'promotional_credit', 'standard_payg'));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD CONSTRAINT "inference_deployment_routing_score_events_funding_state_check" CHECK ("inference_deployment_routing_score_events"."funding_state" in ('available', 'exhausted', 'rate_limited', 'unknown'));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD CONSTRAINT "inference_deployment_routing_score_events_funding_evidence_check" CHECK (("inference_deployment_routing_score_events"."funding_remaining" is null) = ("inference_deployment_routing_score_events"."funding_remaining_unit" is null)
        and ("inference_deployment_routing_score_events"."funding_remaining" is null or "inference_deployment_routing_score_events"."funding_remaining" >= 0)
        and ("inference_deployment_routing_score_events"."funding_remaining_unit" is null or length(btrim("inference_deployment_routing_score_events"."funding_remaining_unit")) between 1 and 64)
        and ("inference_deployment_routing_score_events"."funding_observed_at" is null) = ("inference_deployment_routing_score_events"."funding_valid_until" is null)
        and ("inference_deployment_routing_score_events"."funding_valid_until" is null or "inference_deployment_routing_score_events"."funding_valid_until" > "inference_deployment_routing_score_events"."funding_observed_at")
        and ("inference_deployment_routing_score_events"."funding_class" in ('discounted_payg', 'standard_payg') or ("inference_deployment_routing_score_events"."funding_observed_at" is not null and "inference_deployment_routing_score_events"."funding_valid_until" is not null)));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD CONSTRAINT "inference_deployment_routing_scores_funding_class_check" CHECK ("inference_deployment_routing_scores"."funding_class" in ('free_entitlement', 'discounted_payg', 'promotional_credit', 'standard_payg'));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD CONSTRAINT "inference_deployment_routing_scores_funding_state_check" CHECK ("inference_deployment_routing_scores"."funding_state" in ('available', 'exhausted', 'rate_limited', 'unknown'));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD CONSTRAINT "inference_deployment_routing_scores_funding_evidence_check" CHECK (("inference_deployment_routing_scores"."funding_remaining" is null) = ("inference_deployment_routing_scores"."funding_remaining_unit" is null)
        and ("inference_deployment_routing_scores"."funding_remaining" is null or "inference_deployment_routing_scores"."funding_remaining" >= 0)
        and ("inference_deployment_routing_scores"."funding_remaining_unit" is null or length(btrim("inference_deployment_routing_scores"."funding_remaining_unit")) between 1 and 64)
        and ("inference_deployment_routing_scores"."funding_observed_at" is null) = ("inference_deployment_routing_scores"."funding_valid_until" is null)
        and ("inference_deployment_routing_scores"."funding_valid_until" is null or "inference_deployment_routing_scores"."funding_valid_until" > "inference_deployment_routing_scores"."funding_observed_at")
        and ("inference_deployment_routing_scores"."funding_class" in ('discounted_payg', 'standard_payg') or ("inference_deployment_routing_scores"."funding_observed_at" is not null and "inference_deployment_routing_scores"."funding_valid_until" is not null)));
