ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_catalog_registration_id" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_catalog_version" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD COLUMN "requester_catalog_digest" text;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_requester_catalog_registration_id_app_capability_catalog_registrations_id_fk" FOREIGN KEY ("requester_catalog_registration_id") REFERENCES "public"."app_capability_catalog_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_requester_catalog_check" CHECK (
      ("capability_execution_authorizations"."actor_type" = 'requester' and (
        ("capability_execution_authorizations"."requester_catalog_registration_id" is not null and length("capability_execution_authorizations"."requester_catalog_registration_id") > 0
         and "capability_execution_authorizations"."requester_catalog_version" is not null and length("capability_execution_authorizations"."requester_catalog_version") > 0
         and "capability_execution_authorizations"."requester_catalog_digest" is not null and "capability_execution_authorizations"."requester_catalog_digest" ~ '^[a-f0-9]{64}$')
        or ("capability_execution_authorizations"."revoked_at" is not null and "capability_execution_authorizations"."requester_catalog_registration_id" is null
         and "capability_execution_authorizations"."requester_catalog_version" is null and "capability_execution_authorizations"."requester_catalog_digest" is null)))
      or ("capability_execution_authorizations"."actor_type" <> 'requester' and "capability_execution_authorizations"."requester_catalog_registration_id" is null
       and "capability_execution_authorizations"."requester_catalog_version" is null and "capability_execution_authorizations"."requester_catalog_digest" is null));