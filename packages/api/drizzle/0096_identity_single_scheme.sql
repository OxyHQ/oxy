-- oxy:deploy-phase=pre
-- #1302 clean cut, additive for the running image: one envelope scheme and one
-- transfer protocol. Production held 0 envelopes and 0 moves (read-only count,
-- 2026-09-17), so every tightened CHECK and NOT NULL holds for every existing
-- row; the previous image already writes only scheme-2 envelopes and v2 moves.
ALTER TABLE "identity_moves" DROP CONSTRAINT "identity_moves_protocol_version_check";--> statement-breakpoint
ALTER TABLE "identity_moves" DROP CONSTRAINT "identity_moves_protocol_shape_check";--> statement-breakpoint
ALTER TABLE "identity_moves" DROP CONSTRAINT "identity_moves_reveal_after_join_check";--> statement-breakpoint
ALTER TABLE "identity_moves" DROP CONSTRAINT "identity_moves_reveal_nonce_check";--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ALTER COLUMN "secret_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_moves" ALTER COLUMN "protocol_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "identity_moves" ALTER COLUMN "initiator_commitment" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD CONSTRAINT "identity_web_envelopes_version_check" CHECK ("identity_web_envelopes"."version" = 2);--> statement-breakpoint
ALTER TABLE "identity_web_envelopes" ADD CONSTRAINT "identity_web_envelopes_secret_kind_check" CHECK ("identity_web_envelopes"."secret_kind" in ('mnemonic-entropy', 'raw-private-key'));--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_reveal_after_join_check" CHECK ("identity_moves"."initiator_ephemeral_public_key" is null or "identity_moves"."responder_ephemeral_public_key" is not null);--> statement-breakpoint
ALTER TABLE "identity_moves" ADD CONSTRAINT "identity_moves_reveal_nonce_check" CHECK (("identity_moves"."initiator_commitment_nonce" is null) = ("identity_moves"."initiator_ephemeral_public_key" is null));