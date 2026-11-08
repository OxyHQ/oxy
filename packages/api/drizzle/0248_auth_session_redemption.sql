-- oxy:deploy-phase=pre
-- ADR 0058 R7: a QR redemption repeats with its key. The claim records the
-- redemption of its proof (the proof's hash, the device, the platform
-- service's key hash, the latest attempt and the platform credential it
-- issued), so the same proof and the same key may be redeemed again within
-- the claim's ten minutes. Additive: nullable columns and one with a constant
-- default (no rewrite), their foreign keys and partial indexes on a small,
-- swept table. The previous image never reads or writes them. The foreign
-- keys are added NOT VALID and validated in 0249, so their scans do not extend
-- this DDL's locks.
ALTER TABLE "auth_sessions" ADD COLUMN "redeemed_proof_hash" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "redeemed_device_session_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "redemption_key_hash" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "redemption_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "redemption_credential_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_redeemed_device_session_id_device_sessions_id_fk" FOREIGN KEY ("redeemed_device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_redemption_credential_id_device_credentials_id_fk" FOREIGN KEY ("redemption_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "auth_sessions_redeemed_proof_hash_idx" ON "auth_sessions" USING btree ("redeemed_proof_hash") WHERE "auth_sessions"."redeemed_proof_hash" is not null;--> statement-breakpoint
CREATE INDEX "auth_sessions_redeemed_device_session_id_idx" ON "auth_sessions" USING btree ("redeemed_device_session_id") WHERE "auth_sessions"."redeemed_device_session_id" is not null;--> statement-breakpoint
CREATE INDEX "auth_sessions_redemption_credential_id_idx" ON "auth_sessions" USING btree ("redemption_credential_id") WHERE "auth_sessions"."redemption_credential_id" is not null;
