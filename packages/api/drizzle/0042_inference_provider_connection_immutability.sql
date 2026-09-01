-- oxy:deploy-phase=pre
--
-- Append-only enforcement for the BYOK connection audit trail (#972 workstream 10).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row and never the
-- old one. The authoritative text lives in the schema, as
-- `PROVIDER_CONNECTION_AUDIT_IMMUTABILITY_DDL` in
-- `src/db/schema/inferenceProviderConnectionImmutability.ts`, so a regeneration
-- of the table migration has something to restore this file from — and
-- `src/db/schema/__tests__/inferenceProviderConnections.test.ts` fails naming
-- the missing trigger if it is ever dropped. Same arrangement, and the same
-- reasons, as `0005_transparency_immutability.sql` and
-- `0034_inference_ledger_immutability.sql`.
--
-- WHY `pre`, and why that is the SAFER side rather than the looser one.
--
-- The table this guards is created by 0041, in the same release, and no running
-- image writes to it. So this breaks no write the previous image performs, which
-- is the test. Deferring it to `post` would be the dangerous choice on two
-- counts: a zero-capacity deploy skips `post` entirely, and until it ran, an
-- audit row would be freely UPDATE-able.
--
-- `BEFORE UPDATE` ONLY — the deliberate difference from 0034.
--
-- The financial ledger guards UPDATE *and* DELETE because it keeps every row
-- forever: it has no retention sweep and every foreign key into it is RESTRICT.
-- This table does have a sweep. `src/db/expiry.ts` deletes these events at two
-- years, and it has to: `used` events accrue for the life of every connection,
-- bounded only by a per-instance cooldown. A DELETE guard would not make the
-- trail safer — it would make that sweep fail on every run and let the table
-- grow without bound behind something that reads as protection.
--
-- So the guard closes the half that matters for an audit trail: an EDIT. A
-- deleted row is absent, and visibly so against the retention window; an edited
-- row is a lie that reads as a fact.
--
-- `SQLSTATE 23514` (check violation) rather than a bespoke code, so
-- `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
-- failure — a caller must never have to string-match this message.

CREATE OR REPLACE FUNCTION provider_connection_audit_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: an audit entry is corrected by a new entry, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_provider_connection_audit_immutable
BEFORE UPDATE ON inference_provider_connection_audit_events
FOR EACH ROW EXECUTE FUNCTION provider_connection_audit_row_immutable();
