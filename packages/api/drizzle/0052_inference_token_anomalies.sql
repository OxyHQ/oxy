-- oxy:deploy-phase=pre
--
-- `inference_token_anomalies` — the TOKEN half of #972 section 8's "anomaly
-- detection for sudden spend/token spikes". Purely additive: one new table, its
-- foreign key and two indexes. Nothing existing is altered, so `pre` is safe and
-- the old image simply does not write to it.
--
-- Separate from `inference_spend_anomalies` (migration 0048) rather than a column
-- on it, because that table stores its values as `numeric` money and keys on
-- `currency`, while a token count is an integer with no currency. Reusing it would
-- put counts in money columns and invent a currency for them. The full argument is
-- in `db/schema/inferenceTokenAnomalies.ts`.

CREATE TABLE "inference_token_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"detected_for_hour" timestamp with time zone NOT NULL,
	"hour_tokens" bigint NOT NULL,
	"baseline_median_tokens" bigint NOT NULL,
	"threshold_multiple" double precision NOT NULL,
	"observed_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_token_anomalies_account_hour_key" UNIQUE("account_id","detected_for_hour"),
	CONSTRAINT "inference_token_anomalies_hour_tokens_check" CHECK ("inference_token_anomalies"."hour_tokens" >= 0),
	CONSTRAINT "inference_token_anomalies_baseline_median_tokens_check" CHECK ("inference_token_anomalies"."baseline_median_tokens" > 0),
	CONSTRAINT "inference_token_anomalies_threshold_multiple_check" CHECK ("inference_token_anomalies"."threshold_multiple" > 1),
	CONSTRAINT "inference_token_anomalies_observed_days_check" CHECK ("inference_token_anomalies"."observed_days" > 0),
	CONSTRAINT "inference_token_anomalies_is_a_spike_check" CHECK ("inference_token_anomalies"."hour_tokens" > "inference_token_anomalies"."baseline_median_tokens")
);
--> statement-breakpoint
ALTER TABLE "inference_token_anomalies" ADD CONSTRAINT "inference_token_anomalies_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_token_anomalies_account_id_detected_for_hour_idx" ON "inference_token_anomalies" USING btree ("account_id","detected_for_hour" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_token_anomalies_detected_for_hour_idx" ON "inference_token_anomalies" USING btree ("detected_for_hour" DESC NULLS LAST);