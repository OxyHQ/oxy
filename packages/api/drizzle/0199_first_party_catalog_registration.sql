-- oxy:deploy-phase=pre
--
-- A capability catalogue Oxy itself ships (the `oxy` profile tools) is registered
-- by Oxy's own deploy, not by an application credential (ADR 0048). So a
-- registration names its authority explicitly: `credential` (as every existing
-- row) or `first_party`, which carries no credential. Additive and relaxing: the
-- image still serving writes only `credential` rows and keeps working.
ALTER TABLE "app_capability_catalog_registrations" ALTER COLUMN "registered_by_credential_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_capability_catalog_registrations" ADD COLUMN "source" text DEFAULT 'credential' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_capability_catalog_registrations" ADD CONSTRAINT "app_capability_catalog_source_check" CHECK ("app_capability_catalog_registrations"."source" in ('credential', 'first_party'));--> statement-breakpoint
ALTER TABLE "app_capability_catalog_registrations" ADD CONSTRAINT "app_capability_catalog_credential_source_check" CHECK (("app_capability_catalog_registrations"."source" = 'credential') = ("app_capability_catalog_registrations"."registered_by_credential_id" is not null));