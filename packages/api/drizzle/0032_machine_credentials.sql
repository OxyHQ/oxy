-- oxy:deploy-phase=pre
--
-- OpenAI-SDK-compatible machine credentials (issue #972 §2.3): the `machine`
-- credential type, the two columns holding an `oxy_sk_…` bearer token's lookup
-- half and its hash, and the lifecycle audit table.
--
-- WHY `pre`.
--
-- The widening forces it, and there is no narrowing half to argue about. The
-- arriving image writes `type = 'machine'`, a value the CURRENT
-- `application_credentials_type_check` rejects, so the constraint has to be
-- widened BEFORE the rollout or every credential-create on the new image fails
-- against the old database. The same image writes `token_prefix` / `token_hash`,
-- columns that do not exist yet, and inserts into
-- `application_credential_audit_events` on every credential create, rotate and
-- revoke — so a credential written by the new image against the old schema would
-- not merely lose its audit row, it would fail outright.
--
-- The gate rule's real question is "does this break a write the PREVIOUS image
-- performs", and nothing here does. Every new column is nullable with no
-- default, so the outgoing image's inserts continue to satisfy them:
--   * `..._machine_token_prefix_check` reads `(type = 'machine') = (token_prefix
--     is not null)`. The outgoing image writes neither side — its types are the
--     three old ones and it never names `token_prefix` — so both halves are
--     false and the check holds for every existing row and every write it makes.
--   * `..._machine_token_hash_check` and `..._machine_no_secret_check` are
--     satisfied identically: NULL = NULL, and `type <> 'machine'` is true.
-- The widened type check is strictly more permissive than the one it replaces,
-- so no in-flight write can fall foul of the swap either.
--
-- ORDER. The DROP of the old type check precedes every statement that mentions
-- `type`, and the widened one is added last; the three machine checks sit
-- between the two and reference `'machine'` as a literal, which is valid whether
-- or not the enum check naming it is installed. The unique constraint on
-- `token_prefix` is added after the column, and the audit table's foreign key
-- into `application_credentials` after both tables exist.
--
-- NO BACKFILL, and nothing to backfill: `machine` is a new type, so no existing
-- row can hold one, and `token_prefix` is meaningful only on rows this migration
-- makes it possible to create.

CREATE TABLE "application_credential_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"event_type" text NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environment" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"effective_until" timestamp with time zone,
	CONSTRAINT "application_credential_audit_events_event_type_check" CHECK ("application_credential_audit_events"."event_type" in ('created', 'rotated', 'revoked', 'validation_failed')),
	CONSTRAINT "application_credential_audit_events_reason_check" CHECK ("application_credential_audit_events"."reason" is null or "application_credential_audit_events"."reason" in ('secret_mismatch', 'not_usable', 'environment_mismatch', 'application_inactive', 'scope_missing')),
	CONSTRAINT "application_credential_audit_events_failure_reason_check" CHECK ("application_credential_audit_events"."event_type" <> 'validation_failed' or "application_credential_audit_events"."reason" is not null),
	CONSTRAINT "application_credential_audit_events_no_actor_on_failure_check" CHECK ("application_credential_audit_events"."event_type" <> 'validation_failed' or "application_credential_audit_events"."actor_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_type_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ADD COLUMN "token_prefix" text;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "application_credential_audit_events" ADD CONSTRAINT "application_credential_audit_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credential_audit_events" ADD CONSTRAINT "application_credential_audit_events_credential_id_application_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credential_audit_events" ADD CONSTRAINT "application_credential_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_credential_audit_events_application_id_created_at_idx" ON "application_credential_audit_events" USING btree ("application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "application_credential_audit_events_credential_id_created_at_idx" ON "application_credential_audit_events" USING btree ("credential_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "application_credential_audit_events_created_at_idx" ON "application_credential_audit_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_token_prefix_key" UNIQUE("token_prefix");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_machine_token_prefix_check" CHECK (("application_credentials"."type" = 'machine') = ("application_credentials"."token_prefix" is not null));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_machine_token_hash_check" CHECK (("application_credentials"."token_hash" is null) = ("application_credentials"."token_prefix" is null));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_machine_no_secret_check" CHECK ("application_credentials"."type" <> 'machine' or "application_credentials"."secret_hash" is null);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_type_check" CHECK ("application_credentials"."type" in ('public', 'confidential', 'service', 'machine'));