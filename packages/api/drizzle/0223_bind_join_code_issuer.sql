-- oxy:deploy-phase=pre
-- Existing and old-server rows remain NULL: they cannot be attributed safely.
ALTER TABLE "device_join_codes" ADD COLUMN "issuer_credential_id" text;--> statement-breakpoint
ALTER TABLE "device_join_codes" ADD CONSTRAINT "device_join_codes_issuer_credential_id_device_credentials_id_fk" FOREIGN KEY ("issuer_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "device_join_codes_issuer_credential_id_idx" ON "device_join_codes" USING btree ("issuer_credential_id");
