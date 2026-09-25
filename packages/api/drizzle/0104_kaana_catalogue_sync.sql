-- oxy:deploy-phase=pre
-- Automatic Kaana -> Oxy catalogue sync (docs/inference/catalogue.md,
-- "Automatic sync from Kaana"). Additive only: two new tables, three
-- defaulted/nullable columns on inference_models and one nullable FK column on
-- inference_deployments. The previous image selects none of them and writes
-- neither table, and every existing row satisfies the new CHECKs through the
-- defaults ('{}' efforts, 'reviewed' source), so it is safe before the rollout.
--
-- The trailing INSERT seeds the one automatic approval policy the sync writes
-- under. Its CHECK allows only platform_internal + standard_application_use, so
-- no row of that table can approve public resale.
CREATE TABLE "inference_catalogue_auto_approval_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"availability_scope" text NOT NULL,
	"commercial_permission" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_catalogue_auto_approval_policies_internal_only" CHECK ("inference_catalogue_auto_approval_policies"."availability_scope" = 'platform_internal' and "inference_catalogue_auto_approval_policies"."commercial_permission" = 'standard_application_use'),
	CONSTRAINT "inference_catalogue_auto_approval_policies_description_check" CHECK (length(btrim("inference_catalogue_auto_approval_policies"."description")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "inference_catalogue_blocklist" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_catalogue_blocklist_model_id_key" UNIQUE("model_id"),
	CONSTRAINT "inference_catalogue_blocklist_model_id_format" CHECK ("inference_catalogue_blocklist"."model_id" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_catalogue_blocklist_reason_check" CHECK (length(btrim("inference_catalogue_blocklist"."reason")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD COLUMN "auto_approval_policy_id" text;--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "reasoning_efforts" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "provider_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "catalogue_source" text DEFAULT 'reviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_catalogue_blocklist" ADD CONSTRAINT "inference_catalogue_blocklist_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_auto_approval_policy_id_inference_catalogue_auto_approval_policies_id_fk" FOREIGN KEY ("auto_approval_policy_id") REFERENCES "public"."inference_catalogue_auto_approval_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_deployments_auto_approval_policy_id_idx" ON "inference_deployments" USING btree ("auto_approval_policy_id");--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_reasoning_efforts_check" CHECK ("inference_models"."reasoning_efforts" <@ array['low', 'medium', 'high']::text[]);--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_catalogue_source_check" CHECK ("inference_models"."catalogue_source" in ('reviewed', 'kaana_sync'));--> statement-breakpoint
INSERT INTO "inference_catalogue_auto_approval_policies" ("id", "availability_scope", "commercial_permission", "enabled", "description")
VALUES (
	'kaana-sync',
	'platform_internal',
	'standard_application_use',
	true,
	'Owner decision 2026-09-25: every model Kaana discovers and prices is approved automatically for consumption by official Oxy products (platform_internal, standard application use). Not approved for public resale, enterprise or third-party exposure, which keep their reviewed process. Emergency brake: inference_catalogue_blocklist.'
)
ON CONFLICT ("id") DO NOTHING;
