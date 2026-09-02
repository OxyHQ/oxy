-- oxy:deploy-phase=pre
CREATE TABLE "inference_deployment_routing_score_events" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"price_score" integer,
	"price_source" text NOT NULL,
	"price_evidence_ref" text NOT NULL,
	"price_version_id" text NOT NULL,
	"latency_score" integer,
	"latency_source" text NOT NULL,
	"latency_evidence_ref" text NOT NULL,
	"latency_measurement_window_start" timestamp with time zone NOT NULL,
	"latency_measurement_window_end" timestamp with time zone NOT NULL,
	"latency_valid_until" timestamp with time zone NOT NULL,
	"throughput_score" integer,
	"throughput_source" text NOT NULL,
	"throughput_evidence_ref" text NOT NULL,
	"throughput_measurement_window_start" timestamp with time zone NOT NULL,
	"throughput_measurement_window_end" timestamp with time zone NOT NULL,
	"throughput_valid_until" timestamp with time zone NOT NULL,
	"balanced_score" integer,
	"balanced_source" text NOT NULL,
	"balanced_evidence_ref" text NOT NULL,
	"balanced_formula_ref" text NOT NULL,
	"balanced_valid_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_deployment_routing_score_events_identity_check" CHECK (length(btrim("inference_deployment_routing_score_events"."deployment_id")) > 0),
	CONSTRAINT "inference_deployment_routing_score_events_range_check" CHECK (("inference_deployment_routing_score_events"."price_score" is null or "inference_deployment_routing_score_events"."price_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_score_events"."latency_score" is null or "inference_deployment_routing_score_events"."latency_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_score_events"."throughput_score" is null or "inference_deployment_routing_score_events"."throughput_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_score_events"."balanced_score" is null or "inference_deployment_routing_score_events"."balanced_score" between -1000000 and 1000000)),
	CONSTRAINT "inference_deployment_routing_score_events_source_check" CHECK ("inference_deployment_routing_score_events"."price_source" in ('provider_contract', 'cost_model', 'reviewed_scorecard')
        and "inference_deployment_routing_score_events"."latency_source" in ('kaana_measurement', 'reviewed_scorecard')
        and "inference_deployment_routing_score_events"."throughput_source" in ('kaana_measurement', 'reviewed_scorecard')
        and "inference_deployment_routing_score_events"."balanced_source" in ('cost_model', 'reviewed_scorecard')),
	CONSTRAINT "inference_deployment_routing_score_events_evidence_check" CHECK (length(btrim("inference_deployment_routing_score_events"."price_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_score_events"."latency_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_score_events"."throughput_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_score_events"."balanced_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_score_events"."balanced_formula_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_score_events"."reason")) between 1 and 500),
	CONSTRAINT "inference_deployment_routing_score_events_measurement_windows_check" CHECK ("inference_deployment_routing_score_events"."latency_measurement_window_end" >= "inference_deployment_routing_score_events"."latency_measurement_window_start"
        and "inference_deployment_routing_score_events"."latency_valid_until" >= "inference_deployment_routing_score_events"."latency_measurement_window_end"
        and "inference_deployment_routing_score_events"."throughput_measurement_window_end" >= "inference_deployment_routing_score_events"."throughput_measurement_window_start"
        and "inference_deployment_routing_score_events"."throughput_valid_until" >= "inference_deployment_routing_score_events"."throughput_measurement_window_end")
);
--> statement-breakpoint
CREATE TABLE "inference_deployment_routing_scores" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"price_score" integer,
	"price_source" text NOT NULL,
	"price_evidence_ref" text NOT NULL,
	"price_version_id" text NOT NULL,
	"latency_score" integer,
	"latency_source" text NOT NULL,
	"latency_evidence_ref" text NOT NULL,
	"latency_measurement_window_start" timestamp with time zone NOT NULL,
	"latency_measurement_window_end" timestamp with time zone NOT NULL,
	"latency_valid_until" timestamp with time zone NOT NULL,
	"throughput_score" integer,
	"throughput_source" text NOT NULL,
	"throughput_evidence_ref" text NOT NULL,
	"throughput_measurement_window_start" timestamp with time zone NOT NULL,
	"throughput_measurement_window_end" timestamp with time zone NOT NULL,
	"throughput_valid_until" timestamp with time zone NOT NULL,
	"balanced_score" integer,
	"balanced_source" text NOT NULL,
	"balanced_evidence_ref" text NOT NULL,
	"balanced_formula_ref" text NOT NULL,
	"balanced_valid_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"changed_by_user_id" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_deployment_routing_scores_identity_check" CHECK (length(btrim("inference_deployment_routing_scores"."deployment_id")) > 0),
	CONSTRAINT "inference_deployment_routing_scores_range_check" CHECK (("inference_deployment_routing_scores"."price_score" is null or "inference_deployment_routing_scores"."price_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_scores"."latency_score" is null or "inference_deployment_routing_scores"."latency_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_scores"."throughput_score" is null or "inference_deployment_routing_scores"."throughput_score" between -1000000 and 1000000)
        and ("inference_deployment_routing_scores"."balanced_score" is null or "inference_deployment_routing_scores"."balanced_score" between -1000000 and 1000000)),
	CONSTRAINT "inference_deployment_routing_scores_source_check" CHECK ("inference_deployment_routing_scores"."price_source" in ('provider_contract', 'cost_model', 'reviewed_scorecard')
        and "inference_deployment_routing_scores"."latency_source" in ('kaana_measurement', 'reviewed_scorecard')
        and "inference_deployment_routing_scores"."throughput_source" in ('kaana_measurement', 'reviewed_scorecard')
        and "inference_deployment_routing_scores"."balanced_source" in ('cost_model', 'reviewed_scorecard')),
	CONSTRAINT "inference_deployment_routing_scores_evidence_check" CHECK (length(btrim("inference_deployment_routing_scores"."price_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_scores"."latency_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_scores"."throughput_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_scores"."balanced_evidence_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_scores"."balanced_formula_ref")) between 1 and 500
        and length(btrim("inference_deployment_routing_scores"."reason")) between 1 and 500),
	CONSTRAINT "inference_deployment_routing_scores_measurement_windows_check" CHECK ("inference_deployment_routing_scores"."latency_measurement_window_end" >= "inference_deployment_routing_scores"."latency_measurement_window_start"
        and "inference_deployment_routing_scores"."latency_valid_until" >= "inference_deployment_routing_scores"."latency_measurement_window_end"
        and "inference_deployment_routing_scores"."throughput_measurement_window_end" >= "inference_deployment_routing_scores"."throughput_measurement_window_start"
        and "inference_deployment_routing_scores"."throughput_valid_until" >= "inference_deployment_routing_scores"."throughput_measurement_window_end")
);
--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_score_events" ADD CONSTRAINT "inference_deployment_routing_score_events_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployment_routing_scores" ADD CONSTRAINT "inference_deployment_routing_scores_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_deployments_approved_internal_route_id_key" ON "inference_deployments" USING btree ("internal_route_id") WHERE "inference_deployments"."permission_state" = 'approved' and "inference_deployments"."internal_route_id" is not null;--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_routing_score_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a routing score change is recorded by a new event, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER inference_deployment_routing_score_events_immutable
BEFORE UPDATE OR DELETE ON inference_deployment_routing_score_events
FOR EACH ROW EXECUTE FUNCTION inference_routing_score_event_immutable();
