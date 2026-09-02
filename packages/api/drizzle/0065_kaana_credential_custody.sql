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
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_pending_has_no_reference" CHECK ("inference_provider_connections"."custody_state" <> 'pending' or "inference_provider_connections"."credential_handle" is null);--> statement-breakpoint
-- Oxy commits this metadata-only ledger before the first signed Kaana network
-- request. It is additive and therefore belongs in the same pre-deploy expand
-- migration as the custody columns, before the post-deploy legacy-column drop.
CREATE TABLE "inference_provider_credential_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"action" text NOT NULL,
	"provider" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"operation_actor" text NOT NULL,
	"credential_handle" text,
	"expected_revision" integer,
	"secret_sha256" text,
	"key_prefix" text,
	"previous_connection_status" text,
	"state" text NOT NULL,
	"outcome_credential_handle" text,
	"outcome_revision" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_provider_credential_operations_action_check" CHECK ("inference_provider_credential_operations"."action" in ('create', 'rotate', 'revoke')),
	CONSTRAINT "inference_provider_credential_operations_state_check" CHECK ("inference_provider_credential_operations"."state" in ('pending', 'reconciliation', 'manual', 'applied')),
	CONSTRAINT "inference_provider_credential_operations_id_format" CHECK ("inference_provider_credential_operations"."id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "inference_provider_credential_operations_actor_format" CHECK (length("inference_provider_credential_operations"."operation_actor") between 1 and 256 and "inference_provider_credential_operations"."operation_actor" = btrim("inference_provider_credential_operations"."operation_actor") and "inference_provider_credential_operations"."operation_actor" !~ E'[\r\n]'),
	CONSTRAINT "inference_provider_credential_operations_reference_format" CHECK ("inference_provider_credential_operations"."credential_handle" is null or "inference_provider_credential_operations"."credential_handle" ~ '^kcred_[a-z2-7]{26}$'),
	CONSTRAINT "inference_provider_credential_operations_reference_pair" CHECK (("inference_provider_credential_operations"."credential_handle" is null) = ("inference_provider_credential_operations"."expected_revision" is null)),
	CONSTRAINT "inference_provider_credential_operations_reference_action" CHECK (("inference_provider_credential_operations"."action" = 'create') = ("inference_provider_credential_operations"."credential_handle" is null)),
	CONSTRAINT "inference_provider_credential_operations_expected_revision_positive" CHECK ("inference_provider_credential_operations"."expected_revision" is null or "inference_provider_credential_operations"."expected_revision" > 0),
	CONSTRAINT "inference_provider_credential_operations_secret_fingerprint_action" CHECK (("inference_provider_credential_operations"."action" in ('create', 'rotate')) = ("inference_provider_credential_operations"."secret_sha256" is not null)),
	CONSTRAINT "inference_provider_credential_operations_secret_fingerprint_format" CHECK ("inference_provider_credential_operations"."secret_sha256" is null or "inference_provider_credential_operations"."secret_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "inference_provider_credential_operations_key_prefix_action" CHECK (("inference_provider_credential_operations"."action" in ('create', 'rotate')) = ("inference_provider_credential_operations"."key_prefix" is not null)),
	CONSTRAINT "inference_provider_credential_operations_key_prefix_length" CHECK ("inference_provider_credential_operations"."key_prefix" is null or length("inference_provider_credential_operations"."key_prefix") between 1 and 12),
	CONSTRAINT "inference_provider_credential_operations_previous_status_action" CHECK (("inference_provider_credential_operations"."action" = 'revoke') = ("inference_provider_credential_operations"."previous_connection_status" is not null)),
	CONSTRAINT "inference_provider_credential_operations_previous_status_check" CHECK ("inference_provider_credential_operations"."previous_connection_status" is null or "inference_provider_credential_operations"."previous_connection_status" in ('pending_validation', 'active', 'disabled', 'revoked')),
	CONSTRAINT "inference_provider_credential_operations_outcome_pair" CHECK (("inference_provider_credential_operations"."outcome_credential_handle" is null) = ("inference_provider_credential_operations"."outcome_revision" is null)),
	CONSTRAINT "inference_provider_credential_operations_outcome_format" CHECK ("inference_provider_credential_operations"."outcome_credential_handle" is null or "inference_provider_credential_operations"."outcome_credential_handle" ~ '^kcred_[a-z2-7]{26}$'),
	CONSTRAINT "inference_provider_credential_operations_applied_outcome" CHECK (("inference_provider_credential_operations"."state" = 'applied') = ("inference_provider_credential_operations"."outcome_credential_handle" is not null)),
	CONSTRAINT "inference_provider_credential_operations_outcome_identity" CHECK ("inference_provider_credential_operations"."outcome_credential_handle" is null or "inference_provider_credential_operations"."action" = 'create' or "inference_provider_credential_operations"."outcome_credential_handle" = "inference_provider_credential_operations"."credential_handle"),
	CONSTRAINT "inference_provider_credential_operations_outcome_revision" CHECK ("inference_provider_credential_operations"."outcome_revision" is null or ("inference_provider_credential_operations"."action" = 'create' and "inference_provider_credential_operations"."outcome_revision" = 1) or ("inference_provider_credential_operations"."action" <> 'create' and "inference_provider_credential_operations"."outcome_revision" = "inference_provider_credential_operations"."expected_revision" + 1))
);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_operation_identity_key" UNIQUE("id","provider","owner_account_id","environment");--> statement-breakpoint
ALTER TABLE "inference_provider_credential_operations" ADD CONSTRAINT "inference_provider_credential_operations_identity_fk" FOREIGN KEY ("connection_id","provider","owner_account_id","environment") REFERENCES "public"."inference_provider_connections"("id","provider","owner_account_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_provider_credential_operations_unresolved_key" ON "inference_provider_credential_operations" USING btree ("connection_id") WHERE "inference_provider_credential_operations"."state" in ('pending', 'reconciliation', 'manual');--> statement-breakpoint
CREATE INDEX "inference_provider_credential_operations_connection_id_created_at_idx" ON "inference_provider_credential_operations" USING btree ("connection_id","created_at" DESC NULLS LAST);
