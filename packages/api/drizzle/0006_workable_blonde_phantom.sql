-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "account_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"secret_hash" text,
	"type" text DEFAULT 'service' NOT NULL,
	"environment" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotated_from_credential_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_credentials_public_key_key" UNIQUE("public_key"),
	CONSTRAINT "account_credentials_type_check" CHECK ("account_credentials"."type" in ('service')),
	CONSTRAINT "account_credentials_environment_check" CHECK ("account_credentials"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "account_credentials_status_check" CHECK ("account_credentials"."status" in ('active', 'deprecated', 'revoked')),
	CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write']::text[]),
	CONSTRAINT "account_credentials_rotated_from_not_self_check" CHECK ("account_credentials"."rotated_from_credential_id" <> "account_credentials"."id")
);
--> statement-breakpoint
CREATE TABLE "account_members" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"role" text NOT NULL,
	"inherit" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_members_account_id_member_user_id_key" UNIQUE("account_id","member_user_id"),
	CONSTRAINT "account_members_role_check" CHECK ("account_members"."role" in ('owner', 'admin', 'editor', 'developer', 'billing', 'viewer')),
	CONSTRAINT "account_members_status_check" CHECK ("account_members"."status" in ('active', 'invited', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "api_key_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text,
	"user_id" text NOT NULL,
	"application_id" text,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"credits_used" double precision DEFAULT 0 NOT NULL,
	"response_time" double precision,
	"user_agent" text,
	"auth_type" text DEFAULT 'api_key' NOT NULL,
	"service_app" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_usage_events_method_check" CHECK ("api_key_usage_events"."method" in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "api_key_usage_events_auth_type_check" CHECK ("api_key_usage_events"."auth_type" in ('api_key', 'session', 'internal')),
	CONSTRAINT "api_key_usage_events_status_code_check" CHECK ("api_key_usage_events"."status_code" >= 100 and "api_key_usage_events"."status_code" < 600),
	CONSTRAINT "api_key_usage_events_consumption_check" CHECK ("api_key_usage_events"."tokens_used" >= 0 and "api_key_usage_events"."credits_used" >= 0
        and ("api_key_usage_events"."response_time" is null or "api_key_usage_events"."response_time" >= 0))
);
--> statement-breakpoint
CREATE TABLE "app_affinity_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"affinity" double precision DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_affinity_edges_directed_edge_key" UNIQUE("application_id","from_user_id","to_user_id"),
	CONSTRAINT "app_affinity_edges_not_self_check" CHECK ("app_affinity_edges"."from_user_id" <> "app_affinity_edges"."to_user_id"),
	CONSTRAINT "app_affinity_edges_affinity_check" CHECK ("app_affinity_edges"."affinity" >= 0 and "app_affinity_edges"."event_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app_endorsement_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"member_id" text NOT NULL,
	"source_id" text,
	"weight" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_endorsement_edges_idempotency_key" UNIQUE NULLS NOT DISTINCT("application_id","owner_id","member_id","source_id"),
	CONSTRAINT "app_endorsement_edges_not_self_check" CHECK ("app_endorsement_edges"."owner_id" <> "app_endorsement_edges"."member_id"),
	CONSTRAINT "app_endorsement_edges_source_id_check" CHECK ("app_endorsement_edges"."source_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "app_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_grants_user_id_application_id_key" UNIQUE("user_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "app_update_assets" (
	"app_update_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"sha256" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"file_extension" text,
	CONSTRAINT "app_update_assets_pkey" PRIMARY KEY("app_update_id","ordinal"),
	CONSTRAINT "app_update_assets_ordinal_check" CHECK ("app_update_assets"."ordinal" >= 0),
	CONSTRAINT "app_update_assets_sha256_check" CHECK ("app_update_assets"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"update_id" text NOT NULL,
	"application_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"runtime_version" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"launch_asset_sha256" text NOT NULL,
	"launch_asset_key" text NOT NULL,
	"launch_asset_content_type" text NOT NULL,
	"launch_asset_file_extension" text,
	"extra" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rollout_percent" integer DEFAULT 100 NOT NULL,
	"git_commit" text,
	"git_branch" text,
	"message" text,
	"promoted_from_update_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_updates_update_id_key" UNIQUE("update_id"),
	CONSTRAINT "app_updates_platform_check" CHECK ("app_updates"."platform" in ('ios', 'android')),
	CONSTRAINT "app_updates_status_check" CHECK ("app_updates"."status" in ('published', 'superseded', 'rolled_back')),
	CONSTRAINT "app_updates_update_id_check" CHECK ("app_updates"."update_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "app_updates_launch_asset_sha256_check" CHECK ("app_updates"."launch_asset_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "app_updates_rollout_percent_check" CHECK ("app_updates"."rollout_percent" >= 0 and "app_updates"."rollout_percent" <= 100),
	CONSTRAINT "app_updates_extra_expo_client_check" CHECK (jsonb_typeof("app_updates"."extra" -> 'expoClient') is not distinct from 'object'),
	CONSTRAINT "app_updates_metadata_check" CHECK (jsonb_typeof("app_updates"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_user_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endorsement_score" double precision DEFAULT 0 NOT NULL,
	"interest_score" double precision DEFAULT 0 NOT NULL,
	"last_endorsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_signals_application_id_user_id_key" UNIQUE("application_id","user_id"),
	CONSTRAINT "app_user_signals_interest_score_check" CHECK ("app_user_signals"."interest_score" >= 0 and "app_user_signals"."interest_score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "application_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"secret_hash" text,
	"type" text NOT NULL,
	"environment" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotated_from_credential_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_credentials_public_key_key" UNIQUE("public_key"),
	CONSTRAINT "application_credentials_type_check" CHECK ("application_credentials"."type" in ('public', 'confidential', 'service')),
	CONSTRAINT "application_credentials_environment_check" CHECK ("application_credentials"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "application_credentials_status_check" CHECK ("application_credentials"."status" in ('active', 'deprecated', 'revoked')),
	CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write']::text[]),
	CONSTRAINT "application_credentials_rotated_from_not_self_check" CHECK ("application_credentials"."rotated_from_credential_id" <> "application_credentials"."id")
);
--> statement-breakpoint
CREATE TABLE "application_moderation_trust" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"standing" text DEFAULT 'sandbox' NOT NULL,
	"evidence_integrity" double precision DEFAULT 0 NOT NULL,
	"identity_binding_reliability" double precision DEFAULT 0 NOT NULL,
	"decision_overturn_rate" double precision DEFAULT 0 NOT NULL,
	"policy_quality" double precision DEFAULT 0 NOT NULL,
	"global_reputation_effects_allowed" boolean DEFAULT false NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_moderation_trust_application_id_key" UNIQUE("application_id"),
	CONSTRAINT "application_moderation_trust_standing_check" CHECK ("application_moderation_trust"."standing" in ('sandbox', 'trusted', 'restricted')),
	CONSTRAINT "application_moderation_trust_scores_check" CHECK ("application_moderation_trust"."evidence_integrity" between 0 and 1
        and "application_moderation_trust"."identity_binding_reliability" between 0 and 1
        and "application_moderation_trust"."decision_overturn_rate" between 0 and 1
        and "application_moderation_trust"."policy_quality" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"website_url" text,
	"privacy_policy_url" text,
	"terms_url" text,
	"icon" text,
	"type" text DEFAULT 'third_party' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"dev_webhook_url" text,
	"owner_account_id" text NOT NULL,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_type_check" CHECK ("applications"."type" in ('first_party', 'third_party', 'internal', 'system')),
	CONSTRAINT "applications_status_check" CHECK ("applications"."status" in ('active', 'suspended', 'deleted', 'pending_review')),
	CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "developer_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{"chat:completions","models:read"}' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"rate_limit_requests_per_minute" integer,
	"rate_limit_requests_per_day" integer DEFAULT 1000,
	"rate_limit_tokens_per_minute" integer,
	"rate_limit_tokens_per_day" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "developer_api_keys_key_hash_key" UNIQUE("key_hash"),
	CONSTRAINT "developer_api_keys_scopes_check" CHECK ("developer_api_keys"."scopes" <@ array['chat:completions', 'models:read', 'files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive']::text[]),
	CONSTRAINT "developer_api_keys_rate_limit_check" CHECK (("developer_api_keys"."rate_limit_requests_per_minute" is null or "developer_api_keys"."rate_limit_requests_per_minute" > 0)
        and ("developer_api_keys"."rate_limit_requests_per_day" is null or "developer_api_keys"."rate_limit_requests_per_day" > 0)
        and ("developer_api_keys"."rate_limit_tokens_per_minute" is null or "developer_api_keys"."rate_limit_tokens_per_minute" > 0)
        and ("developer_api_keys"."rate_limit_tokens_per_day" is null or "developer_api_keys"."rate_limit_tokens_per_day" > 0))
);
--> statement-breakpoint
CREATE TABLE "update_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"s3_key" text GENERATED ALWAYS AS ('public/updates/assets/' || sha256) STORED NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_assets_sha256_key" UNIQUE("sha256"),
	CONSTRAINT "update_assets_status_check" CHECK ("update_assets"."status" in ('pending', 'uploaded')),
	CONSTRAINT "update_assets_sha256_check" CHECK ("update_assets"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "update_assets_size_check" CHECK ("update_assets"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "update_channel_rollbacks" (
	"channel_id" text NOT NULL,
	"runtime_version" text NOT NULL,
	"platform" text NOT NULL,
	"commit_time" timestamp with time zone NOT NULL,
	CONSTRAINT "update_channel_rollbacks_pkey" PRIMARY KEY("channel_id","runtime_version","platform"),
	CONSTRAINT "update_channel_rollbacks_platform_check" CHECK ("update_channel_rollbacks"."platform" in ('ios', 'android'))
);
--> statement-breakpoint
CREATE TABLE "update_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_channels_application_id_name_key" UNIQUE("application_id","name")
);
--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_rotated_from_fk" FOREIGN KEY ("rotated_from_credential_id") REFERENCES "public"."account_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage_events" ADD CONSTRAINT "api_key_usage_events_api_key_id_developer_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."developer_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage_events" ADD CONSTRAINT "api_key_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage_events" ADD CONSTRAINT "api_key_usage_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_affinity_edges" ADD CONSTRAINT "app_affinity_edges_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_affinity_edges" ADD CONSTRAINT "app_affinity_edges_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_affinity_edges" ADD CONSTRAINT "app_affinity_edges_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_endorsement_edges" ADD CONSTRAINT "app_endorsement_edges_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_endorsement_edges" ADD CONSTRAINT "app_endorsement_edges_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_endorsement_edges" ADD CONSTRAINT "app_endorsement_edges_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_update_assets" ADD CONSTRAINT "app_update_assets_app_update_id_app_updates_id_fk" FOREIGN KEY ("app_update_id") REFERENCES "public"."app_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_update_assets" ADD CONSTRAINT "app_update_assets_sha256_update_assets_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."update_assets"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_channel_id_update_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."update_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_launch_asset_sha256_update_assets_sha256_fk" FOREIGN KEY ("launch_asset_sha256") REFERENCES "public"."update_assets"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_promoted_from_update_id_app_updates_update_id_fk" FOREIGN KEY ("promoted_from_update_id") REFERENCES "public"."app_updates"("update_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_signals" ADD CONSTRAINT "app_user_signals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_signals" ADD CONSTRAINT "app_user_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_rotated_from_fk" FOREIGN KEY ("rotated_from_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_moderation_trust" ADD CONSTRAINT "application_moderation_trust_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_moderation_trust" ADD CONSTRAINT "application_moderation_trust_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_channel_rollbacks" ADD CONSTRAINT "update_channel_rollbacks_channel_id_update_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."update_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_channels" ADD CONSTRAINT "update_channels_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_credentials_account_id_status_idx" ON "account_credentials" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "account_members_member_user_id_status_idx" ON "account_members" USING btree ("member_user_id","status");--> statement-breakpoint
CREATE INDEX "api_key_usage_events_application_id_created_at_idx" ON "api_key_usage_events" USING btree ("application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_events_user_id_created_at_idx" ON "api_key_usage_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_events_api_key_id_created_at_idx" ON "api_key_usage_events" USING btree ("api_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_events_created_at_idx" ON "api_key_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_affinity_edges_application_id_from_user_id_affinity_idx" ON "app_affinity_edges" USING btree ("application_id","from_user_id","affinity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_affinity_edges_application_id_to_user_id_idx" ON "app_affinity_edges" USING btree ("application_id","to_user_id");--> statement-breakpoint
CREATE INDEX "app_endorsement_edges_application_id_member_id_idx" ON "app_endorsement_edges" USING btree ("application_id","member_id");--> statement-breakpoint
CREATE INDEX "app_grants_application_id_idx" ON "app_grants" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "app_update_assets_sha256_idx" ON "app_update_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "app_updates_head_idx" ON "app_updates" USING btree ("application_id","channel_id","runtime_version","platform","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_updates_channel_id_idx" ON "app_updates" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "app_user_signals_application_id_endorsement_score_idx" ON "app_user_signals" USING btree ("application_id","endorsement_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_user_signals_user_id_idx" ON "app_user_signals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "application_credentials_application_id_status_idx" ON "application_credentials" USING btree ("application_id","status");--> statement-breakpoint
CREATE INDEX "application_moderation_trust_standing_idx" ON "application_moderation_trust" USING btree ("standing");--> statement-breakpoint
CREATE INDEX "applications_owner_account_id_created_at_idx" ON "applications" USING btree ("owner_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_capabilities_idx" ON "applications" USING gin ("capabilities");--> statement-breakpoint
CREATE INDEX "developer_api_keys_user_id_is_active_idx" ON "developer_api_keys" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "developer_api_keys_application_id_is_active_idx" ON "developer_api_keys" USING btree ("application_id","is_active");--> statement-breakpoint
ALTER TABLE "app_affinity_seen_events" ADD CONSTRAINT "app_affinity_seen_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conduct_strikes" ADD CONSTRAINT "conduct_strikes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_credential_id_application_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_credential_id_application_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_credential_id_application_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_requests" ADD CONSTRAINT "validation_requests_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;