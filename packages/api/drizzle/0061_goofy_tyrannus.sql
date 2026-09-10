-- oxy:deploy-phase=post
-- A legacy limit had no tool binding and cannot be translated without guessing.
-- Revoke only the affected grants, then delete those ambiguous rows. Limits
-- created by the new binary already carry a tool and remain active.
UPDATE "delegation_grants" SET "revoked_at" = coalesce("revoked_at", now()) WHERE "id" IN (SELECT "grant_id" FROM "delegation_limits" WHERE "tool" IS NULL);--> statement-breakpoint
DELETE FROM "delegation_limits" WHERE "tool" IS NULL;--> statement-breakpoint
ALTER TABLE "delegation_limits" DROP CONSTRAINT "delegation_limits_grant_key_key";--> statement-breakpoint
ALTER TABLE "delegation_limits" ALTER COLUMN "tool" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "delegation_limits" ADD CONSTRAINT "delegation_limits_grant_tool_key_key" UNIQUE("grant_id","tool","key");
