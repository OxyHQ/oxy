-- oxy:deploy-phase=pre
-- Linked external accounts and inbound ActivityPub Moves
-- (docs/identity/linked-accounts.md), and `system` notifications. Additive only:
-- four new tables nothing in the running image reads; three new nullable
-- `notifications` columns the previous image never names; and CHECKs that only
-- WIDEN (three new privileged scopes, notification type `system`, entity type
-- `app`) or constrain those new columns and values. Every existing row passes —
-- no row carries a new scope, type or entity type, and the new columns are null
-- — and the previous image writes none of them, so this is safe ahead of the
-- rollout; `post` would leave the new image writing values and columns the old
-- schema refuses for the length of a rollout.
CREATE TABLE "linked_account_oauth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"network" text NOT NULL,
	"state_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"host" text,
	"pkce_verifier" text,
	"provider_state" jsonb,
	"client_application_id" text NOT NULL,
	"return_to" text NOT NULL,
	"account_key" text,
	"actor_uri" text,
	"handle" text,
	"link_code_hash" text,
	"linked_account_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "linked_account_oauth_challenges_network_check" CHECK ("linked_account_oauth_challenges"."network" in ('activitypub', 'atproto')),
	CONSTRAINT "linked_account_oauth_challenges_status_check" CHECK ("linked_account_oauth_challenges"."status" in ('pending', 'verified', 'linked', 'refused')),
	CONSTRAINT "linked_account_oauth_challenges_verified_account_check" CHECK ("linked_account_oauth_challenges"."status" = 'pending' or ("linked_account_oauth_challenges"."account_key" is not null and "linked_account_oauth_challenges"."actor_uri" is not null and "linked_account_oauth_challenges"."handle" is not null and "linked_account_oauth_challenges"."host" is not null)),
	CONSTRAINT "linked_account_oauth_challenges_link_code_hash_check" CHECK ("linked_account_oauth_challenges"."link_code_hash" is null or "linked_account_oauth_challenges"."link_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "linked_account_oauth_challenges_state_hash_check" CHECK ("linked_account_oauth_challenges"."state_hash" is null or "linked_account_oauth_challenges"."state_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mastodon_app_registrations" (
	"host" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_linked_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"network" text NOT NULL,
	"account_key" text NOT NULL,
	"actor_uri" text NOT NULL,
	"handle" text NOT NULL,
	"host" text NOT NULL,
	"proof_method" text DEFAULT 'oauth' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_linked_accounts_network_check" CHECK ("user_linked_accounts"."network" in ('activitypub', 'atproto')),
	CONSTRAINT "user_linked_accounts_proof_method_check" CHECK ("user_linked_accounts"."proof_method" in ('oauth'))
);
--> statement-breakpoint
CREATE TABLE "federated_account_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"activity_id" text NOT NULL,
	"old_actor_uri" text NOT NULL,
	"target_actor_uri" text NOT NULL,
	"old_user_id" text,
	"target_user_id" text NOT NULL,
	"requested_by_application_id" text,
	"followers_moved" integer DEFAULT 0 NOT NULL,
	"already_following" integer DEFAULT 0 NOT NULL,
	"skipped_blocked" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_account_moves_counts_check" CHECK ("federated_account_moves"."followers_moved" >= 0 and "federated_account_moves"."already_following" >= 0 and "federated_account_moves"."skipped_blocked" >= 0)
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_entity_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "linked_account_oauth_challenges" ADD CONSTRAINT "linked_account_oauth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_account_oauth_challenges" ADD CONSTRAINT "linked_account_oauth_challenges_client_application_id_applications_id_fk" FOREIGN KEY ("client_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_account_oauth_challenges" ADD CONSTRAINT "linked_account_oauth_challenges_linked_account_id_user_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."user_linked_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_linked_accounts" ADD CONSTRAINT "user_linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_old_user_id_users_id_fk" FOREIGN KEY ("old_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_requested_by_application_id_applications_id_fk" FOREIGN KEY ("requested_by_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_account_oauth_challenges_state_hash_key" ON "linked_account_oauth_challenges" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "linked_account_oauth_challenges_link_code_hash_key" ON "linked_account_oauth_challenges" USING btree ("link_code_hash");--> statement-breakpoint
CREATE INDEX "linked_account_oauth_challenges_expires_at_idx" ON "linked_account_oauth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "linked_account_oauth_challenges_user_id_idx" ON "linked_account_oauth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_linked_accounts_live_account_key" ON "user_linked_accounts" USING btree ("network","account_key") WHERE "user_linked_accounts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_linked_accounts_user_id_idx" ON "user_linked_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federated_account_moves_activity_id_key" ON "federated_account_moves" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "federated_account_moves_target_user_id_idx" ON "federated_account_moves" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "federated_account_moves_old_user_id_idx" ON "federated_account_moves" USING btree ("old_user_id");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve']::text[]);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_system_text_check" CHECK (("notifications"."type" = 'system') = ("notifications"."title" is not null and "notifications"."message" is not null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_app_entity_system_only_check" CHECK ("notifications"."entity_type" <> 'app' or "notifications"."type" = 'system');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_url_system_only_check" CHECK ("notifications"."url" is null or "notifications"."type" = 'system');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_title_length_check" CHECK ("notifications"."title" is null or char_length("notifications"."title") between 1 and 120);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_length_check" CHECK ("notifications"."message" is null or char_length("notifications"."message") between 1 and 500);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_url_length_check" CHECK ("notifications"."url" is null or char_length("notifications"."url") between 1 and 2048);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'repost', 'quote', 'welcome', 'system'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check" CHECK ("notifications"."entity_type" in ('post', 'reply', 'profile', 'app'));