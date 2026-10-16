/**
 * Write guards for the application-roles tables (`applicationRoles.ts`).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `applicationCredentialAuditImmutability.ts` is.
 * The DDL lives HERE so a regeneration of `drizzle/0167_application_roles.sql`
 * (which drops every hand-written statement) has something to restore it from;
 * `schema/__tests__/applicationRoles.test.ts` fails naming the missing trigger,
 * and asserts the migration still carries this exact text.
 *
 * ## What each guard closes
 *
 * A grant is the record of who gave a person an operator power and who took it
 * away. It is exactly the record someone who misused that power would want to
 * edit, so it is append-only at the DATABASE, not merely by the absence of an
 * `UPDATE` in the service:
 *
 * - `application_role_grants`: the ONE permitted edit is the revocation stamp
 *   on a live grant (`revoked_at`, `revoked_by_user_id`, `revoke_reason`, set
 *   once, nothing else moving). Re-granting is a new row. Un-revoking,
 *   re-pointing a grant at another person or key, back-dating it, or rewriting
 *   its reason are all refused.
 * - `application_role_permissions`: a declared key's identity (application,
 *   key, who declared it, when) never moves, and retirement is one-way. Renaming
 *   a key in place would silently hand every holder of the old key the new
 *   one's power; un-retiring would silently restore grants a retirement revoked.
 *   The description may be edited while the key is live — it is presentation,
 *   not authority.
 *
 * Account erasure is the one other transition: PostgreSQL clears a
 * `*_by_user_id` through its `ON DELETE SET NULL` after the person is gone. Both
 * guards admit exactly that nested foreign-key update (trigger depth > 1, the
 * referenced user absent, every other column unchanged) — the same shape
 * migration 0146 gave the credential audit trail. A direct NULL write is refused.
 *
 * `BEFORE UPDATE` only. Rows are deleted solely by `ON DELETE CASCADE` (the
 * application's owner or the grantee erased), and a DELETE guard would turn
 * those erasures into trigger failures.
 *
 * `SQLSTATE 23514` so `@oxy.so/db`'s `isCheckViolation` recognises a refusal.
 */

export const APPLICATION_ROLE_GRANTS_TABLE = 'application_role_grants';
export const APPLICATION_ROLE_PERMISSIONS_TABLE = 'application_role_permissions';

export const APPLICATION_ROLE_GRANTS_TRIGGER = 'application_role_grants_append_only';
export const APPLICATION_ROLE_PERMISSIONS_TRIGGER = 'application_role_permissions_guard';

/** The refusal an edit of a grant raises. Asserted on by the schema test. */
export const APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE =
  'application_role_grants is append-only: a grant is revoked once and re-granted as a new row, never edited';

/** The refusal an edit of a declared key's identity or retirement raises. */
export const APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE =
  'application_role_permissions: a declared key is never renamed, moved or un-retired; retire it and declare a new one';

export const APPLICATION_ROLE_GRANTS_GUARD_DDL = `CREATE OR REPLACE FUNCTION application_role_grant_row_guard() RETURNS trigger
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
  RAISE EXCEPTION '${APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE}'
    USING ERRCODE = '23514';
END;
$$;`;

export const APPLICATION_ROLE_GRANTS_TRIGGER_DDL = `CREATE TRIGGER ${APPLICATION_ROLE_GRANTS_TRIGGER}
BEFORE UPDATE ON ${APPLICATION_ROLE_GRANTS_TABLE}
FOR EACH ROW EXECUTE FUNCTION application_role_grant_row_guard();`;

export const APPLICATION_ROLE_PERMISSIONS_GUARD_DDL = `CREATE OR REPLACE FUNCTION application_role_permission_row_guard() RETURNS trigger
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
    RAISE EXCEPTION '${APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE}'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;`;

export const APPLICATION_ROLE_PERMISSIONS_TRIGGER_DDL = `CREATE TRIGGER ${APPLICATION_ROLE_PERMISSIONS_TRIGGER}
BEFORE UPDATE ON ${APPLICATION_ROLE_PERMISSIONS_TABLE}
FOR EACH ROW EXECUTE FUNCTION application_role_permission_row_guard();`;

/**
 * Every hand-written statement, in the order the migration carries them. The
 * schema test asserts the migration file contains each one verbatim.
 */
export const APPLICATION_ROLES_HAND_WRITTEN_DDL = [
  APPLICATION_ROLE_GRANTS_GUARD_DDL,
  APPLICATION_ROLE_GRANTS_TRIGGER_DDL,
  APPLICATION_ROLE_PERMISSIONS_GUARD_DDL,
  APPLICATION_ROLE_PERMISSIONS_TRIGGER_DDL,
] as const;
