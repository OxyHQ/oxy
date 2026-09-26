-- oxy:deploy-phase=pre
-- The browser bridge's one-use join codes (ADR 0029 D2): auth.oxy.so/bridge
-- proves the browser's device and hands an official app a code, bound to the
-- app, its exact redirect URI and its PKCE challenge, that the app redeems for
-- its own holder credential on that device. A new table nothing in the running
-- image reads or writes, so it is safe ahead of the rollout; `post` would leave
-- the new image's bridge routes addressing a table that does not exist yet.
CREATE TABLE "device_join_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"device_session_id" text NOT NULL,
	"application_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "device_join_codes_code_hash_key" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "device_join_codes" ADD CONSTRAINT "device_join_codes_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_join_codes" ADD CONSTRAINT "device_join_codes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_join_codes_device_session_id_idx" ON "device_join_codes" USING btree ("device_session_id");--> statement-breakpoint
CREATE INDEX "device_join_codes_application_id_idx" ON "device_join_codes" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "device_join_codes_expires_at_idx" ON "device_join_codes" USING btree ("expires_at");