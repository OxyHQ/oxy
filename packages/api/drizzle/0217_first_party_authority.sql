-- oxy:deploy-phase=pre
CREATE TABLE "first_party_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"origin_kind" text NOT NULL,
	"origin_id" text NOT NULL,
	"requester_account_id" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"requester_session_id" text NOT NULL,
	"requester_session_binding_digest" text NOT NULL,
	"requester_auth_method_id" text,
	"coordinator_application_id" text NOT NULL,
	"coordinator_credential_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_account_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "first_party_tasks_origin_check" CHECK ("first_party_tasks"."origin_kind" in ('request', 'goal', 'automation')),
	CONSTRAINT "first_party_tasks_digest_check" CHECK ("first_party_tasks"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "first_party_tasks_actor_check" CHECK (("first_party_tasks"."actor_type" = 'alia' and "first_party_tasks"."actor_account_id" is null) or ("first_party_tasks"."actor_type" in ('agent', 'requester') and "first_party_tasks"."actor_account_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" DROP CONSTRAINT "capability_execution_requester_session_check";--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" DROP CONSTRAINT "capability_execution_requester_catalog_check";--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "oauth_authority" text;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_requester_account_id_users_id_fk" FOREIGN KEY ("requester_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_effective_account_id_users_id_fk" FOREIGN KEY ("effective_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_coordinator_application_id_applications_id_fk" FOREIGN KEY ("coordinator_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_coordinator_credential_id_application_credentials_id_fk" FOREIGN KEY ("coordinator_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_actor_account_id_users_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_tasks" ADD CONSTRAINT "first_party_tasks_requester_method_fk" FOREIGN KEY ("requester_auth_method_id","requester_account_id") REFERENCES "public"."user_auth_methods"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "first_party_tasks_expiry_idx" ON "first_party_tasks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "first_party_tasks_revoked_idx" ON "first_party_tasks" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "first_party_tasks_requester_idx" ON "first_party_tasks" USING btree ("requester_account_id","created_at");--> statement-breakpoint
CREATE INDEX "first_party_tasks_origin_idx" ON "first_party_tasks" USING btree ("coordinator_application_id","origin_kind","origin_id");--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_task_id_first_party_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."first_party_tasks"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authority_check" CHECK ("capability_execution_authorizations"."authority" in ('first_party', 'external'));--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_session_check" CHECK (
      case when coalesce("capability_execution_authorizations"."authority", 'external') = 'first_party' then
        ("capability_execution_authorizations"."requester_session_id" is not null and length("capability_execution_authorizations"."requester_session_id") > 0
         and "capability_execution_authorizations"."requester_session_binding_digest" is not null and "capability_execution_authorizations"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$' and "capability_execution_authorizations"."ceiling_id" is null)
      else ("capability_execution_authorizations"."actor_type" = 'requester' and "capability_execution_authorizations"."requester_session_id" is not null and length("capability_execution_authorizations"."requester_session_id") > 0
       and "capability_execution_authorizations"."requester_session_binding_digest" is not null
       and "capability_execution_authorizations"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$'
       and "capability_execution_authorizations"."kind" = 'direct_request' and "capability_execution_authorizations"."maximum_autonomy" = 'read_only'
       and "capability_execution_authorizations"."actor_account_id" = "capability_execution_authorizations"."requester_account_id")
      or ("capability_execution_authorizations"."actor_type" <> 'requester' and "capability_execution_authorizations"."requester_session_id" is null and "capability_execution_authorizations"."requester_session_binding_digest" is null) end);--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_catalog_check" CHECK (
      case when coalesce("capability_execution_authorizations"."authority", 'external') = 'first_party' then
        ("capability_execution_authorizations"."requester_catalog_registration_id" is not null and length("capability_execution_authorizations"."requester_catalog_registration_id") > 0
         and "capability_execution_authorizations"."requester_catalog_version" is not null and length("capability_execution_authorizations"."requester_catalog_version") > 0
         and "capability_execution_authorizations"."requester_catalog_digest" is not null and "capability_execution_authorizations"."requester_catalog_digest" ~ '^[a-f0-9]{64}$')
      else ("capability_execution_authorizations"."actor_type" = 'requester' and (
        ("capability_execution_authorizations"."requester_catalog_registration_id" is not null and length("capability_execution_authorizations"."requester_catalog_registration_id") > 0
         and "capability_execution_authorizations"."requester_catalog_version" is not null and length("capability_execution_authorizations"."requester_catalog_version") > 0
         and "capability_execution_authorizations"."requester_catalog_digest" is not null and "capability_execution_authorizations"."requester_catalog_digest" ~ '^[a-f0-9]{64}$')
        or ("capability_execution_authorizations"."revoked_at" is not null and "capability_execution_authorizations"."requester_catalog_registration_id" is null
         and "capability_execution_authorizations"."requester_catalog_version" is null and "capability_execution_authorizations"."requester_catalog_digest" is null)))
      or ("capability_execution_authorizations"."actor_type" <> 'requester' and "capability_execution_authorizations"."requester_catalog_registration_id" is null
       and "capability_execution_authorizations"."requester_catalog_version" is null and "capability_execution_authorizations"."requester_catalog_digest" is null) end);--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_authority_check" CHECK ("auth_codes"."authority" in ('first_party', 'external'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_oauth_authority_check" CHECK ("auth_sessions"."oauth_authority" in ('first_party', 'external'));