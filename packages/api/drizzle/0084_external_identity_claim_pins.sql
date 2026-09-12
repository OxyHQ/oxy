-- oxy:deploy-phase=pre
ALTER TABLE "external_identity_claims" ADD COLUMN "source_stable_id" text;--> statement-breakpoint
ALTER TABLE "external_identity_claims" ADD COLUMN "target_stable_id" text;