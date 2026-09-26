-- oxy:deploy-phase=post
-- The web identity carrier is deleted (ADR 0029 D3): a web account is a
-- username, a passkey and a recovery email, and nothing reads the sealed web
-- envelopes, the move-to-Commons relay or the phrase-recovery attempts any more.
-- Post-deploy: the image that no longer references these tables is serving.
DROP TABLE "identity_web_envelopes" CASCADE;--> statement-breakpoint
DROP TABLE "identity_moves" CASCADE;--> statement-breakpoint
DROP TABLE "identity_recovery_attempts" CASCADE;