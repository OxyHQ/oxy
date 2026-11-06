-- oxy:deploy-phase=pre
-- Validate 0236's NOT VALID constraints separately, so their scan of
-- `device_credentials` (every row NULL) does not extend 0236's DDL locks.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.
ALTER TABLE "device_credentials" VALIDATE CONSTRAINT "device_credentials_platform_application_id_applications_id_fk";--> statement-breakpoint
ALTER TABLE "device_credentials" VALIDATE CONSTRAINT "device_credentials_platform_check";--> statement-breakpoint
ALTER TABLE "device_credentials" VALIDATE CONSTRAINT "device_credentials_platform_application_check";
