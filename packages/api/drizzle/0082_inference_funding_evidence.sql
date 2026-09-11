-- oxy:deploy-phase=pre
ALTER TABLE "inference_deployment_routing_score_events" DROP CONSTRAINT "inference_deployment_routing_score_events_funding_evidence_check";--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" DROP CONSTRAINT "inference_deployment_routing_scores_funding_evidence_check";--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD COLUMN "funding_evidence_ref" text DEFAULT 'migration/standard-payg' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD COLUMN "funding_evidence_ref" text DEFAULT 'migration/standard-payg' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD CONSTRAINT "inference_deployment_routing_score_events_funding_evidence_check" CHECK (("inference_deployment_routing_score_events"."funding_remaining" is null) = ("inference_deployment_routing_score_events"."funding_remaining_unit" is null)
        and length(btrim("inference_deployment_routing_score_events"."funding_evidence_ref")) between 1 and 500
        and ("inference_deployment_routing_score_events"."funding_remaining" is null or "inference_deployment_routing_score_events"."funding_remaining" >= 0)
        and ("inference_deployment_routing_score_events"."funding_remaining_unit" is null or length(btrim("inference_deployment_routing_score_events"."funding_remaining_unit")) between 1 and 64)
        and ("inference_deployment_routing_score_events"."funding_observed_at" is null) = ("inference_deployment_routing_score_events"."funding_valid_until" is null)
        and ("inference_deployment_routing_score_events"."funding_valid_until" is null or "inference_deployment_routing_score_events"."funding_valid_until" > "inference_deployment_routing_score_events"."funding_observed_at")
        and ("inference_deployment_routing_score_events"."funding_class" in ('discounted_payg', 'standard_payg') or ("inference_deployment_routing_score_events"."funding_observed_at" is not null and "inference_deployment_routing_score_events"."funding_valid_until" is not null)));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD CONSTRAINT "inference_deployment_routing_scores_funding_evidence_check" CHECK (("inference_deployment_routing_scores"."funding_remaining" is null) = ("inference_deployment_routing_scores"."funding_remaining_unit" is null)
        and length(btrim("inference_deployment_routing_scores"."funding_evidence_ref")) between 1 and 500
        and ("inference_deployment_routing_scores"."funding_remaining" is null or "inference_deployment_routing_scores"."funding_remaining" >= 0)
        and ("inference_deployment_routing_scores"."funding_remaining_unit" is null or length(btrim("inference_deployment_routing_scores"."funding_remaining_unit")) between 1 and 64)
        and ("inference_deployment_routing_scores"."funding_observed_at" is null) = ("inference_deployment_routing_scores"."funding_valid_until" is null)
        and ("inference_deployment_routing_scores"."funding_valid_until" is null or "inference_deployment_routing_scores"."funding_valid_until" > "inference_deployment_routing_scores"."funding_observed_at")
        and ("inference_deployment_routing_scores"."funding_class" in ('discounted_payg', 'standard_payg') or ("inference_deployment_routing_scores"."funding_observed_at" is not null and "inference_deployment_routing_scores"."funding_valid_until" is not null)));--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ALTER COLUMN "funding_evidence_ref" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ALTER COLUMN "funding_evidence_ref" DROP DEFAULT;
