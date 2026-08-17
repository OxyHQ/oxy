/**
 * Append-only enforcement for an ingested release manifest (issue #972 §12).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, exactly as `applicationCredentialAuditImmutability.ts`,
 * `ledgerImmutability.ts` and `inferenceProviderConnectionImmutability.ts` are.
 *
 * ## What this closes
 *
 * `inferenceModelReleases.ts` calls the stored manifest EVIDENCE: the bytes a
 * verifier will one day check a signature against. That is true of the code — no
 * route issues an UPDATE — and was false of the database, and the gap matters
 * more here than for an ordinary audit row. A signed document that can be edited
 * after the fact is not evidence at all: the signature would simply stop
 * verifying, and the honest diagnosis ("somebody changed the bytes") is
 * indistinguishable from the alarming one ("the signature was forged") to whoever
 * eventually runs the check.
 *
 * ## Why a trigger, and why this text lives here
 *
 * A CHECK sees only the NEW row and never the OLD one, so it cannot express
 * "nothing changed", and drizzle-kit emits tables, constraints and indexes from a
 * schema file and cannot emit a trigger at all. So the DDL is hand-written and the
 * authoritative copy lives HERE, so a regeneration of the table migrations has
 * something to restore `drizzle/0054_inference_model_release_ingestion.sql` from.
 * `schema/__tests__/inferenceModelDocumentation.test.ts` fails naming any missing
 * trigger, and compares the migration file against these constants, so the two
 * cannot drift.
 *
 * ## TWO functions, because one column must remain writable and two tables have none
 *
 * `inference_model_releases.ingested_by_user_id` is `ON DELETE SET NULL` on
 * `users`, which performs an UPDATE. A trigger that refused every UPDATE on that
 * table would turn deleting a staff account into a constraint failure — the
 * erasure request would fail on a compliance record, which is the wrong way round.
 * So {@link INFERENCE_RELEASE_IMMUTABILITY_DDL} is COLUMN-SCOPED, naming the five
 * columns the signature covers and leaving the actor column alone.
 *
 * The two child tables have no actor column and nothing an `ON DELETE` clause
 * could ever set, so {@link INFERENCE_RELEASE_CHILD_IMMUTABILITY_DDL} refuses
 * every UPDATE outright, and one function serves both triggers.
 *
 * ## `BEFORE UPDATE` only
 *
 * Every foreign key into these three tables is `CASCADE` from a model revision,
 * so a DELETE guard would turn removing a model from the catalogue into a trigger
 * failure — the same reason `0036` guards UPDATE alone. A deleted row is absent,
 * and visibly so; an edited row is a lie that reads as a fact.
 *
 * `SQLSTATE 23514` (check violation) rather than a bespoke code, so `@oxyhq/db`'s
 * `isCheckViolation` recognises it like any other constraint failure — a caller
 * must never have to string-match a message.
 */

import { INFERENCE_RELEASE_IMMUTABLE_COLUMNS } from './inferenceModelReleases';

/** The tables the triggers are installed on. Read by the schema test. */
export const INFERENCE_RELEASE_TABLE = 'inference_model_releases';
export const INFERENCE_RELEASE_ARTIFACTS_TABLE = 'inference_model_release_artifacts';
export const INFERENCE_RELEASE_SIGNATURES_TABLE = 'inference_model_release_signatures';

/** The trigger names, so a test asserts their existence without a literal. */
export const INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_NAME = 'inference_model_releases_immutable';
export const INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_NAME =
  'inference_model_release_artifacts_immutable';
export const INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_NAME =
  'inference_model_release_signatures_immutable';

/**
 * The `WHEN … IS DISTINCT FROM …` chain, rendered from
 * {@link INFERENCE_RELEASE_IMMUTABLE_COLUMNS}.
 *
 * Rendered rather than written out so the tuple the test drives an UPDATE per
 * column from, and the DDL that refuses those columns, are one statement of the
 * set. Written twice they could disagree, and the disagreement would be a column
 * the test believes is protected and the database lets through.
 */
const IMMUTABLE_COLUMN_BRANCHES = INFERENCE_RELEASE_IMMUTABLE_COLUMNS.map(
  (column) => `    WHEN new.${column} IS DISTINCT FROM old.${column} THEN '${column}'`
).join('\n');

/** Column-scoped refusal for the release row itself. See this module's header. */
export const INFERENCE_RELEASE_IMMUTABILITY_DDL = `
CREATE OR REPLACE FUNCTION inference_model_release_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
${IMMUTABLE_COLUMN_BRANCHES}
    ELSE null
  END;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION '${INFERENCE_RELEASE_TABLE}.% is immutable: the stored manifest is the bytes a signature covers, and editing it makes a broken signature indistinguishable from a forged one', changed
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END;
$$;
`.trim();

export const INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_DDL = `
CREATE TRIGGER ${INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_NAME}
BEFORE UPDATE ON ${INFERENCE_RELEASE_TABLE}
FOR EACH ROW EXECUTE FUNCTION inference_model_release_immutable();
`.trim();

/**
 * Unconditional refusal, for the two child tables.
 *
 * `TG_TABLE_NAME` is substituted at RAISE time, which is what lets one function
 * serve both triggers and still name the table an operator touched.
 */
export const INFERENCE_RELEASE_CHILD_IMMUTABILITY_DDL = `
CREATE OR REPLACE FUNCTION inference_model_release_child_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: it records what a release signature covers, so a correction is a new release rather than an %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
`.trim();

export const INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_DDL = `
CREATE TRIGGER ${INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_NAME}
BEFORE UPDATE ON ${INFERENCE_RELEASE_ARTIFACTS_TABLE}
FOR EACH ROW EXECUTE FUNCTION inference_model_release_child_immutable();
`.trim();

export const INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_DDL = `
CREATE TRIGGER ${INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_NAME}
BEFORE UPDATE ON ${INFERENCE_RELEASE_SIGNATURES_TABLE}
FOR EACH ROW EXECUTE FUNCTION inference_model_release_child_immutable();
`.trim();
