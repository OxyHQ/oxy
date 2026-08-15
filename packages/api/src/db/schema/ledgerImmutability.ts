/**
 * Append-Only Enforcement for the financial ledger.
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`.
 *
 * ADR 0009's rule is that settled receipts, reversals and ledger entries are
 * APPEND-ONLY: a correction is a compensating record referencing the original,
 * never an update or a delete. "A mutated financial record cannot be
 * distinguished from a correct one after the fact" is the reason, and it is
 * exactly why the rule cannot be left to discipline.
 *
 * ## Why a trigger, and why this text lives here
 *
 * A CHECK constraint sees only the NEW row and never the OLD one, so it cannot
 * express "nothing changed". drizzle-kit emits tables, constraints and indexes
 * from a schema file and cannot emit a trigger at all. So the DDL is
 * hand-written — and the authoritative copy lives HERE, in the schema, so that a
 * regeneration of the table migration has something to restore its migration
 * file from. That is the same arrangement `transparencyCheckpoints.ts` already
 * uses, for the same reason, and `schema/__tests__/inferenceLedger.test.ts`
 * fails naming the missing trigger if one is ever dropped.
 *
 * ## `BEFORE UPDATE OR DELETE`, unlike the transparency triggers
 *
 * The transparency checkpoint guard is `BEFORE UPDATE` only, deliberately, so
 * that a parent's `ON DELETE CASCADE` is not turned into a confusing constraint
 * failure. That reasoning does not carry here: every foreign key INTO these
 * tables is `ON DELETE RESTRICT`, and every foreign key OUT of them points at
 * `users`, `applications` and `application_credentials` with `RESTRICT` as well.
 * Nothing cascades into a financial record, so guarding DELETE costs nothing and
 * closes the more damaging half — an UPDATE at least leaves a row behind.
 *
 * `usage_receipt_unit_prices` is guarded too. The price snapshot IS the receipt's
 * arithmetic; a receipt nobody may edit whose prices anybody may rewrite is not
 * immutable.
 *
 * `usage_reservations` is NOT guarded, and that is deliberate: a hold is a
 * lifecycle, not a record of money moved. Its `status` legitimately advances
 * `held → settled | released | expired`, and every one of those transitions is
 * itself journalled as an immutable ledger entry.
 */

/** The tables the trigger below is installed on. Read by the schema test. */
export const IMMUTABLE_LEDGER_TABLES = [
  'usage_receipts',
  'usage_receipt_unit_prices',
  'usage_refunds',
  'billing_ledger_entries',
  'billing_ledger_postings',
] as const;

export type ImmutableLedgerTable = (typeof IMMUTABLE_LEDGER_TABLES)[number];

/**
 * The DDL applied by `drizzle/0034_inference_ledger_immutability.sql`.
 *
 * One shared function rather than five: the message names `TG_TABLE_NAME`, so it
 * is as specific as five copies would be and there is one place for the rule to
 * be correct. `SQLSTATE 23514` (check violation) rather than a bespoke code, so
 * `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
 * failure — a caller must never have to string-match this message.
 */
export const LEDGER_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION billing_ledger_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a settled financial record is corrected by a compensating entry, never by % ', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;`;

/** `CREATE TRIGGER` for one table, in the shape the migration file carries. */
export function ledgerImmutabilityTriggerDdl(table: ImmutableLedgerTable): string {
  return `CREATE TRIGGER ${table}_immutable
BEFORE UPDATE OR DELETE ON ${table}
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();`;
}
