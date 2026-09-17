/**
 * Web identity holder contract — the sealed envelope that lets a browser hold an
 * account's self-custody root without Oxy ever being able to use it (ADR 0024).
 *
 * A root is a BIP-39 phrase (12–24 words) whose seed's first 32 bytes are the
 * secp256k1 key — exactly the Commons derivation — or, for a few imported
 * identities, a raw private key that never had a phrase. On the web it travels as:
 *
 *   secret ── XChaCha20-Poly1305 under a random DEK ──▶ sealedSecret
 *   DEK    ── XChaCha20-Poly1305 under KEK_i ──▶ wraps[i]
 *   KEK_i = HKDF(PRF output of passkey i)
 *
 * The server stores the envelope and can open NONE of it: the PRF output never
 * leaves the user's authenticator, and the secret is never uploaded. The AEAD
 * associated data binds the secret to the root's public key and kind, and each
 * wrap to its credential and RP ID, so a re-labelled or transplanted envelope
 * fails to open instead of decrypting into the wrong identity.
 *
 * Platform-agnostic — zod only, ESM-safe (no `require()`).
 */
import { z } from 'zod';
import { identityProofSchema } from './identityProof';

/** The envelope scheme. A scheme change is a new literal, never a mutation. */
export const WEB_IDENTITY_ENVELOPE_VERSION = 2 as const;

/**
 * What an envelope seals. A raw-key identity stays a raw-key identity:
 * nothing ever derives or displays a phrase for it.
 */
export const WEB_IDENTITY_SECRET_KINDS = ['mnemonic-entropy', 'raw-private-key'] as const;
export type WebIdentitySecretKind = (typeof WEB_IDENTITY_SECRET_KINDS)[number];

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

/** A WebAuthn RP ID: a bare registrable host name, lowercase. */
export const webauthnRpIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^(localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/, 'rpId must be a lowercase host name');

/** One passkey's wrap of the envelope's data key. */
export const webIdentityWrapSchema = z.object({
    credentialId: webauthnCredentialIdSchema,
    /** 24-byte XChaCha20-Poly1305 nonce. */
    nonce: hex(24, 'nonce'),
    /** The 32-byte DEK sealed under this passkey's KEK, with the 16-byte tag appended (48 bytes). */
    wrappedKey: hex(48, 'wrappedKey'),
    createdAt: z.string().datetime(),
    /** The RP ID the passkey was created under, asserted explicitly by every later ceremony (ADR 0024 D2). */
    rpId: webauthnRpIdSchema,
    /**
     * When this passkey's PRF output was shown to open the envelope. A wrap is a
     * root HOLDER only once this is set; a login passkey never is by default.
     */
    verifiedAt: z.string().datetime().optional(),
});

/**
 * The sealed identity as it is stored (server copy and local copy alike).
 *
 * `wraps` holds one entry per passkey able to open it; at least one, and a
 * bounded number so an envelope cannot grow without limit.
 */
export const webIdentityEnvelopeSchema = z
    .object({
        version: z.literal(WEB_IDENTITY_ENVELOPE_VERSION),
        algorithm: z.literal('xchacha20poly1305'),
        publicKey: webIdentityPublicKeySchema,
        secretKind: z.enum(WEB_IDENTITY_SECRET_KINDS),
        /** 24-byte nonce of the secret seal. */
        secretNonce: hex(24, 'secretNonce'),
        /**
         * The sealed secret, tag appended: 16/20/24/28/32 bytes of BIP-39 entropy
         * (12–24 words) or a 32-byte private key, plus 16.
         */
        sealedSecret: z
            .string()
            .trim()
            .regex(/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{72}|[0-9a-fA-F]{80}|[0-9a-fA-F]{88}|[0-9a-fA-F]{96})$/, 'sealedSecret has an unsupported length'),
        wraps: z.array(webIdentityWrapSchema).min(1).max(10),
    })
    .refine((envelope) => envelope.secretKind === 'mnemonic-entropy' || envelope.sealedSecret.length === 96, {
        message: 'a raw private key seals to 48 bytes',
        path: ['sealedSecret'],
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

/** A root holder as the status read reports it — metadata only, nothing that opens anything. */
export const webIdentityHolderSchema = z.object({
    credentialId: webauthnCredentialIdSchema,
    rpId: webauthnRpIdSchema,
    verifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
});

/**
 * `GET /identity/web-envelope` — the caller's envelope and the readiness facts
 * ADR 0024 D5 keeps separate. A client decides what to show from these fields
 * WITHOUT decrypting anything.
 */
export const webIdentityEnvelopeResponseSchema = z.object({
    envelope: webIdentityEnvelopeSchema.nullable(),
    /** The revision a write must name as `expectedRevision`; `0` when there is no envelope. */
    revision: z.number().int().nonnegative(),
    /** Whether the account has a linked root at all (it may live only in Commons). */
    rootLinked: z.boolean(),
    /** The web wraps, as metadata. */
    holders: z.array(webIdentityHolderSchema),
    /** When the owner confirmed the recovery material is written down, or `null`. */
    phraseConfirmedAt: z.string().datetime().nullable(),
    /** When the recovery material was shown to re-derive this root, or `null`. */
    recoveryVerifiedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
});

/** A root proof, plus the envelope revision the write expects to replace. */
export const webIdentityEnvelopeProofFieldsSchema = z.object({
    proof: identityProofSchema,
    expectedRevision: z.number().int().nonnegative(),
});

/**
 * `POST /identity/web-envelope/phrase-confirmed`, `/recovery-verified` and
 * `DELETE /identity/web-envelope` prove control of the root, not just a bearer.
 */
export const webIdentityEnvelopeActionSchema = webIdentityEnvelopeProofFieldsSchema.strict();

/** `PUT /identity/web-envelope` body. */
export const webIdentityEnvelopePutSchema = webIdentityEnvelopeUploadSchema.extend(webIdentityEnvelopeProofFieldsSchema.shape).strict();

/**
 * A WebAuthn assertion by one of the account's EXISTING passkeys whose
 * `clientDataJSON.challenge` is the proof challenge — the fresh use of the
 * existing factor a keyless account needs before its first root is linked.
 */
export const webauthnAssertionResponseSchema = z
    .object({
        id: webauthnCredentialIdSchema,
        rawId: z.string().min(1).max(2048),
        type: z.literal('public-key'),
        response: z
            .object({
                clientDataJSON: z.string().min(1).max(8192),
                authenticatorData: z.string().min(1).max(8192),
                signature: z.string().min(1).max(2048),
                userHandle: z.string().max(2048).optional(),
            })
            .passthrough(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
        authenticatorAttachment: z.string().optional(),
    })
    .passthrough();

/**
 * `POST /identity/web-envelope/establish` body — an account's FIRST root, linked
 * and stored with its envelope in ONE transaction: one root proof
 * (`web_envelope_establish`, digest of the envelope) plus a fresh `assertion` by
 * an existing passkey over the same challenge.
 */
export const webIdentityEnvelopeEstablishSchema = webIdentityEnvelopeUploadSchema
    .extend({ proof: identityProofSchema, assertion: webauthnAssertionResponseSchema })
    .strict();

export type WebIdentityWrap = z.infer<typeof webIdentityWrapSchema>;
export type WebIdentityEnvelope = z.infer<typeof webIdentityEnvelopeSchema>;
export type WebIdentityHolder = z.infer<typeof webIdentityHolderSchema>;
export type WebIdentityEnvelopeAction = z.infer<typeof webIdentityEnvelopeActionSchema>;
export type WebauthnAssertionResponse = z.infer<typeof webauthnAssertionResponseSchema>;
export type WebIdentityEnvelopeUpload = z.infer<typeof webIdentityEnvelopeUploadSchema>;
export type WebIdentityEnvelopeResponse = z.infer<typeof webIdentityEnvelopeResponseSchema>;
export type WebIdentityEnvelopePut = z.infer<typeof webIdentityEnvelopePutSchema>;
export type WebIdentityEnvelopeEstablish = z.infer<typeof webIdentityEnvelopeEstablishSchema>;
