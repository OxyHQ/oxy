-- oxy:deploy-phase=pre
-- Validate 0250's NOT VALID constraints separately, so their scan of
-- `device_credentials` (every row NULL) does not extend 0250's DDL locks.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.
ALTER TABLE "device_credentials" VALIDATE CONSTRAINT "device_credentials_replaces_credential_id_device_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "device_credentials" VALIDATE CONSTRAINT "device_credentials_pending_check";
