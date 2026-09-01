-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

ALTER TABLE "users" DROP CONSTRAINT "users_kind_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('personal', 'organization', 'project', 'bot', 'channel'));