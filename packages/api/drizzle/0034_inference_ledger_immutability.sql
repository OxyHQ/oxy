-- oxy:deploy-phase=pre
--
-- Append-only enforcement for the inference financial ledger (#972 workstream 7).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row and never the
-- old one. The authoritative text lives in the schema, as
-- `LEDGER_IMMUTABILITY_DDL` in `src/db/schema/ledgerImmutability.ts`, so a
-- regeneration of the table migration has something to restore this file from —
-- and `src/db/schema/__tests__/inferenceLedger.test.ts` fails naming the missing
-- trigger if one is ever dropped. Same arrangement, and the same reasons, as
-- `0005_transparency_immutability.sql`.
--
-- WHY `pre`, and why that is the SAFER side rather than the looser one.
--
-- The tables these triggers guard are created by 0033, in the same release, and
-- no running image writes to them. So this breaks no write the previous image
-- performs, which is the test. Deferring it to `post` would be the dangerous
-- choice on two counts: a zero-capacity deploy skips `post` entirely, and
-- until it ran, a settled receipt would be freely UPDATE-able — the exact
-- property ADR 0009 exists to remove.
--
-- WHAT IT PROTECTS. ADR 0009: settled receipts, reversals and ledger entries are
-- append-only, and a correction is a compensating record referencing the
-- original, never an edit. A mutated financial record cannot be distinguished
-- from a correct one after the fact, and nothing re-verifies a stored receipt on
-- read.
--
-- `BEFORE UPDATE OR DELETE`, unlike the transparency triggers, which guard
-- UPDATE only so a parent's CASCADE is not turned into a confusing constraint
-- failure. Nothing cascades into a financial record here — every foreign key
-- into these tables is `ON DELETE RESTRICT` — so guarding DELETE costs nothing
-- and closes the more damaging half.
--
-- `usage_reservations` is deliberately NOT guarded: a hold is a lifecycle, not
-- a record of money moved, and its status legitimately advances
-- `held -> settled | released | expired`. Every one of those transitions is
-- itself journalled as an immutable ledger entry.

CREATE OR REPLACE FUNCTION billing_ledger_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a settled financial record is corrected by a compensating entry, never by % ', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_receipts_immutable
BEFORE UPDATE OR DELETE ON usage_receipts
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();
--> statement-breakpoint
CREATE TRIGGER usage_receipt_unit_prices_immutable
BEFORE UPDATE OR DELETE ON usage_receipt_unit_prices
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();
--> statement-breakpoint
CREATE TRIGGER usage_refunds_immutable
BEFORE UPDATE OR DELETE ON usage_refunds
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();
--> statement-breakpoint
CREATE TRIGGER billing_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON billing_ledger_entries
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();
--> statement-breakpoint
CREATE TRIGGER billing_ledger_postings_immutable
BEFORE UPDATE OR DELETE ON billing_ledger_postings
FOR EACH ROW EXECUTE FUNCTION billing_ledger_row_immutable();
