/**
 * Web identity carrier contract — "one identity, two carriers".
 *
 * SINGLE SOURCE OF TRUTH for the sealed envelope that lets a browser carry an
 * account's self-custody identity without Oxy ever holding it
 * (`docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`).
 *
 * The identity is a BIP-39 mnemonic whose seed's first 32 bytes are the
 * secp256k1 key — exactly the Commons derivation — so a web identity and a
 * Commons identity are the same thing. On the web it travels as:
 *
 *   entropy (16 bytes) ── XChaCha20-Poly1305 under a random DEK ──▶ sealedEntropy
 *   DEK ── XChaCha20-Poly1305 under KEK_i ──▶ wraps[i]
 *   KEK_i = HKDF(PRF output of passkey i)
 *
 * The server stores the envelope and can open NONE of it: the PRF output never
 * leaves the user's authenticator, and the mnemonic is never uploaded. The AEAD
 * associated data binds every ciphertext to the identity's public key (and each
 * wrap to its credential), so a re-labelled or transplanted envelope fails to
 * open instead of decrypting into the wrong identity.
 *
 * Every hex field is lowercase-or-uppercase hex. Platform-agnostic — zod only,
 * ESM-safe (no `require()`).
 */
import { z } from 'zod';

/** The only envelope version. A scheme change is a new literal, never a mutation. */
export const WEB_IDENTITY_ENVELOPE_VERSION = 1 as const;

const hex = (bytes: number, label: string) =>
    z
        .string()
        .trim()
        .regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `${label} must be ${bytes * 2} hex characters`);

/**
 * The identity's secp256k1 public key in Oxy's canonical form: uncompressed SEC1
 * (`04` + 64 bytes), lowercase hex — what `KeyManager.derivePublicKey` produces
 * and `users.public_key` stores.
 */
export const webIdentityPublicKeySchema = z
    .string()
    .trim()
    .regex(/^04[0-9a-f]{128}$/, 'publicKey must be an uncompressed, lowercase secp256k1 key (130 hex characters)');

/** A WebAuthn credential id, base64url as the browser reports it. */
export const webauthnCredentialIdSchema = z
    .string()
    .trim()
    .min(16)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/, 'credentialId must be base64url');

/** One passkey's wrap of the envelope's data key. */
export const webIdentityWrapSchema = z.object({
    credentialId: webauthnCredentialIdSchema,
    /** 24-byte XChaCha20-Poly1305 nonce. */
    nonce: hex(24, 'nonce'),
    /** The 32-byte DEK sealed under this passkey's KEK, with the 16-byte tag appended (48 bytes). */
    wrappedKey: hex(48, 'wrappedKey'),
    createdAt: z.string().datetime(),
});

/**
 * The sealed identity as it is stored (server copy and local copy alike).
 *
 * `wraps` holds one entry per passkey able to open it; at least one, and a
 * bounded number so an envelope cannot grow without limit.
 */
export const webIdentityEnvelopeSchema = z.object({
    version: z.literal(WEB_IDENTITY_ENVELOPE_VERSION),
    algorithm: z.literal('xchacha20poly1305'),
    publicKey: webIdentityPublicKeySchema,
    /** 24-byte nonce of the entropy seal. */
    entropyNonce: hex(24, 'entropyNonce'),
    /** The 16-byte BIP-39 entropy sealed under the DEK, tag appended (32 bytes). */
    sealedEntropy: hex(32, 'sealedEntropy'),
    wraps: z.array(webIdentityWrapSchema).min(1).max(10),
});

/**
 * `PUT /identity/web-envelope` — store or replace the caller's envelope.
 *
 * Refused unless `envelope.publicKey` is the identity key already linked to the
 * account: an envelope can only ever carry the account's own identity.
 */
export const webIdentityEnvelopeUploadSchema = z.object({
    envelope: webIdentityEnvelopeSchema,
});

/** `GET /identity/web-envelope` — the caller's envelope and its recovery-phrase state. */
export const webIdentityEnvelopeResponseSchema = z.object({
    envelope: webIdentityEnvelopeSchema.nullable(),
    /**
     * When the owner confirmed they wrote the recovery phrase down, or `null`.
     * Until then the identity must not be unlocked on a second device, nor used
     * for any operation that needs the key (design decision D2).
     */
    phraseConfirmedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
});

/**
 * `POST /identity/web-envelope/phrase-confirmed` and
 * `DELETE /identity/web-envelope` both prove control of the identity key, not
 * just a bearer: a stolen session must not be able to mark a phrase as saved or
 * destroy the web copy of someone's identity.
 *
 * The signed message is `JSON.stringify({ action, userId, timestamp })` — the
 * same scheme as `link_identity`.
 */
export const webIdentityEnvelopeProofSchema = z.object({
    signature: z.string().trim().min(1).max(512),
    timestamp: z.number().int().positive(),
});

/** `PUT /identity/web-envelope` body: the envelope plus a `web_envelope_put` identity-key proof. */
export const webIdentityEnvelopePutSchema = webIdentityEnvelopeUploadSchema.extend(webIdentityEnvelopeProofSchema.shape);

/**
 * `POST /identity/web-envelope/establish` body — create an account's FIRST
 * identity on the web: link the key and store its envelope in ONE transaction.
 *
 * Linking and storing as two calls would let a failure (or a closed tab) in
 * between leave the account bound to a key that nothing carries — an identity
 * lost at birth. `link` is a `link_identity` proof and the outer proof a
 * `web_envelope_put` proof, both signed by the envelope's own key.
 */
export const webIdentityEnvelopeEstablishSchema = webIdentityEnvelopePutSchema.extend({
    link: webIdentityEnvelopeProofSchema,
});

export type WebIdentityWrap = z.infer<typeof webIdentityWrapSchema>;
export type WebIdentityEnvelope = z.infer<typeof webIdentityEnvelopeSchema>;
export type WebIdentityEnvelopeUpload = z.infer<typeof webIdentityEnvelopeUploadSchema>;
export type WebIdentityEnvelopeResponse = z.infer<typeof webIdentityEnvelopeResponseSchema>;
export type WebIdentityEnvelopeProof = z.infer<typeof webIdentityEnvelopeProofSchema>;
export type WebIdentityEnvelopePut = z.infer<typeof webIdentityEnvelopePutSchema>;
export type WebIdentityEnvelopeEstablish = z.infer<typeof webIdentityEnvelopeEstablishSchema>;
