-- oxy:deploy-phase=pre
-- The relay for linking Commons to a passkey account from two devices (ADR 0029
-- D3). A new table the image that serves `/identity/link` reads and writes;
-- created before that image serves.
CREATE TABLE "identity_link_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"user_id" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"public_key" text,
	"proof" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_link_requests_link_id_key" UNIQUE("link_id"),
	CONSTRAINT "identity_link_requests_status_check" CHECK ("identity_link_requests"."status" in ('pending', 'signed', 'completed', 'cancelled')),
	CONSTRAINT "identity_link_requests_signed_check" CHECK (("identity_link_requests"."public_key" is null) = ("identity_link_requests"."proof" is null)),
	CONSTRAINT "identity_link_requests_link_id_check" CHECK ("identity_link_requests"."link_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "identity_link_requests_challenge_hash_check" CHECK ("identity_link_requests"."challenge_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "identity_link_requests" ADD CONSTRAINT "identity_link_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_link_requests_user_id_idx" ON "identity_link_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_link_requests_expires_at_idx" ON "identity_link_requests" USING btree ("expires_at");