-- oxy:deploy-phase=pre
ALTER TABLE "delegation_grants" ADD COLUMN "catalog_registration_id" text;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_catalog_registration_id_app_capability_catalog_registrations_id_fk" FOREIGN KEY ("catalog_registration_id") REFERENCES "public"."app_capability_catalog_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delegation_grants_catalog_registration_idx" ON "delegation_grants" USING btree ("catalog_registration_id");--> statement-breakpoint
-- Bind every existing grant to the exact active catalog snapshot it was using
-- immediately before this migration. A resource with no active catalog could
-- not have had a valid effective tool set, so fail it closed instead of
-- inventing a version or widening its authority.
UPDATE "delegation_grants" AS "grant"
SET "catalog_registration_id" = "registration"."id", "updated_at" = now()
FROM "app_capability_catalog_registrations" AS "registration"
WHERE "grant"."catalog_registration_id" IS NULL
  AND "registration"."active" = true
  AND "registration"."app_slug" = "grant"."resource_app";--> statement-breakpoint
UPDATE "delegation_grants"
SET "revoked_at" = coalesce("revoked_at", now()), "updated_at" = now()
WHERE "catalog_registration_id" IS NULL;
