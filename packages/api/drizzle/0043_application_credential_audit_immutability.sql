-- oxy:deploy-phase=pre
--
-- Append-only enforcement for the credential lifecycle trail (issue #996,
-- #972 §2.3).
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row and never the
-- old one. The authoritative text lives in the schema, as
-- `CREDENTIAL_AUDIT_IMMUTABILITY_DDL` in
-- `src/db/schema/applicationCredentialAuditImmutability.ts`, so a regeneration
-- of the table migration has something to restore this file from — and
-- `src/db/schema/__tests__/applicationCredentialAudit.test.ts` fails naming the
-- missing trigger if it is ever dropped. Same arrangement, and the same
-- reasons, as `0034_inference_ledger_immutability.sql` and
-- `0042_inference_provider_connection_immutability.sql`.
--
-- WHAT IT PROTECTS. `application_credential_audit_events` (added by #980)
-- records who created, rotated or revoked a credential, and every refused
-- bearer presented against one. It was declared append-only in its own header
-- and enforced by nothing: no route issues an UPDATE, which is not the same as
-- an UPDATE being refused. This is the record someone would want to alter after
-- misusing a credential, so "no code writes that statement today" is exactly
-- the protection an audit table may not rely on.
--
-- WHY `pre`, and why that is the SAFER side rather than the looser one.
--
-- No running image performs an UPDATE against this table — the only writer is
-- `services/applicationCredentialAudit.service.ts`, which inserts — so this
-- breaks no write the previous image performs, which is the test. Deferring it
-- to `post` would be the dangerous choice on two counts: a zero-capacity deploy
-- skips `post` entirely, and until it ran, an audit row would stay freely
-- UPDATE-able.
--
-- `BEFORE UPDATE` ONLY — the same shape as 0042, and for the same reason, not
-- 0034's.
--
-- The financial ledger guards UPDATE *and* DELETE because it keeps every row
-- forever: no retention sweep, and every foreign key into it is RESTRICT. This
-- table has a sweep. `src/db/expiry.ts` deletes these events at two years — the
-- window the table's own header commits to — and it has to, because
-- `validation_failed` rows accrue for as long as a misconfigured client retries
-- a dead key. A DELETE guard would not make the trail safer; it would make that
-- sweep fail on every run and let the table grow without bound behind something
-- that reads as protection. `application_id` is `ON DELETE CASCADE` besides, so
-- a DELETE guard would also turn deleting an application into a trigger
-- failure.
--
-- So the guard closes the half that matters for an audit trail: an EDIT. A
-- deleted row is absent, and visibly so against the retention window; an edited
-- row is a lie that reads as a fact.
--
-- ITS OWN FUNCTION rather than one of the two that already raise this refusal.
-- `billing_ledger_row_immutable()` says "a settled financial record is
-- corrected by a compensating entry", which is the wrong sentence to raise at
-- somebody editing an audit row. `provider_connection_audit_row_immutable()`
-- says the right sentence under a name that would be a lie here, and would make
-- this table's guard a dependency of the BYOK workstream.
--
-- `SQLSTATE 23514` (check violation) rather than a bespoke code, so
-- `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
-- failure — a caller must never have to string-match this message.

CREATE OR REPLACE FUNCTION credential_audit_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: an audit entry is corrected by a new entry, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER application_credential_audit_events_immutable
BEFORE UPDATE ON application_credential_audit_events
FOR EACH ROW EXECUTE FUNCTION credential_audit_row_immutable();
