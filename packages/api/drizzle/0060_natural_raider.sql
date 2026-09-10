-- oxy:deploy-phase=pre
CREATE TABLE "capability_execution_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"requester_account_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"coordinator_application_id" text NOT NULL,
	"coordinator_credential_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_account_id" text,
	"resource_app" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_key" text NOT NULL,
	"tool" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"automation_id" text,
	"maximum_autonomy" text NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capability_execution_authorizations_kind_check" CHECK ("capability_execution_authorizations"."kind" in ('direct_request', 'automation')),
	CONSTRAINT "capability_execution_authorizations_actor_check" CHECK (("capability_execution_authorizations"."actor_type" = 'alia' and "capability_execution_authorizations"."actor_account_id" is null) or ("capability_execution_authorizations"."actor_type" = 'agent' and "capability_execution_authorizations"."actor_account_id" is not null)),
	CONSTRAINT "capability_execution_authorizations_automation_check" CHECK (("capability_execution_authorizations"."kind" = 'automation') = ("capability_execution_authorizations"."automation_id" is not null)),
	CONSTRAINT "capability_execution_authorizations_autonomy_check" CHECK ("capability_execution_authorizations"."maximum_autonomy" in ('read_only', 'draft', 'execute_on_request', 'autonomous'))
);
--> statement-breakpoint
ALTER TABLE "delegation_limits" ADD COLUMN "tool" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_requester_account_id_users_id_fk" FOREIGN KEY ("requester_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_coordinator_application_id_applications_id_fk" FOREIGN KEY ("coordinator_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_coordinator_credential_id_application_credentials_id_fk" FOREIGN KEY ("coordinator_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_actor_account_id_users_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_effective_account_id_users_id_fk" FOREIGN KEY ("effective_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_execution_authorizations_live_idx" ON "capability_execution_authorizations" USING btree ("id","expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "capability_execution_authorizations_owner_idx" ON "capability_execution_authorizations" USING btree ("owner_account_id","created_at");--> statement-breakpoint
CREATE INDEX "capability_execution_authorizations_coordinator_idx" ON "capability_execution_authorizations" USING btree ("coordinator_application_id","coordinator_credential_id");
