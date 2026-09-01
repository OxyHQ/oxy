/**
 * Append-only enforcement for the two account-billing tables that record facts
 * rather than state (issue #972, sections 7.1 and 7.4).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `ledgerImmutability.ts` and
 * `inferenceProviderConnectionImmutability.ts` are.
 *
 * ## Why a trigger
 *
 * A CHECK sees only the NEW row and never the OLD one, so it cannot express
 * "nothing changed", and drizzle-kit cannot emit a trigger at all. The DDL is
 * therefore hand-written, and the authoritative text lives HERE so a
 * regeneration of the table migration has something to restore
 * `drizzle/0045_account_billing_immutability.sql` from.
 * `schema/__tests__/accountBilling.test.ts` fails naming the missing trigger if
 * either is ever dropped.
 *
 * ## UPDATE **and** DELETE, following `0034` rather than `0042`
 *
 * The BYOK audit trail guards UPDATE only, because it has a retention sweep and
 * a DELETE guard would break it on every run. These two tables have no sweep —
 * both are on the `NEVER_SWEPT` list in
 * `db/__tests__/inferenceLedgerRetention.test.ts` — so the financial ledger's
 * posture applies unchanged: a processor payment and a reconciliation finding
 * are historical facts, corrected by a NEW row, never by editing or removing the
 * old one.
 *
 * The two tables that are deliberately NOT guarded, and why:
 *
 *  - `billing_auto_recharge_attempts` transitions `pending → succeeded|failed`.
 *    Its money is the `billing_external_payments` row it produces, which IS
 *    guarded.
 *  - `billing_reconciliation_runs` transitions `running → completed|failed`.
 *    Its findings are the discrepancy rows, which ARE guarded.
 *
 * `SQLSTATE 23514` (check violation) rather than a bespoke code, so
 * `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
 * failure — a caller must never have to string-match a message.
 */

/** The tables the triggers are installed on. Read by the schema test. */
export const EXTERNAL_PAYMENTS_TABLE = 'billing_external_payments';

export const RECONCILIATION_DISCREPANCIES_TABLE = 'billing_reconciliation_discrepancies';

/** The trigger names, so the tests asserting their existence name one thing. */
export const EXTERNAL_PAYMENTS_IMMUTABILITY_TRIGGER = 'billing_external_payments_immutable';

export const RECONCILIATION_DISCREPANCIES_IMMUTABILITY_TRIGGER =
  'billing_reconciliation_discrepancies_immutable';

/** The shared guard function applied by `drizzle/0045_account_billing_immutability.sql`. */
export const ACCOUNT_BILLING_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION account_billing_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a correction is a new row, never %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;`;

/** `CREATE TRIGGER` for each guarded table, in the shape the migration carries. */
export const ACCOUNT_BILLING_IMMUTABILITY_TRIGGER_DDL = [
  `CREATE TRIGGER ${EXTERNAL_PAYMENTS_IMMUTABILITY_TRIGGER}
BEFORE UPDATE OR DELETE ON ${EXTERNAL_PAYMENTS_TABLE}
FOR EACH ROW EXECUTE FUNCTION account_billing_row_immutable();`,
  `CREATE TRIGGER ${RECONCILIATION_DISCREPANCIES_IMMUTABILITY_TRIGGER}
BEFORE UPDATE OR DELETE ON ${RECONCILIATION_DISCREPANCIES_TABLE}
FOR EACH ROW EXECUTE FUNCTION account_billing_row_immutable();`,
] as const;
