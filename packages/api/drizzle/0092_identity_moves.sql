-- oxy:deploy-phase=pre
-- Additive: a brand-new table no running image reads or writes, so it is safe
-- to create while the previous image is still serving. It relays one move of an
-- identity into Commons: two ephemeral public keys and an opaque ciphertext the
-- server cannot decrypt, cleared once the move completes.
CREATE TABLE "identity_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"move_id" text NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"initiator_ephemeral_public_key" text NOT NULL,
	"responder_ephemeral_public_key" text,
	"nonce" text,
	"ciphertext" text,
	"receipt_signature" text,
	"receipt_timestamp" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_moves_move_id_key" UNIQUE("move_id"),
	CONSTRAINT "identity_moves_status_check" CHECK ("identity_moves"."status" in ('pending', 'joined', 'sealed', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "identity_moves_sealed_payload_check" CHECK (("identity_moves"."nonce" is null) = ("identity_moves"."ciphertext" is null)),
	CONSTRAINT "identity_moves_receipt_check" CHECK (("identity_moves"."receipt_signature" is null) = ("identity_moves"."receipt_timestamp" is null))
);
--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_moves_expires_at_idx" ON "identity_moves" USING btree ("expires_at");