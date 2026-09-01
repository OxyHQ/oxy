-- oxy:deploy-phase=pre
--
-- Additive routing-profile scoring and audit provenance. Score defaults preserve
-- existing priority semantics until an editor supplies profile-specific signals;
-- the nullable candidate reference keeps old writers compatible during rollout.

ALTER TABLE "inference_route_switch_events" DROP CONSTRAINT "inference_route_switch_events_deployment_shape";--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" DROP CONSTRAINT "inference_route_switch_events_model_shape";--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD COLUMN "routing_profile_candidate_id" text;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD COLUMN "price_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD COLUMN "latency_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD COLUMN "throughput_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD COLUMN "quality_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD COLUMN "balanced_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_routing_profile_candidate_id_inference_routing_profile_candidates_id_fk" FOREIGN KEY ("routing_profile_candidate_id") REFERENCES "public"."inference_routing_profile_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_deployment_shape" CHECK ("inference_route_switch_events"."scope" <> 'deployment' or (
        "inference_route_switch_events"."from_model_reference" = "inference_route_switch_events"."to_model_reference"
        and "inference_route_switch_events"."requested_model_id" is null
        and "inference_route_switch_events"."authorization_id" is null
        and "inference_route_switch_events"."routing_profile_candidate_id" is null
      ));--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_model_shape" CHECK ("inference_route_switch_events"."scope" <> 'model' or (
        "inference_route_switch_events"."requested_model_id" is not null
        and (("inference_route_switch_events"."authorization_id" is null) <> ("inference_route_switch_events"."routing_profile_candidate_id" is null))
        and "inference_route_switch_events"."from_model_reference" <> "inference_route_switch_events"."to_model_reference"
      ));--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD CONSTRAINT "inference_routing_profile_candidates_score_range" CHECK ("inference_routing_profile_candidates"."price_score" between -1000000 and 1000000
        and "inference_routing_profile_candidates"."latency_score" between -1000000 and 1000000
        and "inference_routing_profile_candidates"."throughput_score" between -1000000 and 1000000
        and "inference_routing_profile_candidates"."quality_score" between -1000000 and 1000000
        and "inference_routing_profile_candidates"."balanced_score" between -1000000 and 1000000);
