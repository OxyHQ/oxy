/**
 * Key-rotation contract (b3 Feature 3 — key rotation + last-credential replacement).
 *
 * SINGLE SOURCE OF TRUTH for the atomic key-rotation flow:
 *  - `POST /auth/rotate/challenge` — mint a single-use `rotate_key` challenge.
 *  - `POST /auth/rotate/complete`  — prove control of the CURRENT (old) key and
 *    atomically swap in the new one.
 *
 * Rotation is an atomic REPLACE of the single identity key, never a
 * remove-then-add, so it never passes through a zero-auth-method state and is
 * independent of the unlink guards. Because the client proves possession of the
 * current key (from SecureStore OR a recovery-phrase re-derivation), the LAST
 * remaining credential can be replaced — the server only cares that the
 * signature validates against the current `publicKey`.
 *
 * The API validates its output against these schemas; `@oxy.so/core`'s identity
 * mixin validates its input against the same definitions, so producer and
 * consumer cannot drift.
 *
 * All shapes here are FLAT (no nested objects), so `z.infer<>` is safe under a
 * consumer's node10 `moduleResolution` — no interface-pinning needed.
 *
 * Platform-agnostic — zod only, ESM-safe (no `require()`).
 */
import { z } from 'zod';

/**
 * Response of `POST /auth/rotate/challenge`: the single-use `rotate_key`
 * challenge the client must sign with its CURRENT key, plus its expiry.
 */
export const rotateKeyChallengeResponseSchema = z.object({
    challenge: z.string(),
    /** ISO-8601 expiry timestamp. */
    expiresAt: z.string(),
});

export type RotateKeyChallengeResponse = z.infer<typeof rotateKeyChallengeResponseSchema>;

/**
 * Request body of `POST /auth/rotate/complete`.
 *
 * Two proofs are required:
 *  - `signature` — the CURRENT (old) key signs
 *    `JSON.stringify({ action: 'rotate_key', userId, oldPublicKey, newPublicKey,
 *    challenge, timestamp })` (proves control of the key being replaced).
 *  - `newKeyProof` — the NEW key signs
 *    `JSON.stringify({ action: 'rotate_key_new', userId, newPublicKey, challenge,
 *    timestamp })` (proof-of-possession of the key being rotated IN; prevents an
 *    attacker rotating their account to a re-encoding of someone else's key they
 *    do not control).
 *
 * The request carries ONLY `newPublicKey` — `oldPublicKey` and `userId` are
 * derived server-side from the authenticated user document (never
 * client-supplied), so a caller cannot prove control of key X while rotating
 * key Y.
 */
export const rotateKeyCompleteRequestSchema = z.object({
    newPublicKey: z.string().trim().min(1),
    challenge: z.string().trim().min(1),
    signature: z.string().trim().min(1),
    /** Proof-of-possession: the NEW key signs the rotate_key_new payload. */
    newKeyProof: z.string().trim().min(1),
    timestamp: z.number(),
    /**
     * When true, all OTHER active sessions for the account are revoked after a
     * successful rotation (the rotating device stays signed in). Use it when the
     * old key is presumed compromised.
     */
    signOutEverywhere: z.boolean().optional(),
});

export type RotateKeyCompleteRequest = z.infer<typeof rotateKeyCompleteRequestSchema>;

/** Response of `POST /auth/rotate/complete`: the account's new (rotated) public key. */
export const rotateKeyCompleteResponseSchema = z.object({
    success: z.boolean(),
    publicKey: z.string(),
    message: z.string(),
});

export type RotateKeyCompleteResponse = z.infer<typeof rotateKeyCompleteResponseSchema>;
