-- oxy:deploy-phase=pre
--
-- BYOK provider connections (issue #972 workstream 10). Additive, and safe while
-- the previous image serves: two new tables it does not know about, and two new
-- `inference_providers` columns that both DEFAULT — so no write the running
-- image performs is refused by anything here, which is the `pre` test.
--
-- ORDERING IS HAND-FIXED, and must stay that way.
--
-- drizzle-kit emits every FOREIGN KEY before every trailing `ADD CONSTRAINT
-- ... UNIQUE`, so its own output added
-- `inference_provider_connections_provider_terms_fk` while its composite target
-- `inference_providers (slug, byok_terms_acknowledgement_required)` was still
-- un-unique — `42830`, at apply time, on the pre-deploy one-shot. The two
-- `inference_providers` constraints are therefore moved up to sit directly
-- under the columns they constrain. Nothing else is changed and the snapshot is
-- untouched: statement ORDER is not part of what `check-drizzle-snapshot-sync`
-- compares, so a regeneration still reports nothing to say.
--
-- WHY THE COMPOSITE FOREIGN KEY EXISTS AT ALL. Where a provider's own terms
-- require a per-customer acknowledgement, a connection without one must be
-- unwritable rather than merely refused by a service. Turning that flag ON while
-- un-acknowledged connections exist is refused by this key, deliberately:
-- flipping it silently would make every existing connection retroactively
-- non-compliant with no signal at all.
--
-- NOTHING HERE STORES A SECRET. `secret_ref` is a `<store>:<locator>` pointer,
-- held to that grammar by one CHECK and pinned to its own account's and
-- environment's partition by another. Note the grammar CHECK spells its tail as
-- `+` plus a `length(...) <= 512` clause rather than the contract's `{1,480}`:
-- Postgres rejects any regex repetition bound above 255 outright, at CREATE
-- TABLE time. The accepted set is identical. See
-- `src/db/schema/inferenceProviderConnections.ts`.

CREATE TABLE "inference_provider_connection_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_provider_connection_audit_events_event_type_check" CHECK ("inference_provider_connection_audit_events"."event_type" in ('created', 'validated', 'rotated', 'used', 'disabled', 'enabled', 'revoked')),
	CONSTRAINT "inference_provider_connection_audit_events_no_actor_on_use" CHECK ("inference_provider_connection_audit_events"."event_type" <> 'used' or "inference_provider_connection_audit_events"."actor_user_id" is null)
);
--> statement-breakpoint
CREATE TABLE "inference_provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"application_id" text,
	"environment" text NOT NULL,
	"status" text NOT NULL,
	"secret_ref" text NOT NULL,
	"key_prefix" text NOT NULL,
	"fingerprint" text NOT NULL,
	"validation_state" text NOT NULL,
	"validation_failure_code" text,
	"last_validated_at" timestamp with time zone,
	"terms_acknowledged_at" timestamp with time zone,
	"provider_terms_acknowledgement_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "inference_provider_connections_secret_ref_key" UNIQUE("secret_ref"),
	CONSTRAINT "inference_provider_connections_scope_kind_check" CHECK ("inference_provider_connections"."scope_kind" in ('account', 'project', 'application')),
	CONSTRAINT "inference_provider_connections_status_check" CHECK ("inference_provider_connections"."status" in ('pending_validation', 'active', 'disabled', 'revoked')),
	CONSTRAINT "inference_provider_connections_environment_check" CHECK ("inference_provider_connections"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_provider_connections_validation_state_check" CHECK ("inference_provider_connections"."validation_state" in ('unvalidated', 'valid', 'invalid', 'expired')),
	CONSTRAINT "inference_provider_connections_validation_failure_code_check" CHECK ("inference_provider_connections"."validation_failure_code" is null or "inference_provider_connections"."validation_failure_code" in ('unauthorized', 'forbidden', 'not_found', 'rate_limited', 'network', 'unknown')),
	CONSTRAINT "inference_provider_connections_application_scope_check" CHECK (("inference_provider_connections"."scope_kind" = 'application') = ("inference_provider_connections"."application_id" is not null)),
	CONSTRAINT "inference_provider_connections_failure_code_required" CHECK ("inference_provider_connections"."validation_state" <> 'invalid' or "inference_provider_connections"."validation_failure_code" is not null),
	CONSTRAINT "inference_provider_connections_active_requires_valid" CHECK ("inference_provider_connections"."status" <> 'active' or "inference_provider_connections"."validation_state" <> 'invalid'),
	CONSTRAINT "inference_provider_connections_terms_acknowledged" CHECK (not "inference_provider_connections"."provider_terms_acknowledgement_required" or "inference_provider_connections"."terms_acknowledged_at" is not null),
	CONSTRAINT "inference_provider_connections_secret_ref_format" CHECK ("inference_provider_connections"."secret_ref" ~ '^(vault|kms|ssm|secretsmanager):[A-Za-z0-9/_.:@-]+$' and length("inference_provider_connections"."secret_ref") <= 512),
	CONSTRAINT "inference_provider_connections_secret_ref_partition" CHECK (right("inference_provider_connections"."secret_ref", length('/' || "inference_provider_connections"."environment" || '/' || "inference_provider_connections"."owner_account_id" || '/' || "inference_provider_connections"."id")) = '/' || "inference_provider_connections"."environment" || '/' || "inference_provider_connections"."owner_account_id" || '/' || "inference_provider_connections"."id"),
	CONSTRAINT "inference_provider_connections_key_prefix_length" CHECK (length("inference_provider_connections"."key_prefix") between 1 and 12),
	CONSTRAINT "inference_provider_connections_fingerprint_format" CHECK ("inference_provider_connections"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "inference_providers" ADD COLUMN "byok_terms_acknowledgement_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_providers" ADD COLUMN "byok_terms_url" text;--> statement-breakpoint
ALTER TABLE "inference_providers" ADD CONSTRAINT "inference_providers_byok_terms_key" UNIQUE("slug","byok_terms_acknowledgement_required");
--> statement-breakpoint
ALTER TABLE "inference_providers" ADD CONSTRAINT "inference_providers_byok_terms_url" CHECK (not "inference_providers"."byok_terms_acknowledgement_required" or "inference_providers"."byok_terms_url" is not null);
--> statement-breakpoint
ALTER TABLE "inference_provider_connection_audit_events" ADD CONSTRAINT "inference_provider_connection_audit_events_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connection_audit_events" ADD CONSTRAINT "inference_provider_connection_audit_events_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connection_audit_events" ADD CONSTRAINT "inference_provider_connection_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_provider_terms_fk" FOREIGN KEY ("provider","provider_terms_acknowledgement_required") REFERENCES "public"."inference_providers"("slug","byok_terms_acknowledgement_required") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_provider_connection_audit_events_connection_created_idx" ON "inference_provider_connection_audit_events" USING btree ("connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_provider_connection_audit_events_owner_created_idx" ON "inference_provider_connection_audit_events" USING btree ("owner_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_provider_connection_audit_events_created_at_idx" ON "inference_provider_connection_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_provider_connections_live_scope_key" ON "inference_provider_connections" USING btree ("owner_account_id","scope_kind",coalesce("application_id", ''),"provider","environment") WHERE "inference_provider_connections"."status" in ('pending_validation', 'active');--> statement-breakpoint
CREATE INDEX "inference_provider_connections_owner_account_id_created_at_idx" ON "inference_provider_connections" USING btree ("owner_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_provider_connections_application_id_idx" ON "inference_provider_connections" USING btree ("application_id");