-- oxy:deploy-phase=pre
-- Additive (ADR 0024, #1302): a new table no running image reads, three new
-- columns with defaults or NULLs, and a CHECK every existing row satisfies
-- (`revision` defaults to 1). The previous image neither selects nor writes the
-- new columns, so it keeps serving while this applies.
CREATE TABLE "identity_proof_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"root_public_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_proof_challenges_challenge_hash_key" UNIQUE("challenge_hash"),
	CONSTRAINT "identity_proof_challenges_challenge_hash_check" CHECK ("identity_proof_challenges"."challenge_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD COLUMN "secret_kind" text;--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD COLUMN "recovery_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_proof_challenges" ADD CONSTRAINT "identity_proof_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_proof_challenges_expires_at_idx" ON "identity_proof_challenges" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD CONSTRAINT "identity_web_envelopes_revision_check" CHECK ("identity_web_envelopes"."revision" >= 1);