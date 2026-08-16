-- oxy:deploy-phase=pre
--
-- Routing policy immutability (issue #972, workstream 6).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row, never the old.
-- Same shape and same reason as 0034_inference_ledger_immutability.sql and
-- 0036_inference_revision_immutability.sql.
--
-- The authoritative text lives in the schema, as
-- `src/db/schema/inferenceRoutingImmutability.ts`, so a regeneration of 0039 has
-- something to restore this file from -- and
-- `src/db/schema/__tests__/inferenceRoutingPolicy.test.ts` drives a real UPDATE
-- against each guarded table and fails naming the one that stopped being
-- refused.
--
-- WHY `pre`: additive, and it constrains only tables 0039 has just created,
-- which no running image writes to. See 0039's header for the full argument.
--
-- WHAT IT PROTECTS, and what breaks without it.
--
-- The epic requires that a request record the exact policy version it executed
-- under. That reference is worth nothing if the version can be edited
-- afterwards: a settled receipt would then point at whatever the customer most
-- recently saved rather than at the constraints that were actually applied, and
-- the two are indistinguishable after the fact. So every column of
-- `inference_routing_policy_versions` is frozen except `is_current` --
-- superseding a version is not editing it, exactly as
-- `inference_model_revisions.is_current` is excluded from that table's guard for
-- the same reason.
--
-- The version guard compares the WHOLE ROW minus `is_current` rather than
-- listing protected columns. A hand-maintained list would be a gate that skips
-- whatever is missing from it, so a column added to this table later would be
-- silently unprotected and nothing would report it; the whole-row comparison
-- covers every column that exists now and every column anybody adds, and still
-- names the offending ones in the message.
--
-- The three record tables are frozen ENTIRELY:
--
--   inference_routing_policy_price_caps   a version nobody may edit whose price
--   inference_routing_policy_fallbacks    ceilings and cross-model
--                                         authorisations anybody may rewrite is
--                                         not immutable -- the same reasoning
--                                         `usage_receipt_unit_prices` records
--                                         for the settled price snapshot.
--
--   inference_route_switch_events         a customer-visible notice that is
--                                         editable afterwards is not a notice.
--
-- BEFORE UPDATE only, never OR DELETE: `inference_routing_policies` cascades
-- into these tables, and guarding DELETE would turn an ordinary cascade into a
-- confusing constraint failure. Deleting a version anything has USED is already
-- refused by `usage_receipts.routing_policy_version_id` and by
-- `inference_route_switch_events`' two references, all ON DELETE RESTRICT -- so
-- the reachable delete is exactly the one that erases nothing anybody relied on.
--
-- ERRCODE 23514 (`check_violation`) so `@oxyhq/db`'s `isCheckViolation`
-- recognises this like any other constraint failure and no caller has to
-- string-match a message.

CREATE OR REPLACE FUNCTION inference_routing_policy_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  SELECT string_agg(entry.key, ', ' ORDER BY entry.key)
    INTO changed
    FROM jsonb_each(to_jsonb(new) - 'is_current') AS entry
   WHERE entry.value IS DISTINCT FROM (to_jsonb(old) -> entry.key);

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'inference_routing_policy_versions.% is immutable: a request records the exact policy version it executed under, so a change appends a new version', changed
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_routing_policy_versions_immutable
BEFORE UPDATE ON inference_routing_policy_versions
FOR EACH ROW EXECUTE FUNCTION inference_routing_policy_version_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_routing_record_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: it is part of an immutable policy version or a notice already shown to a customer, so a change appends a new version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_routing_policy_price_caps_immutable
BEFORE UPDATE ON inference_routing_policy_price_caps
FOR EACH ROW EXECUTE FUNCTION inference_routing_record_immutable();
--> statement-breakpoint
CREATE TRIGGER inference_routing_policy_fallbacks_immutable
BEFORE UPDATE ON inference_routing_policy_fallbacks
FOR EACH ROW EXECUTE FUNCTION inference_routing_record_immutable();
--> statement-breakpoint
CREATE TRIGGER inference_route_switch_events_immutable
BEFORE UPDATE ON inference_route_switch_events
FOR EACH ROW EXECUTE FUNCTION inference_routing_record_immutable();
