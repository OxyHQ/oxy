-- oxy:deploy-phase=pre
ALTER TABLE "capability_execution_authorizations" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_run_scope_check" CHECK (("capability_execution_authorizations"."kind" = 'direct_request' and "capability_execution_authorizations"."run_id" is not null)
        or ("capability_execution_authorizations"."kind" = 'automation'));
