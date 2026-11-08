-- oxy:deploy-phase=pre
-- Validate 0246's NOT VALID foreign key separately, so its scan of
-- auth_sessions (a small, swept table) does not extend 0246's DDL locks.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.
ALTER TABLE "auth_sessions" VALIDATE CONSTRAINT "auth_sessions_claimed_credential_id_device_credentials_id_fk";
