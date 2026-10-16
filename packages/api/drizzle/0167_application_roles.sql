-- oxy:deploy-phase=pre
-- Application roles: an application's own permission vocabulary and the grants
-- of it to Oxy users (docs/auth/application-roles.md). Additive: two new tables
-- nothing in the serving image reads, so correct against both images.
--
-- The two trigger functions at the end are HAND-WRITTEN; drizzle-kit cannot
-- emit them and a regeneration drops them. Their authoritative text is
-- src/db/schema/applicationRolesImmutability.ts, and
-- src/db/schema/__tests__/applicationRoles.test.ts asserts this file still
-- carries it verbatim.
CREATE TABLE "application_role_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"permission_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by_user_id" text,
	"grant_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"revoke_reason" text,
	CONSTRAINT "application_role_grants_revocation_check" CHECK ("application_role_grants"."revoked_at" is not null or ("application_role_grants"."revoked_by_user_id" is null and "application_role_grants"."revoke_reason" is null)),
	CONSTRAINT "application_role_grants_reason_length_check" CHECK (("application_role_grants"."grant_reason" is null or char_length("application_role_grants"."grant_reason") between 1 and 500) and ("application_role_grants"."revoke_reason" is null or char_length("application_role_grants"."revoke_reason") between 1 and 500))
);
--> statement-breakpoint
CREATE TABLE "application_role_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"declared_by_user_id" text,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_role_permissions_key_check" CHECK ("application_role_permissions"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$' and char_length("application_role_permissions"."key") <= 64),
	CONSTRAINT "application_role_permissions_description_check" CHECK (char_length("application_role_permissions"."description") between 1 and 280),
	CONSTRAINT "application_role_permissions_retired_by_check" CHECK ("application_role_permissions"."retired_by_user_id" is null or "application_role_permissions"."retired_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_permission_id_application_role_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."application_role_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_permissions" ADD CONSTRAINT "application_role_permissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_permissions" ADD CONSTRAINT "application_role_permissions_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_permissions" ADD CONSTRAINT "application_role_permissions_retired_by_user_id_users_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_role_grants_live_idx" ON "application_role_grants" USING btree ("user_id","permission_id") WHERE "application_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "application_role_grants_permission_id_created_at_idx" ON "application_role_grants" USING btree ("permission_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "application_role_permissions_live_key_idx" ON "application_role_permissions" USING btree ("application_id","key") WHERE "application_role_permissions"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "application_role_permissions_application_id_created_at_idx" ON "application_role_permissions" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION application_role_grant_row_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Revocation, the one edit: a live grant takes its revoked_* stamp once and
  -- nothing else about it moves.
  IF OLD.revoked_at IS NULL
    AND NEW.revoked_at IS NOT NULL
    AND (to_jsonb(NEW) - 'revoked_at' - 'revoked_by_user_id' - 'revoke_reason')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by_user_id' - 'revoke_reason')
  THEN
    RETURN NEW;
  END IF;
  -- Account erasure: ON DELETE SET NULL of ONE attribution column, from the
  -- foreign-key cascade only, after the person is gone.
  IF pg_trigger_depth() > 1 AND (
    (OLD.granted_by_user_id IS NOT NULL
      AND NEW.granted_by_user_id IS NULL
      AND (to_jsonb(NEW) - 'granted_by_user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'granted_by_user_id')
      AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.granted_by_user_id))
    OR (OLD.revoked_by_user_id IS NOT NULL
      AND NEW.revoked_by_user_id IS NULL
      AND (to_jsonb(NEW) - 'revoked_by_user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'revoked_by_user_id')
      AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.revoked_by_user_id))
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'application_role_grants is append-only: a grant is revoked once and re-granted as a new row, never edited'
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER application_role_grants_append_only
BEFORE UPDATE ON application_role_grants
FOR EACH ROW EXECUTE FUNCTION application_role_grant_row_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION application_role_permission_row_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  erased_declarer boolean := pg_trigger_depth() > 1
    AND OLD.declared_by_user_id IS NOT NULL
    AND NEW.declared_by_user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.declared_by_user_id);
  erased_retirer boolean := pg_trigger_depth() > 1
    AND OLD.retired_by_user_id IS NOT NULL
    AND NEW.retired_by_user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.retired_by_user_id);
BEGIN
  IF
    -- Identity: id, application, key and declaration time never move.
    (to_jsonb(NEW) - 'description' - 'updated_at' - 'retired_at' - 'retired_by_user_id' - 'declared_by_user_id')
      IS DISTINCT FROM (to_jsonb(OLD) - 'description' - 'updated_at' - 'retired_at' - 'retired_by_user_id' - 'declared_by_user_id')
    -- The declarer moves only to NULL, through the erasure cascade.
    OR (NEW.declared_by_user_id IS DISTINCT FROM OLD.declared_by_user_id AND NOT erased_declarer)
    -- Retirement is one-way and, once stamped, fixed.
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
    -- The retirer is stamped WITH the retirement, or cleared by erasure.
    OR (NEW.retired_by_user_id IS DISTINCT FROM OLD.retired_by_user_id
      AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND OLD.retired_by_user_id IS NULL)
      AND NOT erased_retirer)
    -- A retired key's description is history.
    OR (OLD.retired_at IS NOT NULL AND NEW.description IS DISTINCT FROM OLD.description)
  THEN
    RAISE EXCEPTION 'application_role_permissions: a declared key is never renamed, moved or un-retired; retire it and declare a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER application_role_permissions_guard
BEFORE UPDATE ON application_role_permissions
FOR EACH ROW EXECUTE FUNCTION application_role_permission_row_guard();
