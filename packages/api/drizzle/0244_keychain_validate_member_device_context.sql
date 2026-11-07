-- oxy:deploy-phase=pre
-- Validate 0243's NOT VALID foreign keys separately, so their scan of the
-- keychain tables does not extend 0243's DDL locks. VALIDATE takes SHARE
-- UPDATE EXCLUSIVE: reads and writes continue.
ALTER TABLE "keychain_members" VALIDATE CONSTRAINT "keychain_members_device_context_id_device_account_contexts_id_fk";--> statement-breakpoint
ALTER TABLE "keychain_enrollments" VALIDATE CONSTRAINT "keychain_enrollments_device_context_id_device_account_contexts_id_fk";
