-- oxy:deploy-phase=pre
-- ADR 0067: an account created below the minimum unsupervised age is born under
-- supervision with no guardian yet. The marker tells that first guardian from a
-- replacement one; additive and NULL for every existing profile.
ALTER TABLE "supervision_profiles" ADD COLUMN "awaiting_guardian_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supervision_profiles" ADD CONSTRAINT "supervision_profiles_awaiting_guardian_check" CHECK ("supervision_profiles"."awaiting_guardian_since" is null or ("supervision_profiles"."guardian_account_id" is null and "supervision_profiles"."status" = 'active'));