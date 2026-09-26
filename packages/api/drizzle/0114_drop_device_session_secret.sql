-- oxy:deploy-phase=post
-- The device's single rotating secret is replaced by per-holder rows in
-- `device_credentials` (0113, ADR 0029 D2). Post-deploy: the image still serving
-- during the rollout selects these columns by name on every device read, so
-- dropping them first would 500 every sign-in and mint it performs.
ALTER TABLE "device_sessions" DROP CONSTRAINT "device_sessions_secret_hash_key";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "secret_hash";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "prev_secret_hash";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "prev_secret_expires_at";