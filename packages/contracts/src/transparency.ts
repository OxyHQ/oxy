import { z } from 'zod';

/**
 * Transparency log — the public wire contract of the checkpoint surface.
 *
 * A checkpoint is the operator's signed commitment to EVERY subject's chain head
 * at a point in time: "at `periodEnd` I committed to `root` over `treeSize`
 * subjects, and the previous checkpoint hashed to `prevCheckpointHash`". Anyone
 * can then ask for an inclusion proof of their own head and verify it against
 * that root without trusting the server — which is what closes the one gap a
 * per-subject hash chain cannot close on its own (the server serving two
 * different histories, or quietly dropping a record).
 *
 * The Merkle math, the leaf/checkpoint signing bytes, and the proof verifier all
 * live in `@oxyhq/protocol` (`src/transparency/`); this module only fixes the
 * SHAPES that cross the wire, so a client and the API cannot drift on them.
 *
 * Digest fields are pinned to 64-char LOWERCASE hex on purpose: the digests are
 * compared as strings against locally recomputed hashes, so accepting an
 * upper-case or truncated variant would turn a real mismatch into a confusing
 * verification failure at a distance.
 */

/** A SHA-256 digest in the exact form the protocol emits: 64 lowercase hex chars. */
const hexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a 64-char lowercase hex digest');

/**
 * One signer's endorsement of a checkpoint's signed fields.
 *
 * The operator and every independent witness produce this same shape over the
 * SAME bytes, so the array on a checkpoint can grow without coordination.
 */
export const transparencyCheckpointSignatureSchema = z.object({
    /** Uncompressed hex public key of the signer. */
    publicKey: z.string().min(1),
    alg: z.literal('ES256K-DER-SHA256'),
    /** DER-encoded hex secp256k1 signature over the checkpoint signing input. */
    signature: z.string().min(1),
});

/** Where a checkpoint root was published on a public chain. */
export const transparencyAnchorSchema = z.object({
    /** Chain/network identifier, e.g. `faircoin-main`. */
    network: z.string().min(1),
    txid: z.string().min(1),
    confirmations: z.number().int().nonnegative(),
    /** When the anchoring transaction was broadcast (ms epoch). */
    anchoredAt: z.number().int().positive(),
});

/**
 * A published checkpoint.
 *
 * `signatures` is non-empty by contract: an unsigned root commits nobody and
 * must never be served as a checkpoint. `anchors` may be empty — a checkpoint is
 * published immediately and anchored asynchronously, so "not yet anchored" is a
 * normal, temporary state rather than an error.
 */
export const transparencyCheckpointSchema = z.object({
    index: z.number().int().nonnegative(),
    /** End of the committed period (ms epoch). */
    periodEnd: z.number().int().positive(),
    /** Number of subjects (leaves) committed. */
    treeSize: z.number().int().nonnegative(),
    root: hexDigestSchema,
    /** Hash of the previous checkpoint; `null` only at genesis. */
    prevCheckpointHash: hexDigestSchema.nullable(),
    signatures: z.array(transparencyCheckpointSignatureSchema).min(1),
    anchors: z.array(transparencyAnchorSchema),
});

/**
 * An inclusion proof for one subject against one checkpoint.
 *
 * Carries the leaf PREIMAGE (`subjectDid`, `seq`, `headRecordId`) as well as the
 * `leaf` digest so the verifier re-derives the leaf itself rather than trusting
 * the server's hash, then walks `proof` up to the checkpoint's `root`.
 */
export const transparencyInclusionProofSchema = z.object({
    checkpoint: transparencyCheckpointSchema,
    subjectDid: z.string().min(1),
    seq: z.number().int().nonnegative(),
    headRecordId: hexDigestSchema,
    leaf: hexDigestSchema,
    leafIndex: z.number().int().nonnegative(),
    /** Audit path, leaf-adjacent sibling first; empty for a single-leaf tree. */
    proof: z.array(hexDigestSchema),
});

/** A page of the checkpoint chain, oldest first, for walking `prevCheckpointHash`. */
export const transparencyCheckpointListSchema = z.object({
    checkpoints: z.array(transparencyCheckpointSchema),
});

export type TransparencyCheckpointSignature = z.infer<typeof transparencyCheckpointSignatureSchema>;
export type TransparencyAnchor = z.infer<typeof transparencyAnchorSchema>;
export type TransparencyCheckpoint = z.infer<typeof transparencyCheckpointSchema>;
export type TransparencyInclusionProof = z.infer<typeof transparencyInclusionProofSchema>;
export type TransparencyCheckpointList = z.infer<typeof transparencyCheckpointListSchema>;
