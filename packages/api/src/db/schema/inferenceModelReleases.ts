/**
 * `inference_model_releases` — one signed Alia model release manifest, as
 * ingested (issue #972 §12).
 *
 * `@oxyhq/contracts`' `aliaModelReleaseManifestSchema` defined the document a
 * year's worth of catalogue columns can be built from, and shipped with "no HTTP
 * write path … the schema lands; the endpoint waits for a real manifest to
 * ingest". This table is what an endpoint writes: the manifest's own identity, the
 * revision it produced, and the bytes a verifier will one day check a signature
 * against.
 *
 * ## Why the manifest is stored VERBATIM beside the columns it produced
 *
 * Every field of a manifest also lands somewhere normalized —
 * `inference_models`, `inference_model_revisions`,
 * `inference_model_evaluations`, `inference_model_release_artifacts`. Storing the
 * document too looks like a second source of truth, and it is not one: the
 * normalized rows are what the catalogue SERVES, and `manifest_json` is
 * EVIDENCE — the only thing a signature can be verified against.
 *
 * A verifier cannot re-derive the signed bytes from the normalized rows. The
 * signature covers the RFC 8785 canonical serialization of the manifest with
 * `signatures` removed, and canonicalization is invariant to whitespace and key
 * order but NOT to a key set: zod's `.default([])` members alone would add keys
 * the signer never wrote. So what is stored is the document as RECEIVED, before
 * any parse applied a default, and the recorded fact is exactly "these are the
 * bytes that arrived".
 *
 * The two ways that could still differ from a signer's bytes are named rather
 * than glossed: a manifest containing DUPLICATE keys (JSON parsing keeps the
 * last, and a signer emitting duplicates is already not producing canonical
 * JSON), and a number written in a spelling that does not survive a JSON
 * round-trip (this schema's value space is integers and strings, so there is
 * none).
 *
 * ## No verification finding, and that is not an omission
 *
 * There is no `verified` column, no `verified_at`, no key-resolution result. Oxy
 * holds no Alia signing key and the manifest contract explicitly leaves what
 * signs and what verifies undecided, so no such finding exists to record. A column
 * that could only ever hold "unverified" would read, to anybody scanning the
 * table, as a verification step that ran.
 *
 * What authorizes an ingest is therefore the STAFF MEMBER, recorded in
 * `ingested_by_user_id` and gated on the `inference:catalogue:publish` capability
 * — the same authority model as `inference_deployments.legal_review_evidence_ref`,
 * where a person asserts a fact and the record says who. And the containment that
 * makes that acceptable is structural: ingesting a release creates a model and a
 * revision, NEITHER of which is servable or listed. `buildCatalogueEntry` returns
 * null for a model with no deployment, and a deployment still needs an approved
 * legal review before any customer can select it.
 *
 * ## Append-only, twice over
 *
 * No `updated_at` — per `CONVENTIONS.md`, its absence IS the append-only
 * contract — and `inferenceModelReleaseImmutability.ts` installs the trigger that
 * makes it true of the database rather than only of the code.
 */

import { integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { users } from './users';

export const inferenceModelReleases = pgTable(
  'inference_model_releases',
  {
    id: generatedId(),

    /**
     * The manifest's own `releaseId`.
     *
     * UNIQUE, which is what makes ingestion idempotent: a retried POST finds the
     * row rather than creating a second model revision. Enforced here and not in
     * the route, because two concurrent ingests pass any read-then-write check
     * and only a constraint stops the second.
     */
    releaseId: text().notNull(),

    /**
     * The revision this release produced.
     *
     * `CASCADE`, like every other child of a revision: a release record for
     * weights that are no longer in the catalogue describes nothing servable. The
     * signed document is not a financial record — `price_versions` stores its
     * model reference as plain TEXT precisely so a settled receipt survives a
     * catalogue row being removed — so nothing downstream is stranded by this.
     */
    modelRevisionId: text()
      .notNull()
      .references(() => inferenceModelRevisions.id, { onDelete: 'cascade' }),

    /**
     * The manifest's own `schemaVersion`, stored so a later verifier knows which
     * contract the bytes were written against without having to parse them.
     */
    manifestSchemaVersion: integer().notNull(),

    /** The manifest's `issuedAt` — when the SIGNER issued it, not when Oxy took it. */
    issuedAt: timestamptz().notNull(),

    /** The document as received. See this module's header. */
    manifestJson: text().notNull(),

    /**
     * The staff member who ingested it.
     *
     * `SET NULL` for the same reason every other actor column in this schema is:
     * the record must survive that account being erased. That also decides which
     * columns the immutability trigger may protect — see
     * `inferenceModelReleaseImmutability.ts`, where an `ON DELETE SET NULL` that
     * a BEFORE UPDATE trigger refused would turn deleting a user into a
     * constraint failure.
     */
    ingestedByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    /**
     * When Oxy took it. `created_at` and nothing else: an `ingested_at` beside it
     * would be two representations of one instant.
     */
    createdAt: createdAt(),
  },
  (t) => [unique('inference_model_releases_release_id_key').on(t.releaseId)]
);

export type InferenceModelReleaseRow = typeof inferenceModelReleases.$inferSelect;

/**
 * The columns the immutability trigger refuses to change, as SQL names.
 *
 * Read by the schema test, which drives an UPDATE per column and asserts each is
 * rejected — so adding a column here without adding it to the DDL fails, and
 * removing one from the DDL without removing it here fails too.
 *
 * `ingested_by_user_id` is deliberately ABSENT: it is the one column a legitimate
 * UPDATE touches, when a user deletion cascades `SET NULL` through it.
 */
export const INFERENCE_RELEASE_IMMUTABLE_COLUMNS = [
  'release_id',
  'model_revision_id',
  'manifest_schema_version',
  'issued_at',
  'manifest_json',
] as const;
