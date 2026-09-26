-- oxy:deploy-phase=pre
-- Account-deletion events for relying parties (OxyHQ/Mention#1169): two new
-- tables nothing in the running image reads or writes. Additive only, so it is
-- safe ahead of the rollout; `post` would leave the new image's DELETE /users/me
-- writing to tables that do not exist yet for the length of a rollout.
CREATE TABLE "account_event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"application_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_event_deliveries_event_id_application_id_key" UNIQUE("event_id","application_id"),
	CONSTRAINT "account_event_deliveries_attempts_check" CHECK ("account_event_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text,
	"retained" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_events_type_check" CHECK ("account_events"."type" in ('account.deleted'))
);
--> statement-breakpoint
ALTER TABLE "account_event_deliveries" ADD CONSTRAINT "account_event_deliveries_event_id_account_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."account_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_event_deliveries" ADD CONSTRAINT "account_event_deliveries_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_event_deliveries_due_idx" ON "account_event_deliveries" USING btree ("next_attempt_at") WHERE "account_event_deliveries"."delivered_at" is null and "account_event_deliveries"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "account_event_deliveries_application_id_event_id_idx" ON "account_event_deliveries" USING btree ("application_id","event_id");--> statement-breakpoint
CREATE INDEX "account_events_created_at_idx" ON "account_events" USING btree ("created_at");