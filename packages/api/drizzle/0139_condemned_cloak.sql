-- oxy:deploy-phase=pre
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_auth_method_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "approved_by_session_id" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "auth_method_id" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_method_fk" FOREIGN KEY ("requester_auth_method_id","requester_account_id") REFERENCES "public"."user_auth_methods"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_approved_by_session_id_sessions_session_id_fk" FOREIGN KEY ("approved_by_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_principal_method_fk" FOREIGN KEY ("auth_method_id","principal_user_id") REFERENCES "public"."user_auth_methods"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_execution_requester_method_idx" ON "capability_execution_authorizations" USING btree ("requester_auth_method_id") WHERE "capability_execution_authorizations"."requester_auth_method_id" is not null;--> statement-breakpoint
CREATE INDEX "auth_sessions_approved_by_session_idx" ON "auth_sessions" USING btree ("approved_by_session_id") WHERE "auth_sessions"."approved_by_session_id" is not null;--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_auth_method_idx" ON "mcp_oauth_grants" USING btree ("auth_method_id") WHERE "mcp_oauth_grants"."auth_method_id" is not null;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_approved_by_purpose_check" CHECK ("auth_sessions"."approved_by_session_id" is null or "auth_sessions"."purpose" = 'oauth_authorization');