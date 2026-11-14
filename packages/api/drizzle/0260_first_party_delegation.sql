-- oxy:deploy-phase=pre
-- ADR 0066: what Oxy services do for people (counted per day), and own tool
-- operations on a service's declared authority, which no session or task backs.
CREATE TABLE "first_party_delegation_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"requester_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"receiver" text NOT NULL,
	"effect" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "first_party_delegation_activity_key" UNIQUE("account_id","requester_account_id","application_id","receiver","effect","day"),
	CONSTRAINT "first_party_delegation_activity_effect_check" CHECK ("first_party_delegation_activity"."effect" in ('read', 'write')),
	CONSTRAINT "first_party_delegation_activity_count_check" CHECK ("first_party_delegation_activity"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" DROP CONSTRAINT "capability_execution_requester_session_check";--> statement-breakpoint
ALTER TABLE "first_party_delegation_activity" ADD CONSTRAINT "first_party_delegation_activity_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_delegation_activity" ADD CONSTRAINT "first_party_delegation_activity_requester_account_id_users_id_fk" FOREIGN KEY ("requester_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_party_delegation_activity" ADD CONSTRAINT "first_party_delegation_activity_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "first_party_delegation_activity_account_idx" ON "first_party_delegation_activity" USING btree ("account_id","last_at");--> statement-breakpoint
CREATE INDEX "first_party_delegation_activity_requester_idx" ON "first_party_delegation_activity" USING btree ("requester_account_id","last_at");--> statement-breakpoint
CREATE INDEX "first_party_delegation_activity_last_at_idx" ON "first_party_delegation_activity" USING btree ("last_at");--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_session_check" CHECK (
      case when coalesce("capability_execution_authorizations"."authority", 'external') = 'first_party' then
        (("capability_execution_authorizations"."requester_session_id" is not null and length("capability_execution_authorizations"."requester_session_id") > 0
         and "capability_execution_authorizations"."requester_session_binding_digest" is not null and "capability_execution_authorizations"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$')
         or ("capability_execution_authorizations"."requester_session_id" is null and "capability_execution_authorizations"."requester_session_binding_digest" is null and "capability_execution_authorizations"."task_id" is null))
        and "capability_execution_authorizations"."ceiling_id" is null
      else ("capability_execution_authorizations"."actor_type" = 'requester' and "capability_execution_authorizations"."requester_session_id" is not null and length("capability_execution_authorizations"."requester_session_id") > 0
       and "capability_execution_authorizations"."requester_session_binding_digest" is not null
       and "capability_execution_authorizations"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$'
       and "capability_execution_authorizations"."kind" = 'direct_request' and "capability_execution_authorizations"."maximum_autonomy" = 'read_only'
       and "capability_execution_authorizations"."actor_account_id" = "capability_execution_authorizations"."requester_account_id")
      or ("capability_execution_authorizations"."actor_type" <> 'requester' and "capability_execution_authorizations"."requester_session_id" is null and "capability_execution_authorizations"."requester_session_binding_digest" is null) end);