/**
 * Identity proof contract — the ONE signed format for operations on a personal root.
 *
 * ADR 0024 D7. A proof is a signature by the root key over the canonical bytes
 * of {@link IdentityProofClaims}. Every field the verifier cares about is IN the
 * signed bytes, so a signature cannot be moved to another operation, account,
 * root, payload, revision or audience, and the one-use `challenge` means it
 * cannot be replayed either (a timestamp window is not replay protection).
 *
 * Both sides build the bytes with {@link buildIdentityProofMessage} and hash
 * payloads with {@link canonicalJson}; neither writes its own JSON template, so
 * the client and the verifier cannot drift apart.
 *
 * Platform-agnostic — zod only, ESM-safe (no `require()`), no hashing here (the
 * caller hashes `canonicalJson(payload)` with SHA-256 using its platform's
 * primitive and passes the hex digest in).
 */
import { z } from 'zod';

export const IDENTITY_PROOF_VERSION = 2 as const;
export const IDENTITY_PROOF_DOMAIN = 'oxy-identity-proof' as const;

/** The audience every API-verified identity proof names. */
export const IDENTITY_PROOF_AUDIENCE = 'oxy-api/identity' as const;

/** How long a proof challenge lives: one interactive ceremony. */
export const IDENTITY_PROOF_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Everything a root proof may authorize. A challenge is minted for exactly one
 * action and spent only by a proof for that action.
 */
export const IDENTITY_PROOF_ACTIONS = {
    /** A keyless account's FIRST root, stored with its web envelope. */
    establish: 'web_envelope_establish',
    /** Replace the web envelope (add or remove a wrap, re-seal). */
    put: 'web_envelope_put',
    /** Record that the recovery material is written down. */
    phraseConfirmed: 'web_envelope_phrase_confirmed',
    /** Record that the recovery material re-derived the root. */
    recoveryVerified: 'web_envelope_recovery_verified',
    /** Remove the web holder. */
    delete: 'web_envelope_delete',
    /** Link a keyless account's first root without a web envelope (`POST /auth/link`). */
    link: 'link_identity',
    /** Create a personal account together with its root (passkey sign-up). */
    enroll: 'enroll_identity',
    /** Prove the root to start signed-out recovery. */
    recoverStart: 'recover_account_start',
    /** Bind the new passkey and envelope when completing signed-out recovery. */
    recoverComplete: 'recover_account_complete',
    /** Seal the root for the Commons device that joined a move (payload: move id + sealed bytes). */
    moveSeal: 'identity_move_seal',
} as const;

export type IdentityProofAction = (typeof IDENTITY_PROOF_ACTIONS)[keyof typeof IDENTITY_PROOF_ACTIONS];

export const IDENTITY_PROOF_ACTION_VALUES = Object.values(IDENTITY_PROOF_ACTIONS) as [
    IdentityProofAction,
    ...IdentityProofAction[],
];

/**
 * The signed claims. `null` is written explicitly for a field that does not
 * apply, so "absent" can never be confused with a value.
 */
export interface IdentityProofClaims {
    action: IdentityProofAction;
    /** The account the operation changes (`users.id`), or a namespaced subject (`username:alice`) before one exists. */
    subject: string;
    /** Who performs it: the signed-in personal principal, or `credential:<id>` / `anonymous` where none exists. */
    actor: string;
    /** The root doing the signing, lowercase uncompressed hex. */
    rootPublicKey: string;
    /** SHA-256 hex of `canonicalJson(payload)`, or `null` when the operation has no payload. */
    payloadDigest: string | null;
    /** The envelope revision the operation expects to replace, or `null`. */
    expectedRevision: number | null;
    audience: string;
    /** The one-use server challenge. */
    challenge: string;
    /** Unix milliseconds after which the proof is refused. */
    expiresAt: number;
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const ROOT_KEY = /^04[0-9a-f]{128}$/;
const CHALLENGE = /^[0-9a-f]{64}$/;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * `undefined` members omitted, arrays in order. Numbers must be finite. This is
 * the ONLY serializer for anything digested into a proof.
 */
export function canonicalJson(value: unknown): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return JSON.stringify(value);
        case 'number':
            if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
            return JSON.stringify(value);
        case 'object': {
            if (Array.isArray(value)) {
                return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
            }
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record)
                .filter((key) => record[key] !== undefined)
                .sort();
            return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
        }
        default:
            throw new Error(`canonicalJson: unsupported ${typeof value}`);
    }
}

/**
 * The exact bytes a root signs. Throws on a malformed claim rather than signing
 * (or verifying) something ambiguous.
 */
export function buildIdentityProofMessage(claims: IdentityProofClaims): string {
    if (!IDENTITY_PROOF_ACTION_VALUES.includes(claims.action)) throw new Error('identity proof: unknown action');
    if (!claims.subject || !claims.actor) throw new Error('identity proof: subject and actor are required');
    if (!ROOT_KEY.test(claims.rootPublicKey)) throw new Error('identity proof: rootPublicKey must be canonical');
    if (claims.payloadDigest !== null && !HEX_DIGEST.test(claims.payloadDigest)) {
        throw new Error('identity proof: payloadDigest must be a lowercase SHA-256 hex digest');
    }
    if (claims.expectedRevision !== null && (!Number.isSafeInteger(claims.expectedRevision) || claims.expectedRevision < 0)) {
        throw new Error('identity proof: expectedRevision must be a non-negative integer');
    }
    if (!CHALLENGE.test(claims.challenge)) throw new Error('identity proof: challenge must be 64 lowercase hex characters');
    if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0) throw new Error('identity proof: expiresAt must be unix milliseconds');
    return canonicalJson({
        v: IDENTITY_PROOF_VERSION,
        domain: IDENTITY_PROOF_DOMAIN,
        action: claims.action,
        subject: claims.subject,
        actor: claims.actor,
        rootPublicKey: claims.rootPublicKey,
        payloadDigest: claims.payloadDigest,
        expectedRevision: claims.expectedRevision,
        audience: claims.audience,
        challenge: claims.challenge,
        expiresAt: claims.expiresAt,
    });
}

/** The proof as it travels: the signature plus the two claims the verifier cannot derive. */
export const identityProofSchema = z.object({
    v: z.literal(IDENTITY_PROOF_VERSION),
    challenge: z.string().trim().regex(CHALLENGE, 'challenge must be 64 lowercase hex characters'),
    expiresAt: z.number().int().positive(),
    signature: z.string().trim().min(1).max(512),
});
export type IdentityProof = z.infer<typeof identityProofSchema>;

/** `POST /identity/proof-challenge` */
export const identityProofChallengeRequestSchema = z.object({
    action: z.enum(IDENTITY_PROOF_ACTION_VALUES),
});
export type IdentityProofChallengeRequest = z.infer<typeof identityProofChallengeRequestSchema>;

export interface IdentityProofChallengeResponse {
    challenge: string;
    /** Unix milliseconds; a proof must not claim a later `expiresAt`. */
    expiresAt: number;
    audience: string;
}

export const identityProofChallengeResponseSchema: z.ZodType<IdentityProofChallengeResponse> = z.object({
    challenge: z.string().regex(CHALLENGE),
    expiresAt: z.number().int().positive(),
    audience: z.string().min(1),
});

/**
 * Stable error codes the root routes answer with (`error.code` in the API error
 * body). Clients map these through their localization, never the English message.
 */
export const IDENTITY_ERROR_CODES = {
    proofInvalid: 'IDENTITY_PROOF_INVALID',
    revisionConflict: 'IDENTITY_ENVELOPE_REVISION_CONFLICT',
    rootAlreadyLinked: 'IDENTITY_ROOT_ALREADY_LINKED',
    rootLinkedElsewhere: 'IDENTITY_ROOT_LINKED_ELSEWHERE',
    noRoot: 'IDENTITY_NO_ROOT',
    freshFactorRequired: 'IDENTITY_FRESH_FACTOR_REQUIRED',
    lastWebHolder: 'IDENTITY_LAST_WEB_HOLDER',
    enrollmentRequired: 'IDENTITY_ENROLLMENT_REQUIRED',
    enrollmentInvalid: 'IDENTITY_ENROLLMENT_INVALID',
    notPersonal: 'IDENTITY_NOT_PERSONAL_ACCOUNT',
    recoveryFailed: 'IDENTITY_RECOVERY_FAILED',
} as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];

/**
 * `GET /identity/root-status` — non-sensitive readiness metadata any first-party
 * surface (Accounts, the account menu) may read with a bearer to show a reminder,
 * without the ciphertext and without opening anything (ADR 0024 D5).
 */
export interface IdentityRootStatus {
    /** Whether the account has a root at all. */
    rootLinked: boolean;
    /** Passkeys whose wraps can open the web holder, and how many have proven it. `null`: no web holder. */
    webHolder: { passkeys: number; verifiedPasskeys: number } | null;
    /** Whether the root has recovery words (a raw-key root does not). `null` when unknown (no web holder). */
    hasPhrase: boolean | null;
    phraseConfirmedAt: string | null;
    recoveryVerifiedAt: string | null;
}

export const identityRootStatusSchema: z.ZodType<IdentityRootStatus> = z.object({
    rootLinked: z.boolean(),
    webHolder: z.object({ passkeys: z.number().int().nonnegative(), verifiedPasskeys: z.number().int().nonnegative() }).nullable(),
    hasPhrase: z.boolean().nullable(),
    phraseConfirmedAt: z.string().datetime().nullable(),
    recoveryVerifiedAt: z.string().datetime().nullable(),
});
