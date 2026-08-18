/**
 * `inference_model_release_artifacts` — the signed artifact inventory of one
 * release (issue #972 §12).
 *
 * §12 asks the catalogue to accept "artifact digests", PLURAL, and until this
 * table the catalogue could hold exactly one:
 * `inference_model_revisions.artifact_digest`, the digest of the artifact Oxy
 * SERVES. A release is a set of files — sharded weights, a tokenizer, a config —
 * and the manifest signs every one of them. Ingesting a signed inventory and
 * keeping only the served digest would discard most of what the signature covers.
 *
 * A child table rather than `jsonb` on the release, per `CONVENTIONS.md`: an
 * array of ENTITIES with a known shape becomes a real table, because a `jsonb`
 * array cannot be joined, constrained or usefully indexed — and this one is
 * looked up BY DIGEST, which is the whole question it answers ("is this file part
 * of a release Oxy ingested?").
 *
 * ## `size_bytes` sits beside the digest because a verifier needs it first
 *
 * `aliaReleaseArtifactSchema` requires it, and the reason carries through to
 * storage: a verifier can refuse a stream of the wrong length before reading it
 * to the end rather than only after.
 *
 * Append-only, with the trigger in `inferenceModelReleaseImmutability.ts`. There
 * is no actor column here — the release row carries the actor, and one request
 * wrote both in one transaction.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import { inferenceModelReleases } from './inferenceModelReleases';

export const inferenceModelReleaseArtifacts = pgTable(
  'inference_model_release_artifacts',
  {
    id: generatedId(),

    /** `CASCADE`: an artifact of a release that is gone describes nothing. */
    releaseId: text()
      .notNull()
      .references(() => inferenceModelReleases.id, { onDelete: 'cascade' }),

    /** Path within the release, e.g. `model-00001-of-00004.safetensors`. */
    path: text().notNull(),

    /**
     * `sha256:<64 lowercase hex>`, the same one spelling
     * `inference_model_revisions.artifact_digest` is constrained to and for the
     * same reason: a digest is compared for equality and nothing else, so an
     * uppercase or unprefixed variant of one hash is a different string.
     */
    digest: text().notNull(),

    /** `bigint` — a shard of weights passes `integer`'s 2.1e9 ceiling routinely. */
    sizeBytes: bigint({ mode: 'number' }).notNull(),

    mediaType: text(),

    createdAt: createdAt(),
  },
  (t) => [
    /**
     * One row per `(release, path)`. `aliaModelReleaseManifestSchema` refuses a
     * manifest whose paths repeat; this is the same rule where a concurrent
     * write cannot get around it.
     *
     * The index also serves "every artifact of this release", so no separate
     * `release_id` index is declared — a btree answers any leading prefix and a
     * redundant index is one `CONVENTIONS.md` says to drop.
     */
    unique('inference_model_release_artifacts_release_id_path_key').on(t.releaseId, t.path),

    check(
      'inference_model_release_artifacts_digest_format',
      sql`${t.digest} ~ ${sql.raw(String.raw`'^sha256:[a-f0-9]{64}$'`)}`
    ),
    check('inference_model_release_artifacts_size_positive', sql`${t.sizeBytes} > 0`),

    /**
     * "Which release signed these bytes?" — the reverse lookup, and the reason
     * this is a table. Not covered by the unique index above, which leads with
     * the release.
     */
    index('inference_model_release_artifacts_digest_idx').on(t.digest),
  ]
);

export type InferenceModelReleaseArtifactRow =
  typeof inferenceModelReleaseArtifacts.$inferSelect;
