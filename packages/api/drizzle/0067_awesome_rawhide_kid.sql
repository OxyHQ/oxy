-- oxy:deploy-phase=pre
-- Add final Kaana custody metadata while legacy Oxy secret-derived columns remain nullable for rolling compatibility.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "inference_provider_connections") THEN
		RAISE EXCEPTION 'Kaana custody cut requires an empty legacy provider-connection inventory';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "account_closure_fences" (
	"account_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_provider_credential_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"action" text NOT NULL,
	"provider" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"operation_actor" text NOT NULL,
	"credential_handle" text,
	"expected_revision" bigint,
	"previous_connection_status" text,
	"state" text NOT NULL,
	"outcome_credential_handle" text,
	"outcome_revision" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_provider_credential_operations_action_check" CHECK ("inference_provider_credential_operations"."action" in ('create', 'rotate', 'revoke')),
	CONSTRAINT "inference_provider_credential_operations_state_check" CHECK ("inference_provider_credential_operations"."state" in ('pending', 'reconciliation', 'manual', 'applied')),
	CONSTRAINT "inference_provider_credential_operations_id_format" CHECK ("inference_provider_credential_operations"."id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "inference_provider_credential_operations_actor_format" CHECK (length("inference_provider_credential_operations"."operation_actor") between 1 and 256 and "inference_provider_credential_operations"."operation_actor" = btrim("inference_provider_credential_operations"."operation_actor") and "inference_provider_credential_operations"."operation_actor" !~ E'[\r\n]'),
	CONSTRAINT "inference_provider_credential_operations_reference_format" CHECK ("inference_provider_credential_operations"."credential_handle" is null or "inference_provider_credential_operations"."credential_handle" ~ '^kcred_[a-z2-7]{26}$'),
	CONSTRAINT "inference_provider_credential_operations_reference_pair" CHECK (("inference_provider_credential_operations"."credential_handle" is null) = ("inference_provider_credential_operations"."expected_revision" is null)),
	CONSTRAINT "inference_provider_credential_operations_reference_action" CHECK (("inference_provider_credential_operations"."action" = 'create') = ("inference_provider_credential_operations"."credential_handle" is null)),
	CONSTRAINT "inference_provider_credential_operations_expected_revision_positive" CHECK ("inference_provider_credential_operations"."expected_revision" is null or "inference_provider_credential_operations"."expected_revision" between 1 and 9007199254740990),
	CONSTRAINT "inference_provider_credential_operations_previous_status_action" CHECK (("inference_provider_credential_operations"."action" = 'revoke') = ("inference_provider_credential_operations"."previous_connection_status" is not null)),
	CONSTRAINT "inference_provider_credential_operations_previous_status_check" CHECK ("inference_provider_credential_operations"."previous_connection_status" is null or "inference_provider_credential_operations"."previous_connection_status" in ('pending_validation', 'active', 'disabled', 'revoked')),
	CONSTRAINT "inference_provider_credential_operations_outcome_pair" CHECK (("inference_provider_credential_operations"."outcome_credential_handle" is null) = ("inference_provider_credential_operations"."outcome_revision" is null)),
	CONSTRAINT "inference_provider_credential_operations_outcome_format" CHECK ("inference_provider_credential_operations"."outcome_credential_handle" is null or "inference_provider_credential_operations"."outcome_credential_handle" ~ '^kcred_[a-z2-7]{26}$'),
	CONSTRAINT "inference_provider_credential_operations_applied_outcome" CHECK (("inference_provider_credential_operations"."state" = 'applied') = ("inference_provider_credential_operations"."outcome_credential_handle" is not null)),
	CONSTRAINT "inference_provider_credential_operations_outcome_identity" CHECK ("inference_provider_credential_operations"."outcome_credential_handle" is null or "inference_provider_credential_operations"."action" = 'create' or "inference_provider_credential_operations"."outcome_credential_handle" = "inference_provider_credential_operations"."credential_handle"),
	CONSTRAINT "inference_provider_credential_operations_outcome_revision" CHECK ("inference_provider_credential_operations"."outcome_revision" is null or ("inference_provider_credential_operations"."outcome_revision" between 1 and 9007199254740991 and (("inference_provider_credential_operations"."action" = 'create' and "inference_provider_credential_operations"."outcome_revision" = 1) or ("inference_provider_credential_operations"."action" <> 'create' and "inference_provider_credential_operations"."outcome_revision" = "inference_provider_credential_operations"."expected_revision" + 1))))
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "inference_provider_connection_audit_events" DROP CONSTRAINT "inference_provider_connection_audit_events_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_active_requires_valid";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_active_requires_valid" CHECK ("inference_provider_connections"."status" <> 'active' or "inference_provider_connections"."validation_state" = 'valid');--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ALTER COLUMN "secret_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ALTER COLUMN "key_prefix" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ALTER COLUMN "fingerprint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "credential_handle" text;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "credential_revision" bigint;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD COLUMN "custody_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_closure_fences" ADD CONSTRAINT "account_closure_fences_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_operation_identity_key" UNIQUE("id","provider","owner_account_id","environment");--> statement-breakpoint
ALTER TABLE "inference_provider_credential_operations" ADD CONSTRAINT "inference_provider_credential_operations_identity_fk" FOREIGN KEY ("connection_id","provider","owner_account_id","environment") REFERENCES "public"."inference_provider_connections"("id","provider","owner_account_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_provider_credential_operations_unresolved_key" ON "inference_provider_credential_operations" USING btree ("connection_id") WHERE "inference_provider_credential_operations"."state" in ('pending', 'reconciliation', 'manual');--> statement-breakpoint
CREATE INDEX "inference_provider_credential_operations_connection_id_created_at_idx" ON "inference_provider_credential_operations" USING btree ("connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_handle_key" UNIQUE("credential_handle");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_custody_state_check" CHECK ("inference_provider_connections"."custody_state" in ('pending', 'ready', 'reconcile', 'revoked'));--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_handle_format" CHECK ("inference_provider_connections"."credential_handle" is null or "inference_provider_connections"."credential_handle" ~ '^kcred_[a-z2-7]{26}$');--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_reference_pair" CHECK (("inference_provider_connections"."credential_handle" is null) = ("inference_provider_connections"."credential_revision" is null));--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_credential_revision_positive" CHECK ("inference_provider_connections"."credential_revision" is null or "inference_provider_connections"."credential_revision" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_custody_reference_required" CHECK ("inference_provider_connections"."custody_state" not in ('ready', 'revoked') or "inference_provider_connections"."credential_handle" is not null);--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_pending_has_no_reference" CHECK ("inference_provider_connections"."custody_state" <> 'pending' or "inference_provider_connections"."credential_handle" is null);
