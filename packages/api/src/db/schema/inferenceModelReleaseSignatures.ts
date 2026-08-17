/**
 * `inference_model_release_signatures` — the detached signatures over one
 * ingested release manifest (issue #972 §12).
 *
 * Stored because a signature Oxy discarded is a signature nobody can ever check.
 * What signs an Alia release, and what resolves the `keyId` that names the public
 * key, is an open owner decision (`@oxyhq/contracts`'
 * `inference/aliaModelRelease.ts` argues it at length and takes neither answer).
 * A verifier therefore does not exist yet — and the difference between a design
 * that waits for one and a design that cannot use one when it arrives is exactly
 * whether these rows and `inference_model_releases.manifest_json` were kept.
 *
 * ## A signature is not a credential, and this table is not protected
 *
 * `protectedColumns.ts` withholds live bearer credentials and private keys. A
 * detached signature is neither: it is a public assertion about a public
 * document, verifiable by anyone holding the public key and useless for
 * impersonation. The one thing that would be a credential — a private signing key
 * — never touches Oxy at all.
 *
 * ## No verification result, for the third time in this subsystem
 *
 * No `verified_at`, no `verification_error`, no `key_source`. Whether a signature
 * checked out is Oxy's FINDING about the document rather than a claim the document
 * makes about itself, and there is no finding. A nullable `verified_at` that
 * nothing ever writes is indistinguishable, to a reader, from a verification that
 * has not run yet on this row in particular.
 *
 * Append-only; the trigger lives in `inferenceModelReleaseImmutability.ts`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { inferenceModelReleases } from './inferenceModelReleases';

/**
 * The signature schemes a stored signature may name. Mirrors
 * `aliaReleaseSignatureSchema.algorithm`.
 *
 * ONE member, and closed, for the reason the contract gives: a verifier that
 * trusts a document's own algorithm name accepts whatever that document
 * nominates, `none` included. Ed25519 is the scheme ADR 0012 already chose for
 * asymmetric verification on this platform. A second member lands when a verifier
 * for it does.
 */
export const RELEASE_SIGNATURE_ALGORITHMS = ['ed25519'] as const;

export type ReleaseSignatureAlgorithm = (typeof RELEASE_SIGNATURE_ALGORITHMS)[number];

/**
 * The canonicalization the signature's bytes were produced under. Mirrors
 * `aliaReleaseSignatureSchema.canonicalization`.
 *
 * Stored rather than assumed: a digest over "the manifest" is not verifiable by
 * two implementations that serialize JSON differently, so the scheme is part of
 * what the row records.
 */
export const RELEASE_SIGNATURE_CANONICALIZATIONS = ['jcs'] as const;

export type ReleaseSignatureCanonicalization =
  (typeof RELEASE_SIGNATURE_CANONICALIZATIONS)[number];

export const inferenceModelReleaseSignatures = pgTable(
  'inference_model_release_signatures',
  {
    id: generatedId(),

    /** `CASCADE`: a signature over a document that is gone verifies nothing. */
    releaseId: text()
      .notNull()
      .references(() => inferenceModelReleases.id, { onDelete: 'cascade' }),

    algorithm: text({ enum: RELEASE_SIGNATURE_ALGORITHMS }).notNull(),
    canonicalization: text({ enum: RELEASE_SIGNATURE_CANONICALIZATIONS }).notNull(),

    /** Opaque identifier of the public key. What resolves it is undecided. */
    keyId: text().notNull(),

    /** Unpadded base64url. 86 characters is a 64-byte Ed25519 signature. */
    signature: text().notNull(),

    /** When the signer signed. Not when Oxy stored it — that is `created_at`. */
    signedAt: timestamptz().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    /**
     * One signature per key per release. Two signatures from one key are one
     * signature written twice, and a duplicate would make a future "two
     * independent signers" check pass on one signer.
     *
     * Also the read index for "every signature of this release".
     */
    unique('inference_model_release_signatures_release_id_key_id_key').on(t.releaseId, t.keyId),

    check(
      'inference_model_release_signatures_algorithm_check',
      sql`${t.algorithm} in (${sql.raw(inList(RELEASE_SIGNATURE_ALGORITHMS))})`
    ),
    check(
      'inference_model_release_signatures_canonicalization_check',
      sql`${t.canonicalization} in (${sql.raw(inList(RELEASE_SIGNATURE_CANONICALIZATIONS))})`
    ),
    /**
     * The wire format, at the length the one permitted algorithm produces. A
     * second algorithm moves this into a per-algorithm constraint, which is
     * another reason the enum above is closed.
     */
    check(
      'inference_model_release_signatures_signature_format',
      sql`${t.signature} ~ ${sql.raw(String.raw`'^[A-Za-z0-9_-]{86}$'`)}`
    ),
  ]
);

export type InferenceModelReleaseSignatureRow =
  typeof inferenceModelReleaseSignatures.$inferSelect;
