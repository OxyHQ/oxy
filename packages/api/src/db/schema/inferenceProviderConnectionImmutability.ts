/**
 * Append-only enforcement for the BYOK connection audit trail
 * (issue #972 workstream 10).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `ledgerImmutability.ts` is.
 *
 * ## Why a trigger, and why this text lives here
 *
 * A CHECK sees only the NEW row and never the OLD one, so it cannot express
 * "nothing changed", and drizzle-kit cannot emit a trigger at all. So the DDL is
 * hand-written, and the authoritative copy lives HERE so a regeneration of the
 * table migration has something to restore
 * `drizzle/0042_inference_provider_connection_immutability.sql` from.
 * `schema/__tests__/inferenceProviderConnections.test.ts` fails naming the
 * missing trigger if it is ever dropped.
 *
 * ## `BEFORE UPDATE` only — the deliberate difference from `0034`
 *
 * The financial ledger's trigger guards UPDATE **and** DELETE, because nothing
 * ever removes a ledger row: it has no retention sweep and every foreign key
 * into it is `RESTRICT`.
 *
 * This table does have a sweep. `db/expiry.ts` deletes audit events at two
 * years — the same window `security_activities` and
 * `application_credential_audit_events` keep — and it has to, because `used`
 * events accrue for the life of every connection. A DELETE guard would not make
 * the table safer; it would make the sweep fail on every run, and the table grow
 * without bound behind a guard that reads as protection.
 *
 * So the guard closes the half that matters for an audit trail: an EDIT. A
 * deleted row is absent, and its absence is visible against the retention window
 * and against the connection's own `created_at`. An edited row is a lie that
 * reads as a fact. `0005_transparency_immutability.sql` guards UPDATE only for
 * its own reasons and is the precedent for the shape, not for the reason.
 *
 * `SQLSTATE 23514` (check violation) rather than a bespoke code, so
 * `@oxyhq/db`'s `isCheckViolation` recognises it like any other constraint
 * failure — a caller must never have to string-match the message.
 */

/** The table the trigger is installed on. Read by the schema test. */
export const PROVIDER_CONNECTION_AUDIT_TABLE = 'inference_provider_connection_audit_events';

/** The trigger's name, so the test asserting its existence names one thing. */
export const PROVIDER_CONNECTION_AUDIT_TRIGGER = 'inference_provider_connection_audit_immutable';

/** The DDL applied by `drizzle/0042_inference_provider_connection_immutability.sql`. */
export const PROVIDER_CONNECTION_AUDIT_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION provider_connection_audit_row_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: an audit entry is corrected by a new entry, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;`;

/** `CREATE TRIGGER`, in the shape the migration file carries. */
export const PROVIDER_CONNECTION_AUDIT_IMMUTABILITY_TRIGGER_DDL = `CREATE TRIGGER ${PROVIDER_CONNECTION_AUDIT_TRIGGER}
BEFORE UPDATE ON ${PROVIDER_CONNECTION_AUDIT_TABLE}
FOR EACH ROW EXECUTE FUNCTION provider_connection_audit_row_immutable();`;
