-- oxy:deploy-phase=pre
CREATE TABLE "account_capability_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"maximum_autonomy" text NOT NULL,
	"denied_capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_capability_policies_account_app_key" UNIQUE("account_id","app_slug"),
	CONSTRAINT "account_capability_policies_autonomy_check" CHECK ("account_capability_policies"."maximum_autonomy" in ('read_only', 'draft', 'execute_on_request', 'autonomous'))
);
--> statement-breakpoint
CREATE TABLE "app_capability_catalog_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"app_slug" text NOT NULL,
	"version" text NOT NULL,
	"audience" text NOT NULL,
	"catalog" jsonb NOT NULL,
	"digest" text NOT NULL,
	"signature" text NOT NULL,
	"registered_by_application_id" text NOT NULL,
	"registered_by_credential_id" text NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_capability_catalog_version_digest_key" UNIQUE("app_slug","version","digest")
);
--> statement-breakpoint
CREATE TABLE "capability_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"effective_account_key" text NOT NULL,
	"executor_account_key" text,
	"run_key" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capability_audit_events_event_key" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "capability_idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"effective_account_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"tool" text NOT NULL,
	"key_hash" text NOT NULL,
	"ticket_jti" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capability_idempotency_keys_effect_key" UNIQUE("effective_account_id","app_slug","tool","key_hash"),
	CONSTRAINT "capability_idempotency_keys_status_check" CHECK ("capability_idempotency_keys"."status" in ('started', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "delegation_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"capability" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "delegation_capabilities_grant_capability_key" UNIQUE("grant_id","capability")
);
--> statement-breakpoint
CREATE TABLE "delegation_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"resource_app" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_key" text NOT NULL,
	"capability_packages" text[] DEFAULT '{}'::text[] NOT NULL,
	"maximum_autonomy" text NOT NULL,
	"can_redelegate" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "delegation_grants_autonomy_check" CHECK ("delegation_grants"."maximum_autonomy" in ('read_only', 'draft', 'execute_on_request', 'autonomous')),
	CONSTRAINT "delegation_grants_packages_check" CHECK ("delegation_grants"."capability_packages" <@ array['read', 'create', 'publish', 'communicate', 'administer', 'finance', 'security', 'delegate']::text[])
);
--> statement-breakpoint
CREATE TABLE "delegation_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "delegation_limits_grant_key_key" UNIQUE("grant_id","key")
);
--> statement-breakpoint
CREATE TABLE "delegation_tool_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"tool" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "delegation_tool_overrides_grant_tool_key" UNIQUE("grant_id","tool"),
	CONSTRAINT "delegation_tool_overrides_decision_check" CHECK ("delegation_tool_overrides"."decision" in ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "account_capability_policies" ADD CONSTRAINT "account_capability_policies_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_capability_catalog_registrations" ADD CONSTRAINT "app_capability_catalog_registrations_registered_by_application_id_applications_id_fk" FOREIGN KEY ("registered_by_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_capability_catalog_registrations" ADD CONSTRAINT "app_capability_catalog_registrations_registered_by_credential_id_application_credentials_id_fk" FOREIGN KEY ("registered_by_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_idempotency_keys" ADD CONSTRAINT "capability_idempotency_keys_effective_account_id_users_id_fk" FOREIGN KEY ("effective_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_capabilities" ADD CONSTRAINT "delegation_capabilities_grant_id_delegation_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_actor_account_id_users_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_effective_account_id_users_id_fk" FOREIGN KEY ("effective_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_limits" ADD CONSTRAINT "delegation_limits_grant_id_delegation_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_tool_overrides" ADD CONSTRAINT "delegation_tool_overrides_grant_id_delegation_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_capability_catalog_active_key" ON "app_capability_catalog_registrations" USING btree ("app_slug") WHERE "app_capability_catalog_registrations"."active";--> statement-breakpoint
CREATE INDEX "app_capability_catalog_application_idx" ON "app_capability_catalog_registrations" USING btree ("registered_by_application_id");--> statement-breakpoint
CREATE INDEX "capability_audit_events_account_created_idx" ON "capability_audit_events" USING btree ("effective_account_key","created_at");--> statement-breakpoint
CREATE INDEX "capability_audit_events_executor_created_idx" ON "capability_audit_events" USING btree ("executor_account_key","created_at");--> statement-breakpoint
CREATE INDEX "capability_audit_events_run_created_idx" ON "capability_audit_events" USING btree ("run_key","created_at");--> statement-breakpoint
CREATE INDEX "delegation_grants_actor_resource_idx" ON "delegation_grants" USING btree ("owner_account_id","actor_account_id","resource_app","effective_account_id","resource_type","resource_key");--> statement-breakpoint
CREATE INDEX "delegation_grants_expiry_idx" ON "delegation_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "delegation_grants_revoked_at_idx" ON "delegation_grants" USING btree ("revoked_at");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);
