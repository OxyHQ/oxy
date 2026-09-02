-- oxy:deploy-phase=pre
-- The previous build shipped no provider-secret backend, so production is
-- expected to contain zero connections. Refuse the cut if reality disagrees:
-- an automated locator-to-handle rewrite cannot move the referenced secret and
-- would strand customer material in an unowned backend.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "inference_provider_connections") THEN
		RAISE EXCEPTION 'Kaana custody cut requires an empty legacy provider-connection inventory; import and revoke legacy credentials explicitly before retrying';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "credential_handle" text;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "credential_revision" integer;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "custody_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Rolling-deploy compatibility: the previous image still selects secret_ref.
-- It is nullable and unused by the new image. Drop it only in a post-deploy
-- migration after this image is fully rolled out and BYOK mutations are enabled.
ALTER TABLE "inference_provider_connections" ALTER COLUMN "secret_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_handle_key" UNIQUE("credential_handle");--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_custody_state_check" CHECK ("inference_provider_connections"."custody_state" in ('pending', 'ready', 'reconcile', 'revoked'));--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_handle_format" CHECK ("inference_provider_connections"."credential_handle" is null or "inference_provider_connections"."credential_handle" ~ '^kcred_[a-z2-7]{26}$');--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_reference_pair" CHECK (("inference_provider_connections"."credential_handle" is null) = ("inference_provider_connections"."credential_revision" is null));--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_revision_positive" CHECK ("inference_provider_connections"."credential_revision" is null or "inference_provider_connections"."credential_revision" > 0);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_custody_reference_required" CHECK ("inference_provider_connections"."custody_state" not in ('ready', 'revoked') or "inference_provider_connections"."credential_handle" is not null);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_pending_has_no_reference" CHECK ("inference_provider_connections"."custody_state" <> 'pending' or "inference_provider_connections"."credential_handle" is null);
