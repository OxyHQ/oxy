/**
 * The signed Alia model release manifest — the ingestion contract for a
 * first-party model release.
 *
 * The catalogue already STORES everything such a manifest carries: the model
 * card, the licence block, the provenance and base model, the evaluation table,
 * the safety metadata, and an artifact digest with a `sha256:<64 hex>` CHECK.
 * What did not exist was the manifest itself — a single document Alia SIGNS,
 * asserting all of it at once — and that is the gap this shape closes. Nothing
 * here re-declares a catalogue field; the manifest COMPOSES the published shapes
 * so a manifest and the catalogue row it produces cannot describe a release
 * differently.
 *
 * ## The manifest tightens the revision it carries
 *
 * `modelRevisionSchema` makes `modelCardUrl`, `artifactDigest`, `evaluations`
 * and `safety` optional, because a third-party route legitimately has none of
 * them — Oxy did not train those weights and cannot publish a card for them. A
 * FIRST-PARTY release has no such excuse: the documentation trail is the reason
 * a release manifest exists at all, and a model Alia ships without one is not a
 * release, it is a deployment. So the refinement below requires all four,
 * without changing the catalogue shape that a third-party entry still parses
 * through.
 *
 * ## `.strict()` at the top level, and here that is forced rather than chosen
 *
 * The shapes exchanged with the data plane tolerate an unknown field, because
 * refusing a producer one minor version ahead is a worse failure than ignoring
 * its addition (`version.ts`). A SIGNED document inverts that: the signature is
 * over the canonical bytes of the manifest, so a field silently stripped at this
 * parse is a field missing from the bytes Oxy re-canonicalizes, and verification
 * fails. A tolerant parse would therefore report "the signature is invalid" for
 * what is really "this build does not understand this manifest" — the wrong
 * diagnosis of the right problem. Strict says the true thing, and the cost is
 * bounded: ingestion is a release-time operation an operator retries once Oxy
 * takes the newer contract, not a served request that becomes unsettleable.
 *
 * ## What is deliberately NOT here
 *
 * **No HTTP write path.** The catalogue's emptiness is currently a safety
 * property — `scripts/seed-inference-catalogue.ts` refuses to invent a licence
 * or a retention flag because "a plausible invented value in a catalogue is
 * worse than an absent one" — and a staff write path into it with nothing to
 * ingest is an unexercised hazard. The schema lands; the endpoint waits for a
 * real manifest to ingest.
 *
 * **No `payloadDigest` field.** The signature is over the canonical
 * serialization of this manifest with `signatures` removed, and a verifier
 * recomputes it. Storing the digest beside the document it digests would be a
 * second source of truth for one fact, and a verifier that compared the
 * signature against the DECLARED digest rather than the recomputed one would
 * verify nothing at all.
 *
 * **No verification RESULT.** Whether a signature checked out is Oxy's finding
 * about the document, not a claim the document makes about itself; a `verified`
 * field inside a signed manifest is the signer asserting its own signature.
 *
 * ## The open owner decision this shape does not take
 *
 * **What signs, and what verifies, is not decided.** Oxy holds no Alia signing
 * key, and whether to resolve `keyId` through the existing attestation machinery
 * (`services/oxyVerificationResolver.ts`, the civic attestation code) or to
 * introduce a dedicated Alia release key is a real choice with different
 * custody, rotation and revocation consequences. So `keyId` is an OPAQUE
 * identifier and this file names no registry that resolves it: either answer
 * fits, and neither is presupposed. Until it is answered a manifest can be
 * parsed and cannot be verified, which is the second reason no endpoint ships.
 *
 * Decided in: docs/adr/0008-catalogue-concept-separation.md,
 * docs/adr/0017-authorized-routes-in-the-envelope.md, issue #972 §12.
 */

import { z } from 'zod';
import {
  modelLicenseSchema,
  modelProvenanceSchema,
  modelRevisionSchema,
} from './catalogue';
import {
  inferenceTimestampSchema,
  RESERVED_ALIA_PUBLISHER,
  sha256DigestSchema,
} from './identifiers';

/**
 * One artifact of a release, by path and digest.
 *
 * `sizeBytes` is required beside the digest so a verifier can refuse a stream
 * that is the wrong length before reading it to the end, rather than only after.
 */
export const aliaReleaseArtifactSchema = z
  .object({
    /** Path within the release, e.g. `model-00001-of-00004.safetensors`. */
    path: z.string().min(1).max(512),
    digest: sha256DigestSchema,
    sizeBytes: z.number().int().positive().safe(),
    mediaType: z.string().min(1).max(255).optional(),
  })
  .strict();

/**
 * One detached signature over the manifest.
 *
 * `algorithm` is a CLOSED enum with one member, and both halves of that are
 * deliberate. Closed, because a verifier that trusts a document's own algorithm
 * name accepts whatever that document nominates, `none` included. One member,
 * because Ed25519 is the scheme ADR 0012 already chose for asymmetric
 * verification on this platform, and naming a scheme nothing here can check
 * would be advertising a capability that does not exist. A second member lands
 * when a verifier for it does — which is a closed enum gaining a member, and
 * therefore a MINOR contract-set change the handshake surfaces (`version.ts`).
 *
 * `keyId` is opaque on purpose: see the header. It identifies the public key
 * without saying what resolves it.
 *
 * The signature covers the canonical serialization (RFC 8785 JCS) of the
 * manifest with `signatures` removed. The canonicalization is NAMED rather than
 * left implicit because a digest over "the manifest" is not verifiable by two
 * implementations that serialize JSON differently; naming it is a mechanical
 * necessity and is independent of the open question of which key signs.
 */
export const aliaReleaseSignatureSchema = z
  .object({
    algorithm: z.enum(['ed25519']),
    canonicalization: z.enum(['jcs']),
    /** Opaque identifier of the public key. Resolving it is undecided. */
    keyId: z.string().min(1).max(256),
    /**
     * Unpadded base64url. Exactly 86 characters, which is a 64-byte Ed25519
     * signature — the one algorithm above. A second algorithm moves this length
     * into a refinement keyed on `algorithm`.
     */
    signature: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{86}$/,
        'signature must be a 64-byte ed25519 signature in unpadded base64url',
      ),
    signedAt: inferenceTimestampSchema,
  })
  .strict();

/**
 * A signed release of an `alia/*` model revision.
 *
 * `signatures` is a LIST rather than one signature, because "what signs" is
 * undecided: a single field would presuppose one signer, while a list lets an
 * Alia release key and an existing attestation co-sign the same document without
 * either being retrofitted later.
 */
export const aliaModelReleaseManifestSchema = z
  .object({
    /** See `version.ts`: an ingestion payload is a whole message on the wire. */
    schemaVersion: z.literal(1),
    /** The release's own identity, so ingestion is idempotent on it. */
    releaseId: z.string().min(1).max(128),
    issuedAt: inferenceTimestampSchema,
    /**
     * The revision being released. Carries its OWN `schemaVersion`, like
     * `billingProfileSchema` inside `accountBillingStateSchema`: the manifest's
     * version governs the manifest and the revision's governs the revision,
     * which is two versions of two things rather than two versions of one.
     */
    revision: modelRevisionSchema,
    /** On the MODEL rather than the revision in the catalogue, so carried here. */
    provenance: modelProvenanceSchema,
    license: modelLicenseSchema,
    artifacts: z.array(aliaReleaseArtifactSchema).min(1),
    signatures: z.array(aliaReleaseSignatureSchema).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // The same rule `catalogueModelSchema` enforces on a model, applied to the
    // carrier that creates one: `alia/*` names models Alia actually owns or
    // derived, and a manifest is the document that would launder somebody else's
    // weights into the namespace.
    const publisher = manifest.revision.modelId.slice(
      0,
      manifest.revision.modelId.indexOf('/'),
    );
    if (publisher !== RESERVED_ALIA_PUBLISHER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'modelId'],
        message: `an Alia release manifest releases a ${RESERVED_ALIA_PUBLISHER}/* model`,
      });
    }

    if (
      manifest.provenance.releaseKind !== 'first_party_original' &&
      manifest.provenance.releaseKind !== 'first_party_derived'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'releaseKind'],
        message: 'an Alia release manifest describes a first-party release',
      });
    }

    // A derived model's base is the licence-attribution trail. Recording the
    // derivation without naming what it derives from loses exactly the fact
    // attribution needs.
    if (
      manifest.provenance.releaseKind === 'first_party_derived' &&
      manifest.provenance.baseModelId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'baseModelId'],
        message: 'a derived release names the model it derives from',
      });
    }

    // The four fields a third-party catalogue entry may omit and a first-party
    // release may not. See the header.
    if (manifest.revision.modelCardUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'modelCardUrl'],
        message: 'a first-party release publishes a model card',
      });
    }

    if (manifest.revision.safety === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'safety'],
        message: 'a first-party release publishes its safety metadata',
      });
    }

    if (manifest.revision.evaluations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'evaluations'],
        message: 'a first-party release publishes at least one evaluation result',
      });
    }

    // The digest the catalogue will serve has to be one of the digests this
    // manifest signed. Otherwise the signature covers a set of artifacts that
    // does not include the weights anybody runs.
    if (manifest.revision.artifactDigest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'artifactDigest'],
        message: 'a first-party release names the digest of the artifact it serves',
      });
    } else if (
      !manifest.artifacts.some((artifact) => artifact.digest === manifest.revision.artifactDigest)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision', 'artifactDigest'],
        message: 'the served artifact digest must appear among the signed artifacts',
      });
    }

    const paths = manifest.artifacts.map((artifact) => artifact.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'each artifact path appears once in a release',
      });
    }

    // Two signatures from one key are one signature written twice, and a
    // duplicate would make a "two independent signers" check pass on one signer.
    const keyIds = manifest.signatures.map((signature) => signature.keyId);
    if (new Set(keyIds).size !== keyIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signatures'],
        message: 'each signing key signs a manifest once',
      });
    }
  });

export type AliaReleaseArtifact = z.infer<typeof aliaReleaseArtifactSchema>;
export type AliaReleaseSignature = z.infer<typeof aliaReleaseSignatureSchema>;
export type AliaModelReleaseManifest = z.infer<typeof aliaModelReleaseManifestSchema>;
