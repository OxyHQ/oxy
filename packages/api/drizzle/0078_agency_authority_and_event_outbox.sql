-- oxy:deploy-phase=pre
ALTER TABLE "delegation_grants" ADD COLUMN "catalog_registration_id" text;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_catalog_registration_id_app_capability_catalog_registrations_id_fk" FOREIGN KEY ("catalog_registration_id") REFERENCES "public"."app_capability_catalog_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delegation_grants_catalog_registration_idx" ON "delegation_grants" USING btree ("catalog_registration_id");--> statement-breakpoint
UPDATE "delegation_grants" AS "grant"
SET "catalog_registration_id" = "registration"."id", "updated_at" = now()
FROM "app_capability_catalog_registrations" AS "registration"
WHERE "grant"."catalog_registration_id" IS NULL
  AND "registration"."active" = true
  AND "registration"."app_slug" = "grant"."resource_app";--> statement-breakpoint
UPDATE "delegation_grants"
SET "revoked_at" = coalesce("revoked_at", now()), "updated_at" = now()
WHERE "catalog_registration_id" IS NULL;--> statement-breakpoint

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
);--> statement-breakpoint
CREATE INDEX "normalized_app_event_outbox_pending_idx" ON "normalized_app_event_outbox" USING btree ("app_id","created_at") WHERE "normalized_app_event_outbox"."processed_at" is null and "normalized_app_event_outbox"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "normalized_app_event_outbox_dead_letter_idx" ON "normalized_app_event_outbox" USING btree ("failed_at") WHERE "normalized_app_event_outbox"."failed_at" is not null;
