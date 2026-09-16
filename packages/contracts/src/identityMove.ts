/**
 * Identity move contract — take a web identity INTO Commons (a MOVE, not a copy).
 *
 * Design: `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md` §5.
 *
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

export const identityMoveCreateRequestSchema = z.object({
    initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema,
});

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
    /** The 16-byte entropy, tag appended (32 bytes), hex. */
    ciphertext: z.string().trim().regex(/^[0-9a-f]{64}$/, 'ciphertext must be 64 lowercase hex characters'),
    /** Identity-key proof over `{ action:'identity_move_seal', moveId, timestamp }`. */
    signature: z.string().trim().min(1).max(512),
    timestamp: z.number().int().positive(),
});

export const identityMoveReceiptRequestSchema = z.object({
    /** Identity-key signature over `{ action:'identity_move_received', moveId, timestamp }`. */
    signature: z.string().trim().min(1).max(512),
    timestamp: z.number().int().positive(),
});

/** `GET /identity/move/:moveId` — everything either side needs, nothing that decrypts. */
export interface IdentityMoveState {
    moveId: string;
    status: IdentityMoveStatus;
    /** The identity being moved (so Commons can check the key it will import). */
    publicKey: string;
    initiatorEphemeralPublicKey: string;
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
    publicKey: z.string().regex(/^04[0-9a-f]{128}$/),
    initiatorEphemeralPublicKey: identityMoveEphemeralKeySchema,
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
