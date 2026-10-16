-- oxy:deploy-phase=pre
-- ADR 0042: an agent's owner publishes what the agent may do in one app for
-- whoever uses it (`agent_requester_ceilings`), and an execution authorization
-- may name the ceiling that bounds it (`ceiling_id`).
--
-- `pre`: a new table and a nullable column with a CHECK that every existing row
-- satisfies (`ceiling_id is null`). The image still serving never reads or
-- writes either, so nothing it does can fail.
CREATE TABLE "agent_requester_ceilings" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_account_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"catalog_registration_id" text NOT NULL,
	"capability_packages" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"tool_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maximum_autonomy" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_requester_ceilings_autonomy_check" CHECK ("agent_requester_ceilings"."maximum_autonomy" in ('read_only', 'autonomous')),
	CONSTRAINT "agent_requester_ceilings_packages_check" CHECK ("agent_requester_ceilings"."capability_packages" <@ array['read', 'create', 'publish', 'communicate', 'administer', 'finance', 'security', 'delegate']::text[]),
	CONSTRAINT "agent_requester_ceilings_version_check" CHECK ("agent_requester_ceilings"."version" > 0),
	CONSTRAINT "agent_requester_ceilings_overrides_check" CHECK (jsonb_typeof("agent_requester_ceilings"."tool_overrides") = 'array'
        and not jsonb_path_exists("agent_requester_ceilings"."tool_overrides", '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.decision) || (@.decision != "allow" && @.decision != "deny"))')
        and not jsonb_path_exists("agent_requester_ceilings"."tool_overrides", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "decision")')),
	CONSTRAINT "agent_requester_ceilings_limits_check" CHECK (jsonb_typeof("agent_requester_ceilings"."limits") = 'array'
        and not jsonb_path_exists("agent_requester_ceilings"."limits", '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists("agent_requester_ceilings"."limits", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")'))
);
--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "ceiling_id" text;--> statement-breakpoint
ALTER TABLE "agent_requester_ceilings" ADD CONSTRAINT "agent_requester_ceilings_agent_account_id_users_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requester_ceilings" ADD CONSTRAINT "agent_requester_ceilings_catalog_registration_id_app_capability_catalog_registrations_id_fk" FOREIGN KEY ("catalog_registration_id") REFERENCES "public"."app_capability_catalog_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requester_ceilings" ADD CONSTRAINT "agent_requester_ceilings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requester_ceilings" ADD CONSTRAINT "agent_requester_ceilings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_requester_ceilings_live_key" ON "agent_requester_ceilings" USING btree ("agent_account_id","app_slug") WHERE "agent_requester_ceilings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "agent_requester_ceilings_catalog_registration_idx" ON "agent_requester_ceilings" USING btree ("catalog_registration_id");--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_ceiling_id_agent_requester_ceilings_id_fk" FOREIGN KEY ("ceiling_id") REFERENCES "public"."agent_requester_ceilings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_execution_ceiling_idx" ON "capability_execution_authorizations" USING btree ("ceiling_id") WHERE "capability_execution_authorizations"."ceiling_id" is not null;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_ceiling_scope_check" CHECK ("capability_execution_authorizations"."ceiling_id" is null or (
        "capability_execution_authorizations"."actor_type" = 'agent'
        and "capability_execution_authorizations"."owner_account_id" = "capability_execution_authorizations"."requester_account_id"
        and "capability_execution_authorizations"."resource_key" = "capability_execution_authorizations"."effective_account_id"));