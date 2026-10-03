-- oxy:deploy-phase=pre
-- Adds requester session references and widens the actor discriminator; existing rows remain valid.
ALTER TABLE "capability_execution_authorizations" DROP CONSTRAINT "capability_execution_authorizations_actor_check";--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_session_id" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_session_binding_digest" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_session_check" CHECK (
      ("capability_execution_authorizations"."actor_type" = 'requester' and "capability_execution_authorizations"."requester_session_id" is not null and length("capability_execution_authorizations"."requester_session_id") > 0
       and "capability_execution_authorizations"."requester_session_binding_digest" is not null
       and "capability_execution_authorizations"."requester_session_binding_digest" ~ '^[a-f0-9]{64}$'
       and "capability_execution_authorizations"."kind" = 'direct_request' and "capability_execution_authorizations"."maximum_autonomy" = 'read_only'
       and "capability_execution_authorizations"."actor_account_id" = "capability_execution_authorizations"."requester_account_id")
      or ("capability_execution_authorizations"."actor_type" <> 'requester' and "capability_execution_authorizations"."requester_session_id" is null and "capability_execution_authorizations"."requester_session_binding_digest" is null));--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_actor_check" CHECK (("capability_execution_authorizations"."actor_type" = 'alia' and "capability_execution_authorizations"."actor_account_id" is null) or ("capability_execution_authorizations"."actor_type" in ('agent', 'requester') and "capability_execution_authorizations"."actor_account_id" is not null));