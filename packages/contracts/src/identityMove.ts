/**
 * Identity move contract — give a web root to Commons (add it, or keep it only in
 * Commons; ADR 0024 D6).
 *
 * PROTOCOL VERSION 2 (current). Version 1 let the relay see the initiator's
 * ephemeral key before the responder chose its own, so an active relay (the
 * server itself) could substitute keys on both sides and grind one of them until
 * the two 6-digit codes matched — about a million tries, seconds of work. Version
 * 2 closes that with a commitment:
 *
 *  1. `id.oxy.so` sends only `initiatorCommitment = H(initiatorKey, nonce)`.
 *  2. Commons joins with its key `R`, having read the commitment first.
 *  3. Only then does the web reveal its key (`POST /:moveId/reveal`); Commons
 *     checks it against the commitment it saw before choosing `R`.
 *  4. Both show a SAS over `(moveId, initiatorKey, R, commitment)`.
 *
 * A relay must fix the key it shows Commons before it learns `R`, and the key it
 * shows the web before the web reveals — so it can no longer steer both codes to
 * agree; it wins with probability 10⁻⁶ per attempt, visibly.
 *
 * The receipt (version 2) is the root's signature over the move, the root, both
 * keys and the digest of the ciphertext actually relayed, made by Commons with
 * the key read back from its keychain after storing it.
 *
 * Version 1 (below, for reference and for moves already under way):
 * Flow (the web — the OLD carrier — shows the QR; Commons — the NEW carrier —
 * scans it):
 *  1. `id.oxy.so` generates an ephemeral secp256k1 pair and calls
 *     `POST /identity/move { initiatorEphemeralPublicKey }` (bearer) →
 *     `{ moveId, expiresAt }`. The QR carries `moveId` only.
 *  2. Commons scans, generates its own ephemeral pair, and calls
 *     `POST /identity/move/:moveId/join { responderEphemeralPublicKey }` (no
 *     bearer — Commons has no identity yet).
 *  3. Both sides derive the same 6-digit SAS from the move id and BOTH ephemeral
 *     keys and show it. The person confirms on the web that they match. A relay
 *     that substituted either key produces two different codes.
 *  4. The web seals the BIP-39 entropy under
 *     `HKDF(ECDH(initiatorEph, responderEph), moveId, 'oxy-identity-move-v1')` and
 *     calls `POST /identity/move/:moveId/seal` (bearer + identity-key proof).
 *  5. Commons decrypts, imports the identity, and posts a RECEIPT: a signature by
 *     the identity key over `{ action:'identity_move_received', moveId, timestamp }`
 *     (`POST /identity/move/:moveId/receipt`). The server checks it against the
 *     account's key; the WEB verifies it again locally before destroying its copy,
 *     so not even the server can fake a completed move.
 *
 * The server holds two ephemeral public keys, an opaque ciphertext, and a
 * receipt. It never holds anything that decrypts the ciphertext.
 *
 * Platform-agnostic — zod only, ESM-safe (no `require()`).
 */
import { z } from 'zod';
import { canonicalJson } from './identityProof';

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

/** The protocol a web holder starts moves with. */
export const IDENTITY_MOVE_PROTOCOL_VERSION = 2 as const;
export const IDENTITY_MOVE_PROTOCOL_VERSIONS = [1, 2] as const;
export type IdentityMoveProtocolVersion = (typeof IDENTITY_MOVE_PROTOCOL_VERSIONS)[number];

const hex64 = (label: string) => z.string().trim().regex(/^[0-9a-f]{64}$/, `${label} must be 64 lowercase hex characters`);
export type IdentityMoveStatus = (typeof IDENTITY_MOVE_STATUSES)[number];

/** The QR payload Commons scans. Carries the move id only. */
export const IDENTITY_MOVE_QR_PREFIX = 'oxycommons://move?id=';

export const identityMoveCreateRequestSchema = z.union([
    z
        .object({
            protocolVersion: z.literal(2),
            /** `H(initiator ephemeral key, nonce)` — the key itself is revealed only after Commons joins. */
            initiatorCommitment: hex64('initiatorCommitment'),
        })
        .strict(),
    z.object({ initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema }).strict(),
]);

/** `POST /identity/move/:moveId/reveal` (version 2) — after Commons joined. */
export const identityMoveRevealRequestSchema = z
    .object({
        initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema,
        commitmentNonce: hex64('commitmentNonce'),
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

export const identityMoveSealRequestSchema = z.object({
    /** 24-byte XChaCha20-Poly1305 nonce, hex. */
    nonce: z.string().trim().regex(/^[0-9a-f]{48}$/, 'nonce must be 48 lowercase hex characters'),
    /** The 16–32-byte phrase entropy (12–24 words), tag appended, hex. */
    ciphertext: z
        .string()
        .trim()
        .regex(/^(?:[0-9a-f]{64}|[0-9a-f]{72}|[0-9a-f]{80}|[0-9a-f]{88}|[0-9a-f]{96})$/, 'ciphertext has an unsupported length'),
    /** Identity-key proof over `{ action:'identity_move_seal', moveId, timestamp }`. */
    signature: z.string().trim().min(1).max(512),
    timestamp: z.number().int().positive(),
});

export const identityMoveReceiptRequestSchema = z.union([
    z
        .object({
            v: z.literal(2),
            /** Root signature over `buildMoveReceiptMessageV2(...)`. */
            signature: z.string().trim().min(1).max(512),
        })
        .strict(),
    z
        .object({
            /** Version 1: identity-key signature over `{ action:'identity_move_received', moveId, timestamp }`. */
            signature: z.string().trim().min(1).max(512),
            timestamp: z.number().int().positive(),
        })
        .strict(),
]);

/** `GET /identity/move/:moveId` — everything either side needs, nothing that decrypts. */
export interface IdentityMoveState {
    moveId: string;
    status: IdentityMoveStatus;
    protocolVersion: IdentityMoveProtocolVersion;
    /** Version 2: the commitment Commons must read before joining. `null` in version 1. */
    initiatorCommitment: string | null;
    /** Version 2: the commitment's nonce, published with the key at reveal. */
    initiatorCommitmentNonce: string | null;
    /** The identity being moved (so Commons can check the key it will import). */
    publicKey: string;
    /** `null` in version 2 until the web reveals it (after Commons joined). */
    initiatorEphemeralPublicKey: string | null;
    responderEphemeralPublicKey: string | null;
    nonce: string | null;
    ciphertext: string | null;
    receiptSignature: string | null;
    receiptTimestamp: number | null;
    expiresAt: string;
}

export const identityMoveStateSchema: z.ZodType<IdentityMoveState> = z.object({
    moveId: identityMoveIdSchema,
    status: z.enum(IDENTITY_MOVE_STATUSES),
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    initiatorCommitment: z.string().nullable(),
    initiatorCommitmentNonce: z.string().nullable(),
    publicKey: z.string().regex(/^04[0-9a-f]{128}$/),
    initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema.nullable(),
    responderEphemeralPublicKey: identityMoveEphemeralKeySchema.nullable(),
    nonce: z.string().nullable(),
    ciphertext: z.string().nullable(),
    receiptSignature: z.string().nullable(),
    receiptTimestamp: z.number().int().nullable(),
    expiresAt: z.string().datetime(),
});

export type IdentityMoveCreateRequest = z.infer<typeof identityMoveCreateRequestSchema>;
export type IdentityMoveJoinRequest = z.infer<typeof identityMoveJoinRequestSchema>;
export type IdentityMoveSealRequest = z.infer<typeof identityMoveSealRequestSchema>;
export type IdentityMoveReceiptRequest = z.infer<typeof identityMoveReceiptRequestSchema>;
export type IdentityMoveRevealRequest = z.infer<typeof identityMoveRevealRequestSchema>;

/**
 * The initiator's commitment to its ephemeral key (version 2):
 * `canonicalJson({ v, purpose, initiatorEphemeralPublicKey, nonce })`, which the
 * caller hashes with SHA-256.
 */
export function buildMoveCommitmentInput(initiatorEphemeralPublicKey: string, nonce: string): string {
    return canonicalJson({
        v: 2,
        purpose: 'oxy-identity-move-initiator-commitment',
        initiatorEphemeralPublicKey: initiatorEphemeralPublicKey.toLowerCase(),
        nonce: nonce.toLowerCase(),
    });
}

/** The bytes both sides hash for the version-2 SAS. */
export function buildMoveSasInputV2(input: { moveId: string; initiatorEphemeralPublicKey: string; responderEphemeralPublicKey: string; initiatorCommitment: string }): string {
    return canonicalJson({
        v: 'oxy-identity-transfer-sas-v2',
        moveId: input.moveId.toLowerCase(),
        initiator: input.initiatorEphemeralPublicKey.toLowerCase(),
        responder: input.responderEphemeralPublicKey.toLowerCase(),
        commitment: input.initiatorCommitment.toLowerCase(),
    });
}

/** The digest the version-2 receipt binds: `canonicalJson({ nonce, ciphertext })`, hashed by the caller. */
export function buildMoveCiphertextDigestInput(sealed: { nonce: string; ciphertext: string }): string {
    return canonicalJson({ nonce: sealed.nonce.toLowerCase(), ciphertext: sealed.ciphertext.toLowerCase() });
}

/** The exact bytes a version-2 receipt signs. */
export function buildMoveReceiptMessageV2(input: {
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
