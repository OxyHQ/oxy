-- oxy:deploy-phase=post
-- The browser DeviceSession hub is deleted (ADR 0003 superseded): no route
-- reads or writes the hub handle. Post-deploy: the image that no longer
-- references these columns is already serving.
ALTER TABLE "device_sessions" DROP CONSTRAINT "device_sessions_hub_secret_hash_key";--> statement-breakpoint
DROP INDEX "device_sessions_hub_prev_secret_hash_idx";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "hub_secret_hash";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "hub_prev_secret_hash";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "hub_prev_secret_expires_at";--> statement-breakpoint
ALTER TABLE "device_sessions" DROP COLUMN "hub_secret_expires_at";