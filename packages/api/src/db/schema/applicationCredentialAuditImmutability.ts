/**
 * Append-only enforcement for the credential lifecycle trail (issue #972 §2.3).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `ledgerImmutability.ts` and
 * `inferenceProviderConnectionImmutability.ts` are.
 *
 * ## What this closes
 *
 * `applicationCredentialAuditEvents.ts` opens with "No `updated_at`, and nothing
 * updates a row. An audit entry that can be edited is not one." That was true of
 * the code and false of the database: no route issued an `UPDATE`, and nothing
 * stopped one. An audit trail's whole value is that the party being audited
 * cannot edit it, and "the statement has not been written yet" is not a
 * protection — a credential audit row records who rotated or revoked what and
 * when, which is precisely the record someone would want to alter after misusing
 * a credential.
 *
 * ## Why a trigger, and why this text lives here
 *
 * A CHECK sees only the NEW row and never the OLD one, so it cannot express
 * "nothing changed", and drizzle-kit cannot emit a trigger at all. So the DDL is
 * hand-written, and the authoritative copy lives HERE so a regeneration of the
 * table migration has something to restore
 * `drizzle/0043_application_credential_audit_immutability.sql` from.
 * `schema/__tests__/applicationCredentialAudit.test.ts` fails naming the missing
 * trigger if it is ever dropped.
 *
 * ## Its own function, rather than reusing one that already exists
 *
 * Two functions in the database already raise this exact refusal.
 * `billing_ledger_row_immutable()` says "a settled financial record is corrected
 * by a compensating entry" — the wrong sentence to raise at somebody editing an
 * audit row, and the message is the only thing an operator reads.
 * `provider_connection_audit_row_immutable()` says the right sentence, but its
 * name would be a lie on this table, and it would make the credential trail's
 * protection a dependency of the BYOK workstream: retiring workstream 10 would
 * silently take this table's guard with it. One function per domain is what the
 * six already here do; this is the seventh, not a new pattern.
 *
 * ## `BEFORE UPDATE` only — the same reason as `0042`, not the same as `0034`
 *
 * The financial ledger guards UPDATE **and** DELETE because nothing ever removes
 * a ledger row: it has no retention sweep and every foreign key into it is
 * `RESTRICT`.
 *
 * This table has a sweep. `db/expiry.ts` deletes these events at two years — the
 * window the table's own header commits to — and `validation_failed` rows accrue
 * for as long as a misconfigured client keeps retrying a dead key. A DELETE
 * guard would not make the trail safer; it would make that sweep fail on every
 * run and let the table grow without bound behind something that reads as
 * protection. `application_id` is also `ON DELETE CASCADE`, so a DELETE guard
 * would additionally turn deleting an application into a trigger failure.
 *
 * So the guard closes the half that matters for an audit trail: an EDIT. A
 * deleted row is absent, and visibly so against the retention window. An edited
 * row is a lie that reads as a fact.
 *
 * `SQLSTATE 23514` (check violation) rather than a bespoke code, so `@oxyhq/db`'s
 * `isCheckViolation` recognises it like any other constraint failure — a caller
 * must never have to string-match this message.
 */

/** The table the trigger is installed on. Read by the schema test. */
export const CREDENTIAL_AUDIT_TABLE = 'application_credential_audit_events';

/** The trigger's name, so the test asserting its existence names one thing. */
export const CREDENTIAL_AUDIT_TRIGGER = 'application_credential_audit_events_immutable';

/**
 * The refusal a caller sees, with `TG_TABLE_NAME` already substituted.
 *
 * Exported because the test asserts on THIS, not merely on `SQLSTATE 23514`.
 * Three CHECK constraints on this table raise 23514 too, so a code-only
 * assertion passes whether or not the trigger fired — that exact mistake made a
 * first mutation run on PR #997 turn fewer tests red than it should have.
 */
export const CREDENTIAL_AUDIT_IMMUTABLE_MESSAGE =
  `${CREDENTIAL_AUDIT_TABLE} is append-only: an audit entry is corrected by a new entry, never by update`;

/** The DDL applied by `drizzle/0043_application_credential_audit_immutability.sql`. */
export const CREDENTIAL_AUDIT_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION credential_audit_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: an audit entry is corrected by a new entry, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;`;

/** `CREATE TRIGGER`, in the shape the migration file carries. */
export const CREDENTIAL_AUDIT_IMMUTABILITY_TRIGGER_DDL = `CREATE TRIGGER ${CREDENTIAL_AUDIT_TRIGGER}
BEFORE UPDATE ON ${CREDENTIAL_AUDIT_TABLE}
FOR EACH ROW EXECUTE FUNCTION credential_audit_row_immutable();`;
