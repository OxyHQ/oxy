-- oxy:deploy-phase=pre
-- ADR 0058 2.1, amended 2026-11-08: a platform's credential from the QR
-- approval. A device-sign-in request records the holder credential its claim
-- issued (the proof `POST /session/device/platform` redeems once, within
-- minutes). Additive: one nullable column, its foreign key and index. The
-- previous image never reads or writes it. The foreign key is added NOT VALID
-- and validated in 0247, so its scan does not extend this DDL's locks.
ALTER TABLE "auth_sessions" ADD COLUMN "claimed_credential_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_claimed_credential_id_device_credentials_id_fk" FOREIGN KEY ("claimed_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "auth_sessions_claimed_credential_id_idx" ON "auth_sessions" USING btree ("claimed_credential_id");
