-- oxy:deploy-phase=pre
-- Additive for the running image (#1302, transfer protocol v2): a defaulted
-- column (every existing row is version 1), two nullable columns, NOT NULL
-- relaxed on a column every existing and every version-1 row still fills, and
-- CHECKs every existing row satisfies. The previous image never creates
-- version-2 rows.
ALTER TABLE "identity_moves" ALTER COLUMN "initiator_ephemeral_public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_moves" ADD COLUMN "protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_moves" ADD COLUMN "initiator_commitment" text;--> statement-breakpoint
ALTER TABLE "identity_moves" ADD COLUMN "initiator_commitment_nonce" text;--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_protocol_version_check" CHECK ("identity_moves"."protocol_version" in (1, 2));--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_protocol_shape_check" CHECK (("identity_moves"."protocol_version" = 1 and "identity_moves"."initiator_commitment" is null and "identity_moves"."initiator_ephemeral_public_key" is not null) or ("identity_moves"."protocol_version" = 2 and "identity_moves"."initiator_commitment" is not null));--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_reveal_after_join_check" CHECK ("identity_moves"."protocol_version" = 1 or "identity_moves"."initiator_ephemeral_public_key" is null or "identity_moves"."responder_ephemeral_public_key" is not null);--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_reveal_nonce_check" CHECK (("identity_moves"."initiator_commitment_nonce" is null) = ("identity_moves"."protocol_version" = 1 or "identity_moves"."initiator_ephemeral_public_key" is null));