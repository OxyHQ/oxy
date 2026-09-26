-- oxy:deploy-phase=pre
-- Per-holder device credentials (ADR 0029 D2: every official web app shares one
-- browser DeviceSession). A new table nothing in the running image reads or
-- writes, so it is safe ahead of the rollout; `post` would leave the new image's
-- sign-ins and mints addressing a table that does not exist yet for the length
-- of a rollout. The old `device_sessions.secret_hash` columns go in the `post`
-- migration after this one. No rows are copied: a secret the old image issued
-- stops minting once the new image serves, and the holder signs in again (no
-- users yet, clean cut).
CREATE TABLE "device_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"device_session_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_credentials_secret_hash_key" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_credentials_device_session_id_idx" ON "device_credentials" USING btree ("device_session_id");