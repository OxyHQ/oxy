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
import { z } from '@oxy.so/zod3';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  IDENTITY_PROOF_VERSION,
  IDENTITY_PROOF_ACTION_VALUES,
  canonicalJson,
  buildIdentityProofMessage,
  CHALLENGE,
  type IdentityProofClaims,
} from './client/identityProof';
export {
  IDENTITY_PROOF_VERSION,
  IDENTITY_PROOF_DOMAIN,
  IDENTITY_PROOF_AUDIENCE,
  IDENTITY_PROOF_CHALLENGE_TTL_MS,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_ACTION_VALUES,
  canonicalJson,
  buildIdentityProofMessage,
  IDENTITY_ERROR_CODES,
} from './client/identityProof';
export type {
  IdentityProofAction,
  IdentityProofClaims,
  IdentityErrorCode,
} from './client/identityProof';

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

export const identityProofChallengeResponseSchema: z.ZodType<IdentityProofChallengeResponse> =
  z.object({
    challenge: z.string().regex(CHALLENGE),
    expiresAt: z.number().int().positive(),
    audience: z.string().min(1),
  });

/**
 * `GET /identity/root-status` — how the signed-in account is kept (ADR 0029 D3),
 * for Accounts and the account menu to recommend linking Commons. Read with a
 * bearer from any first-party origin.
 */
export interface IdentityRootStatus {
  /** Whether Commons' root is linked: the account is self-custodied. */
  rootLinked: boolean;
  /** The email of an account without a key; `null` once Commons is linked. */
  recoveryEmail: string | null;
}

export const identityRootStatusSchema: z.ZodType<IdentityRootStatus> = z.object({
  rootLinked: z.boolean(),
  recoveryEmail: z.string().nullable(),
});
