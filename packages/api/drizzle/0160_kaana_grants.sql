-- oxy:deploy-phase=pre
-- Additive: three new tables for Kaana ADR 0002 phase 2 (the grants Oxy signs
-- for kaana.ai/v1 and what they settle against) and one for the inference
-- limits an application sets in Console. Nothing reads or writes them until
-- Kaana calls /internal/kaana/v1/*, so either image serves correctly.
CREATE TABLE "application_inference_limits" (
	"application_id" text PRIMARY KEY NOT NULL,
	"max_concurrent_realtime_sessions" integer,
	"max_concurrent_realtime_sessions_per_credential" integer,
	"max_concurrent_requests" integer,
	"max_requests_per_utc_day" integer,
	"updated_by_account_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_inference_limits_range_check" CHECK (("application_inference_limits"."max_concurrent_realtime_sessions" is null or "application_inference_limits"."max_concurrent_realtime_sessions" between 1 and 1000000)
        and ("application_inference_limits"."max_concurrent_realtime_sessions_per_credential" is null or "application_inference_limits"."max_concurrent_realtime_sessions_per_credential" between 1 and 1000000)
        and ("application_inference_limits"."max_concurrent_requests" is null or "application_inference_limits"."max_concurrent_requests" between 1 and 1000000)
        and ("application_inference_limits"."max_requests_per_utc_day" is null or "application_inference_limits"."max_requests_per_utc_day" between 1 and 1000000)),
	CONSTRAINT "application_inference_limits_credential_check" CHECK ("application_inference_limits"."max_concurrent_realtime_sessions_per_credential" is null or "application_inference_limits"."max_concurrent_realtime_sessions" is null
        or "application_inference_limits"."max_concurrent_realtime_sessions_per_credential" <= "application_inference_limits"."max_concurrent_realtime_sessions")
);
--> statement-breakpoint
CREATE TABLE "kaana_grant_admitted_lines" (
	"grant_id" text NOT NULL,
	"step_index" smallint NOT NULL,
	"model_line" text NOT NULL,
	"price_version_id" text NOT NULL,
	CONSTRAINT "kaana_grant_admitted_lines_grant_id_step_index_model_line_pk" PRIMARY KEY("grant_id","step_index","model_line")
);
--> statement-breakpoint
CREATE TABLE "kaana_grant_steps" (
	"grant_id" text NOT NULL,
	"step_index" smallint NOT NULL,
	"target_kind" text NOT NULL,
	"target" text NOT NULL,
	"max_funding_tier" text,
	"max_price_amount" numeric(30, 12),
	"max_price_currency" text,
	CONSTRAINT "kaana_grant_steps_grant_id_step_index_pk" PRIMARY KEY("grant_id","step_index"),
	CONSTRAINT "kaana_grant_steps_index_check" CHECK ("kaana_grant_steps"."step_index" between 0 and 7),
	CONSTRAINT "kaana_grant_steps_target_kind_check" CHECK ("kaana_grant_steps"."target_kind" in ('model', 'level')),
	CONSTRAINT "kaana_grant_steps_funding_tier_check" CHECK ("kaana_grant_steps"."max_funding_tier" is null or "kaana_grant_steps"."max_funding_tier" in ('free', 'credit', 'paid')),
	CONSTRAINT "kaana_grant_steps_price_check" CHECK (("kaana_grant_steps"."max_price_amount" is null) = ("kaana_grant_steps"."max_price_currency" is null)
        and ("kaana_grant_steps"."max_price_currency" is null or "kaana_grant_steps"."max_price_currency" ~ '^[A-Z]{3}$'))
);
--> statement-breakpoint
CREATE TABLE "kaana_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"endpoint" text NOT NULL,
	"lane" text NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"delegated_user_id" text,
	"environment" text NOT NULL,
	"economic_treatment" text NOT NULL,
	"economic_policy_version" text NOT NULL,
	"economic_relationship_id" text,
	"metered_usage_id" text NOT NULL,
	"reservation_id" text,
	"ceiling_amount" numeric(30, 12),
	"ceiling_currency" text,
	"routing_policy_version_id" text,
	"body_sha256" text NOT NULL,
	"grant_sha256" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"execute_by" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"settlement_id" text,
	"settled_at" timestamp with time zone,
	"served_step" smallint,
	"served_outside_grant" boolean,
	"served_funding_tier" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "kaana_grants_operation_check" CHECK ("kaana_grants"."operation" in ('responses', 'chat_completions', 'embeddings', 'audio_speech', 'audio_transcriptions', 'images_generations', 'decisions', 'realtime_session')),
	CONSTRAINT "kaana_grants_lane_check" CHECK ("kaana_grants"."lane" in ('machine_credential', 'service_token', 'product_session')),
	CONSTRAINT "kaana_grants_environment_check" CHECK ("kaana_grants"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "kaana_grants_treatment_check" CHECK ("kaana_grants"."economic_treatment" in ('commercial', 'internal_metered', 'platform_fee_only')),
	CONSTRAINT "kaana_grants_status_check" CHECK ("kaana_grants"."status" in ('issued', 'settled', 'expired')),
	CONSTRAINT "kaana_grants_funding_tier_check" CHECK ("kaana_grants"."served_funding_tier" is null or "kaana_grants"."served_funding_tier" in ('free', 'credit', 'paid')),
	CONSTRAINT "kaana_grants_ceiling_check" CHECK (("kaana_grants"."ceiling_amount" is null) = ("kaana_grants"."ceiling_currency" is null)
        and ("kaana_grants"."ceiling_currency" is null or "kaana_grants"."ceiling_currency" ~ '^[A-Z]{3}$')
        and ("kaana_grants"."reservation_id" is null or "kaana_grants"."ceiling_amount" is not null)),
	CONSTRAINT "kaana_grants_hashes_check" CHECK ("kaana_grants"."body_sha256" ~ '^[0-9a-f]{64}$' and "kaana_grants"."grant_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "kaana_grants_window_check" CHECK ("kaana_grants"."execute_by" > "kaana_grants"."issued_at" and "kaana_grants"."execute_by" <= "kaana_grants"."issued_at" + interval '60 seconds'
        and "kaana_grants"."expires_at" >= "kaana_grants"."execute_by"),
	CONSTRAINT "kaana_grants_reservation_check" CHECK (("kaana_grants"."economic_treatment" = 'internal_metered') = ("kaana_grants"."reservation_id" is null)),
	CONSTRAINT "kaana_grants_settlement_check" CHECK (("kaana_grants"."status" = 'settled') = ("kaana_grants"."settlement_id" is not null and "kaana_grants"."settled_at" is not null)
        and ("kaana_grants"."status" = 'settled' or ("kaana_grants"."served_step" is null and "kaana_grants"."served_outside_grant" is null
          and "kaana_grants"."served_funding_tier" is null))),
	CONSTRAINT "kaana_grants_served_step_check" CHECK ("kaana_grants"."served_step" is null or "kaana_grants"."served_step" between 0 and 7)
);
--> statement-breakpoint
ALTER TABLE "application_inference_limits" ADD CONSTRAINT "application_inference_limits_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_inference_limits" ADD CONSTRAINT "application_inference_limits_updated_by_account_id_users_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grant_admitted_lines" ADD CONSTRAINT "kaana_grant_admitted_lines_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grant_admitted_lines" ADD CONSTRAINT "kaana_grant_admitted_lines_step_fk" FOREIGN KEY ("grant_id","step_index") REFERENCES "public"."kaana_grant_steps"("grant_id","step_index") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grant_steps" ADD CONSTRAINT "kaana_grant_steps_grant_id_kaana_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."kaana_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_metered_usage_id_inference_metered_usage_id_fk" FOREIGN KEY ("metered_usage_id") REFERENCES "public"."inference_metered_usage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grants" ADD CONSTRAINT "kaana_grants_routing_policy_version_id_inference_routing_policy_versions_id_fk" FOREIGN KEY ("routing_policy_version_id") REFERENCES "public"."inference_routing_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kaana_grant_admitted_lines_price_idx" ON "kaana_grant_admitted_lines" USING btree ("price_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kaana_grants_request_key" ON "kaana_grants" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kaana_grants_metered_usage_key" ON "kaana_grants" USING btree ("metered_usage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kaana_grants_reservation_key" ON "kaana_grants" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kaana_grants_settlement_key" ON "kaana_grants" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "kaana_grants_open_idx" ON "kaana_grants" USING btree ("status","expires_at");