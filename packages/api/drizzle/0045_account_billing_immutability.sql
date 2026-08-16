-- oxy:deploy-phase=pre
--
-- Append-only enforcement for the two account-billing tables that record FACTS
-- rather than state (issue #972, sections 7.1 and 7.4).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row and never the
-- old one. The authoritative text lives in the schema, as
-- `ACCOUNT_BILLING_IMMUTABILITY_DDL` in
-- `src/db/schema/accountBillingImmutability.ts`, so a regeneration of the table
-- migration has something to restore this file from — and
-- `src/db/schema/__tests__/accountBilling.test.ts` fails naming the missing
-- trigger if either is ever dropped. Same arrangement, and the same reasons, as
-- `0034_inference_ledger_immutability.sql` and
-- `0042_inference_provider_connection_immutability.sql`.
--
-- WHY `pre`. Both tables are created by 0043, in the same release, and no
-- running image writes to them. So this breaks no write the previous image
-- performs, which is the test. Deferring it to `post` would be the dangerous
-- choice on two counts: a zero-capacity deploy skips `post` entirely, and until
-- it ran a recorded processor payment would be freely UPDATE-able.
--
-- UPDATE **and** DELETE, following 0034 rather than 0042.
--
-- The BYOK audit trail guards UPDATE only because it has a retention sweep that
-- a DELETE guard would break on every run. These two tables have no sweep — both
-- are on the NEVER_SWEPT list in
-- `src/db/__tests__/inferenceLedgerRetention.test.ts` — so the financial
-- ledger's posture applies unchanged: a processor payment and a reconciliation
-- finding are historical facts, corrected by a NEW row, never by editing or
-- removing the old one.
--
-- The two sibling tables deliberately left UNGUARDED, and why:
--
--   billing_auto_recharge_attempts   transitions pending -> succeeded|failed.
--                                    The MONEY of a successful recharge is the
--                                    billing_external_payments row it produces,
--                                    which is guarded.
--   billing_reconciliation_runs      transitions running -> completed|failed.
--                                    Its FINDINGS are the discrepancy rows,
--                                    which are guarded.
--
-- `SQLSTATE 23514` (check violation) rather than a bespoke code, so
-- `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
-- failure — a caller must never have to string-match this message.

CREATE OR REPLACE FUNCTION account_billing_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a correction is a new row, never %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_external_payments_immutable
BEFORE UPDATE OR DELETE ON billing_external_payments
FOR EACH ROW EXECUTE FUNCTION account_billing_row_immutable();
--> statement-breakpoint
CREATE TRIGGER billing_reconciliation_discrepancies_immutable
BEFORE UPDATE OR DELETE ON billing_reconciliation_discrepancies
FOR EACH ROW EXECUTE FUNCTION account_billing_row_immutable();
