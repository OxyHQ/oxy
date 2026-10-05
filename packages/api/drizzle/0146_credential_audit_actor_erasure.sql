-- oxy:deploy-phase=pre
-- Canonical account erasure invokes actor_user_id ON DELETE SET NULL.
-- Preserve immutable 0043 history; replace only its function, not its trigger.
-- Permit that FK transition only after the parent is gone, with every other
-- audit column unchanged. Direct edits, including manual NULL and no-op, deny.
-- No table/row rewrite, disabled trigger, runtime flag or broad UPDATE exception.

CREATE OR REPLACE FUNCTION credential_audit_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A foreign-key SET NULL during genuine account erasure is not an audit
  -- edit. Keep the event byte-for-byte except for its now-absent actor.
  -- The depth and absent-parent checks refuse a direct/manual NULL rewrite.
  IF pg_trigger_depth() > 1
    AND OLD.actor_user_id IS NOT NULL
    AND NEW.actor_user_id IS NULL
    AND (to_jsonb(NEW) - 'actor_user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'actor_user_id')
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.actor_user_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: an audit entry is corrected by a new entry, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
