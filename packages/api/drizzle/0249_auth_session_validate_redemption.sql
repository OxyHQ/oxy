-- oxy:deploy-phase=pre
-- Validate 0248's NOT VALID foreign keys separately, so their scans of
-- auth_sessions (a small, swept table) do not extend 0248's DDL locks.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.
ALTER TABLE "auth_sessions" VALIDATE CONSTRAINT "auth_sessions_redeemed_device_session_id_device_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "auth_sessions" VALIDATE CONSTRAINT "auth_sessions_redemption_credential_id_device_credentials_id_fk";
