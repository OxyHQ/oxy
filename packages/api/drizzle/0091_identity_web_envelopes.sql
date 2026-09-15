-- oxy:deploy-phase=pre
-- Additive: a brand-new table no running image reads or writes, so it is safe
-- to create while the previous image is still serving. It holds the sealed web
-- copy of an identity (one identity, two carriers); nothing here is decryptable
-- by the server.
CREATE TABLE "identity_web_envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"entropy_nonce" text NOT NULL,
	"sealed_entropy" text NOT NULL,
	"wraps" jsonb NOT NULL,
	"phrase_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_web_envelopes_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD CONSTRAINT "identity_web_envelopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_web_envelopes_public_key_idx" ON "identity_web_envelopes" USING btree ("public_key");