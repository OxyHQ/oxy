/**
 * Signed-out recovery contract (ADR 0024 D5) — get an EXISTING account back from
 * its root alone, with no passkey, session or email.
 *
 *  1. `POST /identity/recovery/challenge` → a one-use challenge. It says nothing
 *     about any account.
 *  2. The holder derives the root locally from recovery material (12/24 words or a
 *     raw key) and signs `recover_account_start` over that challenge:
 *     `POST /identity/recovery/start { publicKey, proof }`. Only a valid proof
 *     learns which account the root belongs to; the response carries passkey
 *     registration options for THAT account and a short-lived ticket.
 *  3. The holder creates the passkey, seals the root under it (PRF), and signs
 *     `recover_account_complete` over the registration challenge and the envelope
 *     digest: `POST /identity/recovery/complete`. The passkey, the envelope and a
 *     session are created in one transaction.
 *
 * The recovery material and the root never leave the holder. Platform-agnostic —
 * zod only, ESM-safe.
 */
import { z } from 'zod';
import { identityProofSchema } from './identityProof';
import { webIdentityEnvelopeSchema, webIdentityPublicKeySchema } from './webIdentityCarrier';

/** A recovery attempt lives this long between steps. */
export const IDENTITY_RECOVERY_TTL_MS = 5 * 60 * 1000;

export interface IdentityRecoveryChallengeResponse {
    /** 32 bytes, lowercase hex. */
    challenge: string;
    /** Unix milliseconds. */
    expiresAt: number;
}

export const identityRecoveryChallengeResponseSchema: z.ZodType<IdentityRecoveryChallengeResponse> = z.object({
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.number().int().positive(),
});

export const identityRecoveryStartRequestSchema = z
    .object({
        publicKey: webIdentityPublicKeySchema,
        /** `recover_account_start`, subject `root:<publicKey>`, actor `anonymous`. */
        proof: identityProofSchema,
    })
    .strict();
export type IdentityRecoveryStartRequest = z.infer<typeof identityRecoveryStartRequestSchema>;

export interface IdentityRecoveryStartResponse {
    /** Opaque, one-use; presented once to `complete`. */
    ticket: string;
    accountId: string;
    username: string | null;
    /** `PublicKeyCredentialCreationOptionsJSON` for the account's new passkey. */
    registrationOptions: Record<string, unknown>;
    /** Unix milliseconds. */
    expiresAt: number;
}

export const identityRecoveryCompleteRequestSchema = z
    .object({
        ticket: z.string().regex(/^[0-9a-f]{64}$/),
        /** The browser `RegistrationResponseJSON`, verified by the API's WebAuthn library. */
        response: z.record(z.string(), z.unknown()),
        /** The root sealed under the new passkey — exactly one wrap, for that credential. */
        envelope: webIdentityEnvelopeSchema,
        /** `recover_account_complete`, subject = account id, actor `credential:<id>`, challenge = registration challenge (hex). */
        proof: identityProofSchema,
        deviceName: z.string().trim().max(100).optional(),
        deviceFingerprint: z.string().trim().max(512).optional(),
    })
    .strict();
export type IdentityRecoveryCompleteRequest = z.infer<typeof identityRecoveryCompleteRequestSchema>;
