-- oxy:deploy-phase=pre
-- Additive (ADR 0024 D5, #1302): a brand-new table no running image reads or
-- writes. It holds one short-lived signed-out recovery attempt: hashes of a
-- challenge and a ticket, and — only after the root proved itself — the account.
CREATE TABLE "identity_recovery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_hash" text NOT NULL,
	"ticket_hash" text,
	"user_id" text,
	"root_public_key" text,
	"registration_challenge" text,
	"status" text DEFAULT 'challenged' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_recovery_attempts_challenge_hash_key" UNIQUE("challenge_hash"),
	CONSTRAINT "identity_recovery_attempts_ticket_hash_key" UNIQUE("ticket_hash"),
	CONSTRAINT "identity_recovery_attempts_status_check" CHECK ("identity_recovery_attempts"."status" in ('challenged', 'started', 'completed')),
	CONSTRAINT "identity_recovery_attempts_started_check" CHECK (("identity_recovery_attempts"."status" = 'challenged') = ("identity_recovery_attempts"."ticket_hash" is null and "identity_recovery_attempts"."user_id" is null and "identity_recovery_attempts"."root_public_key" is null and "identity_recovery_attempts"."registration_challenge" is null))
);
--> statement-breakpoint
ALTER TABLE "identity_recovery_attempts" ADD CONSTRAINT "identity_recovery_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_recovery_attempts_expires_at_idx" ON "identity_recovery_attempts" USING btree ("expires_at");