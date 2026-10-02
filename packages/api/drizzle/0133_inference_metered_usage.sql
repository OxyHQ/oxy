-- oxy:deploy-phase=pre
-- I09 regenerated after scoped execution and I06; source DDL equality verified.
CREATE TABLE "inference_metered_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"economic_treatment" text NOT NULL,
	"economic_policy_version" text NOT NULL,
	"economic_relationship_id" text,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"delegated_user_id" text,
	"environment" text NOT NULL,
	"cost_center_account_id" text,
	"endpoint" text NOT NULL,
	"requested_model_reference" text NOT NULL,
	"admitted_model_reference" text NOT NULL,
	"admitted_provider" text NOT NULL,
	"admitted_deployment_id" text NOT NULL,
	"routing_policy_version_id" text,
	"ceiling_amount" numeric(30, 12),
	"ceiling_currency" text,
	"status" text DEFAULT 'admitted' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"usage_source" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"audio_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL,
	"audio_output_tokens" bigint DEFAULT 0 NOT NULL,
	"session_milliseconds" bigint DEFAULT 0 NOT NULL,
	"resolved_model_reference" text,
	"serving_provider" text,
	"generation_id" text,
	"settled_price_version_id" text,
	"tariff_status" text,
	"tariff_amount" numeric(30, 12),
	"tariff_currency" text,
	"usage_receipt_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "inference_metered_usage_treatment_check" CHECK ("inference_metered_usage"."economic_treatment" in ('commercial', 'internal_metered')),
	CONSTRAINT "inference_metered_usage_status_check" CHECK ("inference_metered_usage"."status" in ('admitted', 'settled', 'refused')),
	CONSTRAINT "inference_metered_usage_environment_check" CHECK ("inference_metered_usage"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_metered_usage_outcome_check" CHECK ("inference_metered_usage"."outcome" is null or "inference_metered_usage"."outcome" in ('completed', 'partial', 'cancelled', 'failed')),
	CONSTRAINT "inference_metered_usage_usage_source_check" CHECK ("inference_metered_usage"."usage_source" is null or "inference_metered_usage"."usage_source" in ('provider_reported', 'oxy_measured', 'estimated')),
	CONSTRAINT "inference_metered_usage_tariff_status_check" CHECK ("inference_metered_usage"."tariff_status" is null or "inference_metered_usage"."tariff_status" in ('quoted', 'unpriced')),
	CONSTRAINT "inference_metered_usage_relationship_check" CHECK (("inference_metered_usage"."economic_treatment" = 'internal_metered') = ("inference_metered_usage"."economic_relationship_id" is not null)),
	CONSTRAINT "inference_metered_usage_internal_uncharged_check" CHECK ("inference_metered_usage"."economic_treatment" <> 'internal_metered' or "inference_metered_usage"."usage_receipt_id" is null),
	CONSTRAINT "inference_metered_usage_settled_check" CHECK (("inference_metered_usage"."status" = 'settled') = ("inference_metered_usage"."outcome" is not null and "inference_metered_usage"."usage_source" is not null and "inference_metered_usage"."settled_at" is not null)),
	CONSTRAINT "inference_metered_usage_tariff_check" CHECK (("inference_metered_usage"."tariff_status" = 'quoted') = ("inference_metered_usage"."tariff_amount" is not null and "inference_metered_usage"."tariff_currency" is not null)
        and ("inference_metered_usage"."tariff_status" is not null or ("inference_metered_usage"."tariff_amount" is null and "inference_metered_usage"."tariff_currency" is null))),
	CONSTRAINT "inference_metered_usage_tariff_currency_check" CHECK ("inference_metered_usage"."tariff_currency" is null or "inference_metered_usage"."tariff_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inference_metered_usage_ceiling_currency_check" CHECK (("inference_metered_usage"."ceiling_amount" is null) = ("inference_metered_usage"."ceiling_currency" is null)
        and ("inference_metered_usage"."ceiling_currency" is null or "inference_metered_usage"."ceiling_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "inference_metered_usage_units_check" CHECK ("inference_metered_usage"."input_tokens" >= 0 and "inference_metered_usage"."cached_input_tokens" >= 0 and "inference_metered_usage"."output_tokens" >= 0 and "inference_metered_usage"."reasoning_tokens" >= 0 and "inference_metered_usage"."requests" >= 0 and "inference_metered_usage"."images" >= 0 and "inference_metered_usage"."audio_input_milliseconds" >= 0 and "inference_metered_usage"."audio_output_milliseconds" >= 0 and "inference_metered_usage"."video_milliseconds" >= 0 and "inference_metered_usage"."characters" >= 0 and "inference_metered_usage"."embeddings" >= 0 and "inference_metered_usage"."audio_input_tokens" >= 0 and "inference_metered_usage"."cached_audio_input_tokens" >= 0 and "inference_metered_usage"."audio_output_tokens" >= 0 and "inference_metered_usage"."session_milliseconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_provider_cost_attempts" (
	"request_id" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"provider" text NOT NULL,
	"key_id" text NOT NULL,
	"key_class" text NOT NULL,
	"deployment_id" text NOT NULL,
	"model_reference" text NOT NULL,
	"cost_source" text NOT NULL,
	"cost_amount" numeric(30, 12),
	"cost_currency" text,
	"rate_card_version_id" text,
	"cost_complete" boolean NOT NULL,
	"served" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"units_measured" boolean NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"audio_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL,
	"audio_output_tokens" bigint DEFAULT 0 NOT NULL,
	"session_milliseconds" bigint DEFAULT 0 NOT NULL,
	"outcome" text,
	"failure_code" text,
	"latency_ms" integer,
	"feed_position" text NOT NULL,
	"facts_digest" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_provider_cost_attempts_pkey" PRIMARY KEY("request_id","attempt_index"),
	CONSTRAINT "inference_provider_cost_attempts_index_check" CHECK ("inference_provider_cost_attempts"."attempt_index" >= 0),
	CONSTRAINT "inference_provider_cost_attempts_source_check" CHECK ("inference_provider_cost_attempts"."cost_source" in ('provider_reported', 'rate_card', 'unknown')),
	CONSTRAINT "inference_provider_cost_attempts_amount_check" CHECK (("inference_provider_cost_attempts"."cost_source" <> 'unknown') = ("inference_provider_cost_attempts"."cost_amount" is not null and "inference_provider_cost_attempts"."cost_currency" is not null)
        and ("inference_provider_cost_attempts"."cost_source" <> 'unknown' or ("inference_provider_cost_attempts"."cost_amount" is null and "inference_provider_cost_attempts"."cost_currency" is null))),
	CONSTRAINT "inference_provider_cost_attempts_currency_check" CHECK ("inference_provider_cost_attempts"."cost_currency" is null or "inference_provider_cost_attempts"."cost_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inference_provider_cost_attempts_units_check" CHECK ("inference_provider_cost_attempts"."input_tokens" >= 0 and "inference_provider_cost_attempts"."cached_input_tokens" >= 0 and "inference_provider_cost_attempts"."output_tokens" >= 0 and "inference_provider_cost_attempts"."reasoning_tokens" >= 0 and "inference_provider_cost_attempts"."requests" >= 0 and "inference_provider_cost_attempts"."images" >= 0 and "inference_provider_cost_attempts"."audio_input_milliseconds" >= 0 and "inference_provider_cost_attempts"."audio_output_milliseconds" >= 0 and "inference_provider_cost_attempts"."video_milliseconds" >= 0 and "inference_provider_cost_attempts"."characters" >= 0 and "inference_provider_cost_attempts"."embeddings" >= 0 and "inference_provider_cost_attempts"."audio_input_tokens" >= 0 and "inference_provider_cost_attempts"."cached_audio_input_tokens" >= 0 and "inference_provider_cost_attempts"."audio_output_tokens" >= 0 and "inference_provider_cost_attempts"."session_milliseconds" >= 0),
	CONSTRAINT "inference_provider_cost_attempts_unmeasured_check" CHECK ("inference_provider_cost_attempts"."units_measured" or ("inference_provider_cost_attempts"."input_tokens" + "inference_provider_cost_attempts"."cached_input_tokens" + "inference_provider_cost_attempts"."output_tokens" + "inference_provider_cost_attempts"."reasoning_tokens" + "inference_provider_cost_attempts"."requests" + "inference_provider_cost_attempts"."images" + "inference_provider_cost_attempts"."audio_input_milliseconds" + "inference_provider_cost_attempts"."audio_output_milliseconds" + "inference_provider_cost_attempts"."video_milliseconds" + "inference_provider_cost_attempts"."characters" + "inference_provider_cost_attempts"."embeddings" + "inference_provider_cost_attempts"."audio_input_tokens" + "inference_provider_cost_attempts"."cached_audio_input_tokens" + "inference_provider_cost_attempts"."audio_output_tokens" + "inference_provider_cost_attempts"."session_milliseconds") = 0),
	CONSTRAINT "inference_provider_cost_attempts_latency_check" CHECK ("inference_provider_cost_attempts"."latency_ms" is null or "inference_provider_cost_attempts"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_provider_cost_feed_cursors" (
	"feed" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_cost_center_account_id_users_id_fk" FOREIGN KEY ("cost_center_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_routing_policy_version_id_inference_routing_policy_versions_id_fk" FOREIGN KEY ("routing_policy_version_id") REFERENCES "public"."inference_routing_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_settled_price_version_id_price_versions_id_fk" FOREIGN KEY ("settled_price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_metered_usage" ADD CONSTRAINT "inference_metered_usage_usage_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("usage_receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_metered_usage_request_key" ON "inference_metered_usage" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_metered_usage_idempotency_key" ON "inference_metered_usage" USING btree ("idempotency_key") WHERE "inference_metered_usage"."status" <> 'refused';--> statement-breakpoint
CREATE INDEX "inference_metered_usage_capacity_idx" ON "inference_metered_usage" USING btree ("application_id","environment","status","created_at");--> statement-breakpoint
CREATE INDEX "inference_metered_usage_settled_idx" ON "inference_metered_usage" USING btree ("settled_at");--> statement-breakpoint
CREATE INDEX "inference_provider_cost_attempts_occurred_idx" ON "inference_provider_cost_attempts" USING btree ("occurred_at");