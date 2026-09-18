/**
 * Identity move contract — give a web root to Commons (add it, or keep it only in
 * Commons; ADR 0024 D6).
 *
 * The web (holding the root) shows a QR carrying only a move id; Commons scans.
 * The relay in between must not be able to take the root, so:
 *
 *  1. `POST /identity/move { initiatorCommitment }` — the web publishes only
 *     `H(initiatorKey, nonce)`, never the key.
 *  2. `POST /identity/move/:moveId/join { responderEphemeralPublicKey }` —
 *     Commons, having read the commitment first, joins with its own key.
 *  3. `POST /identity/move/:moveId/reveal` — only then does the web reveal its
 *     key and nonce; Commons checks them against the commitment it read.
 *  4. Both screens show a 6-digit code over `(moveId, both keys, commitment)`;
 *     the person confirms on the web that they match.
 *  5. `POST /identity/move/:moveId/seal` — the web seals the phrase entropy under
 *     `HKDF(ECDH(both keys), moveId)`, authorized by a one-use root proof over the
 *     exact sealed bytes.
 *  6. `POST /identity/move/:moveId/receipt` — Commons stores the root, reads it
 *     back from its keychain, and signs a receipt over the move, the root, both
 *     keys and the digest of the ciphertext it opened. The server verifies it; the
 *     web verifies it again from what IT sealed before removing anything.
 *
 * Why the commitment: without it the relay sees both keys before committing to
 * anything and can grind a substituted key until the two codes agree (~10⁶
 * tries, seconds). With it, the relay must fix the key it shows Commons before
 * learning Commons' key, and the key it shows the web before the web reveals.
 *
 * The server holds a commitment, two ephemeral public keys, an opaque ciphertext
 * and a receipt — nothing that decrypts the ciphertext.
 *
 * Platform-agnostic — zod only, ESM-safe (no `require()`).
 */
import { z } from 'zod';
import { canonicalJson, identityProofSchema } from './identityProof';

/** A move lives this long: one interactive handoff. */
export const IDENTITY_MOVE_TTL_MS = 5 * 60 * 1000;

/** 128-bit move id, lowercase hex. */
export const identityMoveIdSchema = z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/, 'moveId must be 32 lowercase hex characters');

/** An ephemeral secp256k1 public key, uncompressed lowercase hex. */
export const identityMoveEphemeralKeySchema = z
    .string()
    .trim()
    .regex(/^04[0-9a-f]{128}$/, 'ephemeral public key must be uncompressed, lowercase hex');

export const IDENTITY_MOVE_STATUSES = ['pending', 'joined', 'sealed', 'completed', 'cancelled', 'expired'] as const;
export type IdentityMoveStatus = (typeof IDENTITY_MOVE_STATUSES)[number];

/** The QR payload Commons scans. Carries the move id only. */
export const IDENTITY_MOVE_QR_PREFIX = 'oxycommons://move?id=';

const hex64 = (label: string) => z.string().trim().regex(/^[0-9a-f]{64}$/, `${label} must be 64 lowercase hex characters`);

export const identityMoveCreateRequestSchema = z
    .object({
        /** `H(initiator ephemeral key, nonce)` — the key itself is revealed only after Commons joins. */
        initiatorCommitment: hex64('initiatorCommitment'),
    })
    .strict();

export interface IdentityMoveCreateResponse {
    moveId: string;
    expiresAt: string;
}

export const identityMoveCreateResponseSchema: z.ZodType<IdentityMoveCreateResponse> = z.object({
    moveId: identityMoveIdSchema,
    expiresAt: z.string().datetime(),
});

export const identityMoveJoinRequestSchema = z.object({
    responderEphemeralPublicKey: identityMoveEphemeralKeySchema,
});

/** After Commons joined: the committed key and its nonce. */
export const identityMoveRevealRequestSchema = z
    .object({
        initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema,
        commitmentNonce: hex64('commitmentNonce'),
    })
    .strict();

export const identityMoveSealRequestSchema = z
    .object({
        /** 24-byte XChaCha20-Poly1305 nonce, hex. */
        nonce: z.string().trim().regex(/^[0-9a-f]{48}$/, 'nonce must be 48 lowercase hex characters'),
        /** The 16–32-byte phrase entropy (12–24 words), tag appended, hex. */
        ciphertext: z
            .string()
            .trim()
            .regex(/^(?:[0-9a-f]{64}|[0-9a-f]{72}|[0-9a-f]{80}|[0-9a-f]{88}|[0-9a-f]{96})$/, 'ciphertext has an unsupported length'),
        /**
         * Root proof (`identity_move_seal`), payload `{ moveId, nonce, ciphertext }`,
         * over a one-use challenge from `POST /identity/proof-challenge`.
         */
        proof: identityProofSchema,
    })
    .strict();

export const identityMoveReceiptRequestSchema = z
    .object({
        /** Root signature over `buildMoveReceiptMessage(...)`. */
        signature: z.string().trim().min(1).max(512),
    })
    .strict();

/** `GET /identity/move/:moveId` — everything either side needs, nothing that decrypts. */
export interface IdentityMoveState {
    moveId: string;
    status: IdentityMoveStatus;
    /** The commitment Commons must read before joining. */
    initiatorCommitment: string;
    /** The commitment's nonce, published with the key at reveal. */
    initiatorCommitmentNonce: string | null;
    /** The identity being moved (so Commons can check the key it will import). */
    publicKey: string;
    /** `null` until the web reveals it, after Commons joined. */
    initiatorEphemeralPublicKey: string | null;
    responderEphemeralPublicKey: string | null;
    nonce: string | null;
    ciphertext: string | null;
    receiptSignature: string | null;
    expiresAt: string;
}

export const identityMoveStateSchema: z.ZodType<IdentityMoveState> = z.object({
    moveId: identityMoveIdSchema,
    status: z.enum(IDENTITY_MOVE_STATUSES),
    initiatorCommitment: z.string(),
    initiatorCommitmentNonce: z.string().nullable(),
    publicKey: z.string().regex(/^04[0-9a-f]{128}$/),
    initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema.nullable(),
    responderEphemeralPublicKey: identityMoveEphemeralKeySchema.nullable(),
    nonce: z.string().nullable(),
    ciphertext: z.string().nullable(),
    receiptSignature: z.string().nullable(),
    expiresAt: z.string().datetime(),
});

export type IdentityMoveCreateRequest = z.infer<typeof identityMoveCreateRequestSchema>;
export type IdentityMoveJoinRequest = z.infer<typeof identityMoveJoinRequestSchema>;
export type IdentityMoveRevealRequest = z.infer<typeof identityMoveRevealRequestSchema>;
export type IdentityMoveSealRequest = z.infer<typeof identityMoveSealRequestSchema>;
export type IdentityMoveReceiptRequest = z.infer<typeof identityMoveReceiptRequestSchema>;

/**
 * The initiator's commitment input, `canonicalJson({ v, purpose, key, nonce })`,
 * which the caller hashes with SHA-256.
 */
export function buildMoveCommitmentInput(initiatorEphemeralPublicKey: string, nonce: string): string {
    return canonicalJson({
        v: 2,
        purpose: 'oxy-identity-move-initiator-commitment',
        initiatorEphemeralPublicKey: initiatorEphemeralPublicKey.toLowerCase(),
        nonce: nonce.toLowerCase(),
    });
}

/** The bytes both sides hash for the 6-digit code. */
export function buildMoveSasInput(input: { moveId: string; initiatorEphemeralPublicKey: string; responderEphemeralPublicKey: string; initiatorCommitment: string }): string {
    return canonicalJson({
        v: 'oxy-identity-transfer-sas-v2',
        moveId: input.moveId.toLowerCase(),
        initiator: input.initiatorEphemeralPublicKey.toLowerCase(),
        responder: input.responderEphemeralPublicKey.toLowerCase(),
        commitment: input.initiatorCommitment.toLowerCase(),
    });
}

/** The ciphertext digest input the receipt binds: `canonicalJson({ nonce, ciphertext })`. */
export function buildMoveCiphertextDigestInput(sealed: { nonce: string; ciphertext: string }): string {
    return canonicalJson({ nonce: sealed.nonce.toLowerCase(), ciphertext: sealed.ciphertext.toLowerCase() });
}

/** The payload a seal proof digests. */
export function buildMoveSealPayload(moveId: string, sealed: { nonce: string; ciphertext: string }): { moveId: string; nonce: string; ciphertext: string } {
    return { moveId: moveId.toLowerCase(), nonce: sealed.nonce.toLowerCase(), ciphertext: sealed.ciphertext.toLowerCase() };
}

/** The exact bytes a receipt signs. */
export function buildMoveReceiptMessage(input: {
    moveId: string;
    rootPublicKey: string;
    initiatorEphemeralPublicKey: string;
    responderEphemeralPublicKey: string;
    ciphertextDigest: string;
}): string {
    return canonicalJson({
        v: 2,
        domain: 'oxy-identity-move-receipt',
        moveId: input.moveId.toLowerCase(),
        rootPublicKey: input.rootPublicKey.toLowerCase(),
        initiator: input.initiatorEphemeralPublicKey.toLowerCase(),
        responder: input.responderEphemeralPublicKey.toLowerCase(),
        ciphertextDigest: input.ciphertextDigest.toLowerCase(),
    });
}
