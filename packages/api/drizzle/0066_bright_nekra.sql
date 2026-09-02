-- oxy:deploy-phase=post
-- Rows created before durable automation authority moved run identity to ticket
-- issuance may still carry the old scope. Clear it before narrowing the CHECK.
UPDATE "capability_execution_authorizations"
SET "run_id" = NULL, "step_id" = NULL
WHERE "kind" = 'automation';--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" DROP CONSTRAINT "capability_execution_authorizations_run_scope_check";--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_run_scope_check" CHECK (("capability_execution_authorizations"."kind" = 'direct_request' and "capability_execution_authorizations"."run_id" is not null)
        or ("capability_execution_authorizations"."kind" = 'automation' and "capability_execution_authorizations"."run_id" is null and "capability_execution_authorizations"."step_id" is null));
