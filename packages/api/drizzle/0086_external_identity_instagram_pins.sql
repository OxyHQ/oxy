-- oxy:deploy-phase=pre
CREATE TABLE "external_identity_instagram_pins" (
	"state" text NOT NULL,
	"actor_uri" text PRIMARY KEY NOT NULL,
	"canonical_acct" text NOT NULL,
	"source_user_id" text NOT NULL,
	"instagram_pk" text NOT NULL,
	"instagram_graph_id" text NOT NULL,
	"profile_url" text NOT NULL,
	"document_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"first_verified_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_identity_instagram_pins_bounds_check" CHECK ("external_identity_instagram_pins"."state" in ('pending', 'pinned') and length("external_identity_instagram_pins"."actor_uri") <= 2048
    and length("external_identity_instagram_pins"."canonical_acct") <= 320 and length("external_identity_instagram_pins"."source_user_id") <= 128
    and "external_identity_instagram_pins"."instagram_pk" ~ '^[0-9]{1,32}$' and "external_identity_instagram_pins"."instagram_graph_id" ~ '^[0-9]{1,32}$'
    and length("external_identity_instagram_pins"."profile_url") <= 2048 and "external_identity_instagram_pins"."document_hash" ~ '^[a-f0-9]{64}$'
    and "external_identity_instagram_pins"."policy_version" = 'meta-profile-badges-2026-09-13-v1'
    and "external_identity_instagram_pins"."verified_at" >= "external_identity_instagram_pins"."first_verified_at")
);
--> statement-breakpoint
ALTER TABLE "external_identity_instagram_pins" ADD CONSTRAINT "external_identity_instagram_pins_actor_uri_external_identity_actors_actor_uri_fk" FOREIGN KEY ("actor_uri") REFERENCES "public"."external_identity_actors"("actor_uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_instagram_pins" ADD CONSTRAINT "external_identity_instagram_pins_source_user_id_users_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;