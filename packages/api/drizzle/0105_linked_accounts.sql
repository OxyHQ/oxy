-- oxy:deploy-phase=pre
-- Linked external accounts (docs/identity/linked-accounts.md) and the `system`
-- notification type. Additive only: three new tables nothing in the running
-- image reads, and four CHECK constraints WIDENED — the scope vocabulary gains
-- `linked-accounts:read` on applications, credentials and workload bindings,
-- and `notifications.type` gains `system`. Every existing row satisfies the
-- wider set, and the previous image writes none of the new values, so this is
-- safe ahead of the rollout; `post` would leave the new image writing a scope
-- or notification type the old CHECK refuses for the length of a rollout.
CREATE TABLE "linked_account_oauth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"network" text NOT NULL,
	"state_hash" text,
	"host" text,
	"pkce_verifier" text,
	"provider_state" jsonb,
	"client_application_id" text,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "linked_account_oauth_challenges_network_check" CHECK ("linked_account_oauth_challenges"."network" in ('activitypub', 'atproto')),
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
	"use_as_alias" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_linked_accounts_network_check" CHECK ("user_linked_accounts"."network" in ('activitypub', 'atproto')),
	CONSTRAINT "user_linked_accounts_proof_method_check" CHECK ("user_linked_accounts"."proof_method" in ('oauth')),
	CONSTRAINT "user_linked_accounts_alias_network_check" CHECK ("user_linked_accounts"."network" = 'activitypub' or "user_linked_accounts"."use_as_alias" = false)
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "linked_account_oauth_challenges" ADD CONSTRAINT "linked_account_oauth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_account_oauth_challenges" ADD CONSTRAINT "linked_account_oauth_challenges_client_application_id_applications_id_fk" FOREIGN KEY ("client_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_linked_accounts" ADD CONSTRAINT "user_linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_account_oauth_challenges_state_hash_key" ON "linked_account_oauth_challenges" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "linked_account_oauth_challenges_expires_at_idx" ON "linked_account_oauth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "linked_account_oauth_challenges_user_id_idx" ON "linked_account_oauth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_linked_accounts_live_account_key" ON "user_linked_accounts" USING btree ("network","account_key") WHERE "user_linked_accounts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_linked_accounts_user_id_idx" ON "user_linked_accounts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read']::text[]);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'repost', 'quote', 'welcome', 'system'));