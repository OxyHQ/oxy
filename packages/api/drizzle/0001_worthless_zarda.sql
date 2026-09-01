-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "user_ancestors" (
	"user_id" text NOT NULL,
	"depth" integer NOT NULL,
	"ancestor_id" text NOT NULL,
	CONSTRAINT "user_ancestors_pkey" PRIMARY KEY("user_id","depth"),
	CONSTRAINT "user_ancestors_depth_check" CHECK ("user_ancestors"."depth" >= 0 and "user_ancestors"."depth" < 8),
	CONSTRAINT "user_ancestors_not_self_check" CHECK ("user_ancestors"."ancestor_id" <> "user_ancestors"."user_id")
);
--> statement-breakpoint
CREATE TABLE "user_auth_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method_public_key" text,
	"method_email" text,
	"method_credential_id" text,
	"method_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_auth_methods_type_check" CHECK ("user_auth_methods"."type" in ('identity', 'webauthn')),
	CONSTRAINT "user_auth_methods_identifier_check" CHECK (("user_auth_methods"."type" = 'identity' and "user_auth_methods"."method_public_key" is not null) or ("user_auth_methods"."type" = 'webauthn' and "user_auth_methods"."method_credential_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "user_link_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"location_key" text NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"type" text DEFAULT 'other' NOT NULL,
	"street" text,
	"street_number" text,
	"street_details" text,
	"postal_code" text,
	"city" text,
	"state" text,
	"country" text,
	"formatted_address" text,
	"latitude" double precision,
	"longitude" double precision,
	"place_id" text,
	"osm_id" text,
	"osm_type" text,
	"country_code" text,
	"timezone" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(formatted_address, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_locations_type_check" CHECK ("user_locations"."type" in ('home', 'work', 'school', 'other')),
	CONSTRAINT "user_locations_latitude_check" CHECK ("user_locations"."latitude" is null or ("user_locations"."latitude" >= -90 and "user_locations"."latitude" <= 90)),
	CONSTRAINT "user_locations_longitude_check" CHECK ("user_locations"."longitude" is null or ("user_locations"."longitude" >= -180 and "user_locations"."longitude" <= 180)),
	CONSTRAINT "user_locations_coordinates_complete_check" CHECK (("user_locations"."latitude" is null) = ("user_locations"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"email" text,
	"phone" text,
	"hashed_email" text GENERATED ALWAYS AS (case when btrim(coalesce(email, '')) = '' then null else encode(sha256(decode(replace(lower(btrim(email)), '\', '\\'), 'escape')), 'hex') end) STORED,
	"hashed_phone" text GENERATED ALWAYS AS (case when regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = '' then null else encode(sha256(decode(replace('+' || regexp_replace(phone, '[^0-9]', '', 'g'), '\', '\\'), 'escape')), 'hex') end) STORED,
	"public_key" text,
	"refresh_token" text,
	"name_first" text,
	"name_last" text,
	"kind" text DEFAULT 'personal' NOT NULL,
	"organization_category" text,
	"parent_account_id" text,
	"root_account_id" text,
	"account_status" text DEFAULT 'active' NOT NULL,
	"type" text DEFAULT 'local' NOT NULL,
	"federation_actor_uri" text,
	"federation_domain" text,
	"federation_actor_id" text,
	"federation_last_avatar_fetched_at" timestamp with time zone,
	"federation_avatar_e_tag" text,
	"federation_avatar_last_modified" text,
	"federation_last_resolved_at" timestamp with time zone,
	"federation_unavailable_at" timestamp with time zone,
	"federation_unavailable_reason" text,
	"automation_owner_id" text,
	"verified" boolean DEFAULT false NOT NULL,
	"reputation_rank_weight" double precision DEFAULT 0.1 NOT NULL,
	"reputation_tier" text DEFAULT 'new' NOT NULL,
	"is_staff" boolean DEFAULT false NOT NULL,
	"is_seed_verifier" boolean DEFAULT false NOT NULL,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"languages" text[] DEFAULT '{"en-US"}' NOT NULL,
	"avatar" text,
	"color" text NOT NULL,
	"bio" text,
	"description" text,
	"address" text,
	"birthday" text,
	"links" text[],
	"account_expires_after_inactivity_days" integer,
	"privacy_is_private_account" boolean DEFAULT false NOT NULL,
	"privacy_hide_online_status" boolean DEFAULT false NOT NULL,
	"privacy_hide_last_seen" boolean DEFAULT false NOT NULL,
	"privacy_profile_visibility" boolean DEFAULT true NOT NULL,
	"privacy_login_alerts" boolean DEFAULT true NOT NULL,
	"privacy_block_screenshots" boolean DEFAULT false NOT NULL,
	"privacy_login" boolean DEFAULT true NOT NULL,
	"privacy_biometric_login" boolean DEFAULT false NOT NULL,
	"privacy_show_activity" boolean DEFAULT true NOT NULL,
	"privacy_allow_tagging" boolean DEFAULT true NOT NULL,
	"privacy_allow_mentions" boolean DEFAULT true NOT NULL,
	"privacy_hide_read_receipts" boolean DEFAULT false NOT NULL,
	"privacy_allow_direct_messages" boolean DEFAULT true NOT NULL,
	"privacy_data_sharing" boolean DEFAULT true NOT NULL,
	"privacy_location_sharing" boolean DEFAULT false NOT NULL,
	"privacy_analytics_sharing" boolean DEFAULT true NOT NULL,
	"privacy_sensitive_content" boolean DEFAULT false NOT NULL,
	"privacy_auto_filter" boolean DEFAULT true NOT NULL,
	"privacy_mute_keywords" boolean DEFAULT false NOT NULL,
	"privacy_discoverable_by_email" boolean DEFAULT false NOT NULL,
	"privacy_discoverable_by_phone" boolean DEFAULT false NOT NULL,
	"privacy_fediverse_sharing" boolean DEFAULT true NOT NULL,
	"email_signature" text,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_subject" text,
	"auto_reply_body" text,
	"auto_reply_start_date" timestamp with time zone,
	"auto_reply_end_date" timestamp with time zone,
	"auto_forward_to" text,
	"auto_forward_keep_copy" boolean DEFAULT true NOT NULL,
	"notification_push_enabled" boolean DEFAULT true NOT NULL,
	"notification_email_digest" boolean DEFAULT true NOT NULL,
	"notification_security_alerts" boolean DEFAULT true NOT NULL,
	"notification_marketing_emails" boolean DEFAULT false NOT NULL,
	"preference_language" text,
	"preference_theme" text DEFAULT 'system' NOT NULL,
	"preference_reduce_motion" boolean DEFAULT false NOT NULL,
	"preference_timezone" text,
	"theme_preference_mode" text,
	"theme_preference_color_preset" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('personal', 'organization', 'project', 'bot')),
	CONSTRAINT "users_organization_category_check" CHECK ("users"."organization_category" is null or "users"."organization_category" in ('agency', 'cooperative', 'landlord', 'other')),
	CONSTRAINT "users_account_status_check" CHECK ("users"."account_status" in ('active', 'archived')),
	CONSTRAINT "users_type_check" CHECK ("users"."type" in ('local', 'federated', 'agent', 'automated')),
	CONSTRAINT "users_reputation_tier_check" CHECK ("users"."reputation_tier" in ('restricted', 'new', 'trusted', 'high_trust', 'verified')),
	CONSTRAINT "users_preference_theme_check" CHECK ("users"."preference_theme" in ('light', 'dark', 'system')),
	CONSTRAINT "users_color_check" CHECK ("users"."color" in ('teal', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'sky', 'orange', 'mint', 'oxy') or "users"."color" ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$'),
	CONSTRAINT "users_account_expires_after_inactivity_days_check" CHECK ("users"."account_expires_after_inactivity_days" is null or "users"."account_expires_after_inactivity_days" in (30, 90, 180, 365)),
	CONSTRAINT "users_theme_preference_check" CHECK (("users"."theme_preference_mode" is null and "users"."theme_preference_color_preset" is null) or ("users"."theme_preference_mode" is not null and "users"."theme_preference_color_preset" is not null and length("users"."theme_preference_color_preset") > 0)),
	CONSTRAINT "users_parent_account_id_not_self_check" CHECK ("users"."parent_account_id" <> "users"."id")
);
--> statement-breakpoint
CREATE TABLE "user_verified_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_verified_domains_method_check" CHECK ("user_verified_domains"."method" in ('dns-txt', 'well-known'))
);
--> statement-breakpoint
ALTER TABLE "user_ancestors" ADD CONSTRAINT "user_ancestors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ancestors" ADD CONSTRAINT "user_ancestors_ancestor_id_users_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_auth_methods" ADD CONSTRAINT "user_auth_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_link_metadata" ADD CONSTRAINT "user_link_metadata_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_parent_account_id_users_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_root_account_id_users_id_fk" FOREIGN KEY ("root_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_automation_owner_id_users_id_fk" FOREIGN KEY ("automation_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verified_domains" ADD CONSTRAINT "user_verified_domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_ancestors_ancestor_id_idx" ON "user_ancestors" USING btree ("ancestor_id");--> statement-breakpoint
CREATE INDEX "user_auth_methods_user_id_idx" ON "user_auth_methods" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_auth_methods_lower_method_public_key_key" ON "user_auth_methods" USING btree (lower("method_public_key")) WHERE "user_auth_methods"."method_public_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_auth_methods_method_credential_id_key" ON "user_auth_methods" USING btree ("method_credential_id") WHERE "user_auth_methods"."method_credential_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_link_metadata_user_id_position_key" ON "user_link_metadata" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "user_locations_user_id_location_key_key" ON "user_locations" USING btree ("user_id","location_key");--> statement-breakpoint
CREATE INDEX "user_locations_city_country_idx" ON "user_locations" USING btree ("city","country");--> statement-breakpoint
CREATE INDEX "user_locations_country_idx" ON "user_locations" USING btree ("country");--> statement-breakpoint
CREATE INDEX "user_locations_type_city_idx" ON "user_locations" USING btree ("type","city");--> statement-breakpoint
CREATE INDEX "user_locations_country_code_city_idx" ON "user_locations" USING btree ("country_code","city");--> statement-breakpoint
CREATE INDEX "user_locations_search_vector_idx" ON "user_locations" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "users_lower_username_key" ON "users" USING btree (lower(btrim("username")));--> statement-breakpoint
CREATE UNIQUE INDEX "users_lower_email_key" ON "users" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE UNIQUE INDEX "users_lower_public_key_key" ON "users" USING btree (lower(btrim("public_key")));--> statement-breakpoint
CREATE UNIQUE INDEX "users_federation_actor_uri_key" ON "users" USING btree ("federation_actor_uri");--> statement-breakpoint
CREATE INDEX "users_hashed_email_idx" ON "users" USING btree ("hashed_email") WHERE "users"."hashed_email" is not null;--> statement-breakpoint
CREATE INDEX "users_hashed_phone_idx" ON "users" USING btree ("hashed_phone") WHERE "users"."hashed_phone" is not null;--> statement-breakpoint
CREATE INDEX "users_kind_parent_account_id_idx" ON "users" USING btree ("kind","parent_account_id");--> statement-breakpoint
CREATE INDEX "users_parent_account_id_idx" ON "users" USING btree ("parent_account_id") WHERE "users"."parent_account_id" is not null;--> statement-breakpoint
CREATE INDEX "users_root_account_id_idx" ON "users" USING btree ("root_account_id") WHERE "users"."root_account_id" is not null;--> statement-breakpoint
CREATE INDEX "users_type_idx" ON "users" USING btree ("type");--> statement-breakpoint
CREATE INDEX "users_federation_domain_idx" ON "users" USING btree ("federation_domain") WHERE "users"."federation_domain" is not null;--> statement-breakpoint
CREATE INDEX "users_federation_last_resolved_at_idx" ON "users" USING btree ("federation_last_resolved_at") WHERE "users"."federation_last_resolved_at" is not null;--> statement-breakpoint
CREATE INDEX "users_federation_unavailable_at_idx" ON "users" USING btree ("federation_unavailable_at") WHERE "users"."federation_unavailable_at" is not null;--> statement-breakpoint
CREATE INDEX "users_automation_owner_id_idx" ON "users" USING btree ("automation_owner_id") WHERE "users"."automation_owner_id" is not null;--> statement-breakpoint
CREATE INDEX "users_reputation_rank_weight_idx" ON "users" USING btree ("reputation_rank_weight");--> statement-breakpoint
CREATE INDEX "users_reputation_tier_idx" ON "users" USING btree ("reputation_tier");--> statement-breakpoint
CREATE INDEX "users_is_sensitive_idx" ON "users" USING btree ("is_sensitive");--> statement-breakpoint
CREATE UNIQUE INDEX "user_verified_domains_user_id_lower_domain_key" ON "user_verified_domains" USING btree ("user_id",lower("domain"));--> statement-breakpoint
CREATE INDEX "user_verified_domains_lower_domain_idx" ON "user_verified_domains" USING btree (lower("domain"));--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;