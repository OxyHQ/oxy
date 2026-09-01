-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

ALTER TABLE "users" ADD COLUMN "name_display" text;