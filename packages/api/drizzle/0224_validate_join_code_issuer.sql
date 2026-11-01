-- oxy:deploy-phase=pre
-- Validate separately so the FK scan does not extend the preceding DDL locks.
ALTER TABLE "device_join_codes" VALIDATE CONSTRAINT "device_join_codes_issuer_credential_id_device_credentials_id_fk";
