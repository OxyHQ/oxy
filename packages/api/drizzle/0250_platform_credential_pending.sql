-- oxy:deploy-phase=pre
-- ADR 0058 R8: a platform credential issued to a client that confirms is
-- pending until it confirms. Additive: both columns are NULL for every existing
-- row, and the image still serving reads neither. On `device_credentials`
-- (hot) only brief DDL here: the self foreign key and the CHECK are added NOT
-- VALID, the indexes are 0251 and the validation 0252.
ALTER TABLE "device_credentials" ADD COLUMN "pending_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "replaces_credential_id" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_replaces_credential_id_device_credentials_id_fk" FOREIGN KEY ("replaces_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_pending_check" CHECK (("device_credentials"."pending_until" is null or "device_credentials"."platform" is not null) and ("device_credentials"."replaces_credential_id" is null or "device_credentials"."pending_until" is not null)) NOT VALID;
