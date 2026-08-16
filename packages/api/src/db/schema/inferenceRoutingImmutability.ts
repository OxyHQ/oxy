/**
 * Append-Only Enforcement for routing policy versions and their records.
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `ledgerImmutability.ts` is.
 *
 * The epic's requirement is "version routing policies so a request records the
 * exact policy used". That is worth nothing unless the version cannot change
 * after the request recorded it: a mutable version turns a receipt's
 * `{policy, version}` reference into a pointer at whatever the customer most
 * recently believed, which is precisely the ambiguity versioning exists to
 * remove. A CHECK constraint sees only the NEW row and never the OLD one, so it
 * cannot express "nothing changed", and drizzle-kit emits tables, constraints
 * and indexes but never a trigger — so the DDL is hand-written and its
 * authoritative copy lives HERE, in the schema, so that a regeneration of the
 * table migration has something to restore its migration file from.
 *
 * ## Two functions, because the two shapes differ
 *
 * {@link INFERENCE_ROUTING_POLICY_VERSION_IMMUTABILITY_DDL} guards
 * `inference_routing_policy_versions`, where exactly ONE column
 * ({@link ROUTING_POLICY_VERSION_MUTABLE_COLUMN}) is legitimately writable.
 * {@link INFERENCE_ROUTING_RECORD_IMMUTABILITY_DDL} guards the three tables
 * where NO column is: the price caps and cross-model authorisations that make up
 * a version's content, and the route-switch notices customers are shown.
 *
 * A version nobody may edit whose price caps and fallback authorisations anybody
 * may rewrite is not immutable — the same reasoning `usage_receipt_unit_prices`
 * records for the settled price snapshot.
 *
 * ## Why the version guard compares the whole row instead of listing columns
 *
 * `inference_model_revisions` names its four protected columns explicitly, which
 * is right there because most of that table is legitimately mutable. Here the
 * opposite holds: everything except `is_current` is the configuration a receipt
 * is explained against. A hand-maintained list would be a gate that SKIPS
 * whatever is missing from it, so a column added later would be silently
 * unprotected and nothing would report it. Comparing
 * `to_jsonb(new) - 'is_current'` against `to_jsonb(old)` covers every column
 * that exists now and every column anybody adds, and still names the offending
 * ones in the message.
 *
 * ## `BEFORE UPDATE`, not `OR DELETE`
 *
 * `inference_routing_policies` cascades into these tables, and guarding DELETE
 * would turn an ordinary cascade into a confusing constraint failure — the same
 * call `transparencyCheckpoints.ts` makes. Deleting a version anything has USED
 * is already refused, by `usage_receipts.routing_policy_version_id` and
 * `inference_route_switch_events` (`routing_policy_version_id` and the composite
 * authorisation key), all `RESTRICT`. So the reachable delete is exactly the one
 * that erases nothing anybody relied on.
 *
 * `SQLSTATE 23514` (check violation) rather than a bespoke code, so
 * `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
 * failure and no caller has to string-match these messages.
 */

import { ROUTING_POLICY_VERSION_MUTABLE_COLUMN } from './inferenceRoutingPolicyVersions';

/** Trigger name on `inference_routing_policy_versions`. */
export const ROUTING_POLICY_VERSION_IMMUTABILITY_TRIGGER_NAME =
  'inference_routing_policy_versions_immutable';

/**
 * Tables where no column may be updated at all. Read by the schema test, which
 * asserts each trigger reached `pg_trigger` and then drives a real UPDATE.
 */
export const IMMUTABLE_ROUTING_RECORD_TABLES = [
  'inference_routing_policy_price_caps',
  'inference_routing_policy_fallbacks',
  'inference_route_switch_events',
] as const;

export type ImmutableRoutingRecordTable = (typeof IMMUTABLE_ROUTING_RECORD_TABLES)[number];

/** The version guard, applied by `drizzle/0038_inference_routing_immutability.sql`. */
export const INFERENCE_ROUTING_POLICY_VERSION_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION inference_routing_policy_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  SELECT string_agg(entry.key, ', ' ORDER BY entry.key)
    INTO changed
    FROM jsonb_each(to_jsonb(new) - '${ROUTING_POLICY_VERSION_MUTABLE_COLUMN}') AS entry
   WHERE entry.value IS DISTINCT FROM (to_jsonb(old) -> entry.key);

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'inference_routing_policy_versions.% is immutable: a request records the exact policy version it executed under, so a change appends a new version', changed
      USING ERRCODE = '23514';
  END IF;

  RETURN new;
END;
$$;`;

/** `CREATE TRIGGER` for the version guard, in the shape the migration carries. */
export const INFERENCE_ROUTING_POLICY_VERSION_IMMUTABILITY_TRIGGER_DDL = `CREATE TRIGGER ${ROUTING_POLICY_VERSION_IMMUTABILITY_TRIGGER_NAME}
BEFORE UPDATE ON inference_routing_policy_versions
FOR EACH ROW EXECUTE FUNCTION inference_routing_policy_version_immutable();`;

/**
 * The whole-table guard. One shared function rather than three: the message
 * names `TG_TABLE_NAME`, so it is as specific as three copies would be and there
 * is one place for the rule to be correct.
 */
export const INFERENCE_ROUTING_RECORD_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION inference_routing_record_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: it is part of an immutable policy version or a notice already shown to a customer, so a change appends a new version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;`;

/** `CREATE TRIGGER` for one append-only table. */
export function inferenceRoutingRecordImmutabilityTriggerDdl(
  table: ImmutableRoutingRecordTable
): string {
  return `CREATE TRIGGER ${table}_immutable
BEFORE UPDATE ON ${table}
FOR EACH ROW EXECUTE FUNCTION inference_routing_record_immutable();`;
}
