-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

ALTER TABLE "user_locations" ADD COLUMN "geo" "geography" GENERATED ALWAYS AS (ST_MakePoint(longitude, latitude)::geography) STORED;--> statement-breakpoint
CREATE INDEX "user_locations_geo_idx" ON "user_locations" USING gist ("geo");