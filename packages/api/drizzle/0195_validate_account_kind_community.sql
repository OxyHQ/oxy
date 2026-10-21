-- oxy:deploy-phase=pre
-- Validates 0194's widened CHECKs under SHARE UPDATE EXCLUSIVE: readers and
-- writers keep going while existing rows are checked.
ALTER TABLE "users" VALIDATE CONSTRAINT "users_kind_check";--> statement-breakpoint
ALTER TABLE "users" VALIDATE CONSTRAINT "users_account_categories_kind_check";
