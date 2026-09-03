-- oxy:deploy-phase=pre
CREATE TABLE "normalized_app_event_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"app_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "normalized_app_event_outbox_event_id_key" UNIQUE("event_id"),
	CONSTRAINT "normalized_app_event_outbox_attempts_check" CHECK ("normalized_app_event_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "normalized_app_event_outbox_pending_idx" ON "normalized_app_event_outbox" USING btree ("app_id","created_at") WHERE "normalized_app_event_outbox"."processed_at" is null and "normalized_app_event_outbox"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "normalized_app_event_outbox_dead_letter_idx" ON "normalized_app_event_outbox" USING btree ("failed_at") WHERE "normalized_app_event_outbox"."failed_at" is not null;
