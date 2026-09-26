/**
 * Root proofs (ADR 0024 D7): mint a one-use challenge, then verify a proof and
 * burn its challenge in the same step.
 *
 * The bytes are `@oxy.so/contracts` `buildIdentityProofMessage` — the function
 * the client signs with — so the verifier never re-types a JSON template. Every
 * claim the server can derive (action, subject, actor, root, payload digest,
 * revision, audience) is derived HERE, never taken from the request; the request
 * contributes only the signature, the challenge and the expiry it was issued.
 */

import crypto from 'node:crypto';
import { and, eq, gt, gte, isNull } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_AUDIENCE,
  IDENTITY_PROOF_CHALLENGE_TTL_MS,
  buildIdentityProofMessage,
  canonicalJson,
  type IdentityProof,
  type IdentityProofAction,
  type IdentityProofChallengeResponse,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { identityProofChallenges } from '../db/schema/identityProofChallenges';
import { users } from '../db/schema/users';
import { ApiError } from '../utils/error';
import SignatureService from './signature.service';

/** Actions minted by `POST /identity/proof-challenge`. */
export const BEARER_PROOF_ACTIONS: ReadonlySet<IdentityProofAction> = new Set(['link_identity']);

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** SHA-256 hex of `canonicalJson(payload)` — byte-identical to `@oxy.so/core` `digestIdentityPayload`. */
export function digestIdentityPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

export function proofInvalid(message = 'Invalid or expired identity proof'): ApiError {
  return new ApiError(401, message, IDENTITY_ERROR_CODES.proofInvalid);
}

/** The linked root, lowercase, or `null`. */
export async function readLinkedRoot(db: DatabaseOrTransaction, userId: string): Promise<{ kind: string; publicKey: string | null } | null> {
  const [row] = await db
    .select({ kind: users.kind, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return { kind: row.kind, publicKey: row.publicKey?.trim().toLowerCase() || null };
}

/**
 * Mint a challenge for `action` on `userId`'s account, bound to the root linked
 * right now (or to "no root" for a first link).
 */
export async function mintIdentityProofChallenge(
  userId: string,
  action: IdentityProofAction,
  now: Date = new Date(),
): Promise<IdentityProofChallengeResponse> {
  if (!BEARER_PROOF_ACTIONS.has(action)) {
    throw new ApiError(400, 'This action has its own challenge', 'BAD_REQUEST');
  }
  const account = await readLinkedRoot(getDb(), userId);
  if (!account) throw new ApiError(401, 'User not found', 'UNAUTHORIZED');
  if (account.kind !== 'personal') {
    throw new ApiError(403, 'Only a personal account has a root', IDENTITY_ERROR_CODES.notPersonal);
  }
  const challenge = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + IDENTITY_PROOF_CHALLENGE_TTL_MS);
  await getDb().insert(identityProofChallenges).values({
    userId,
    action,
    challengeHash: sha256Hex(challenge),
    rootPublicKey: account.publicKey,
    expiresAt,
  });
  return { challenge, expiresAt: expiresAt.getTime(), audience: IDENTITY_PROOF_AUDIENCE };
}

export interface VerifyIdentityProofInput {
  userId: string;
  actor: string;
  action: IdentityProofAction;
  /** The root that must have signed. */
  rootPublicKey: string;
  /** The root the challenge was minted against: the linked root, or `null` for a first link. */
  mintedRoot: string | null;
  payloadDigest: string | null;
  expectedRevision: number | null;
  proof: IdentityProof;
}

/**
 * Verify `proof` for exactly these claims, then burn its challenge. Run it
 * inside the transaction that performs the operation: a rollback un-burns the
 * challenge together with the write it authorized.
 *
 * The signature is checked BEFORE the burn, so a forged proof cannot spend a
 * live challenge its owner is about to use.
 */
export async function verifyIdentityProof(db: DatabaseOrTransaction, input: VerifyIdentityProofInput, now: Date = new Date()): Promise<void> {
  const { proof } = input;
  if (proof.expiresAt <= now.getTime()) throw proofInvalid('The identity proof expired — please try again');

  let message: string;
  try {
    message = buildIdentityProofMessage({
      action: input.action,
      subject: input.userId,
      actor: input.actor,
      rootPublicKey: input.rootPublicKey,
      payloadDigest: input.payloadDigest,
      expectedRevision: input.expectedRevision,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: proof.challenge,
      expiresAt: proof.expiresAt,
    });
  } catch {
    throw proofInvalid();
  }
  if (!SignatureService.verifySignature(message, proof.signature, input.rootPublicKey)) {
    throw proofInvalid('Invalid identity signature');
  }

  const burned = await db
    .update(identityProofChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(identityProofChallenges.challengeHash, sha256Hex(proof.challenge)),
        eq(identityProofChallenges.userId, input.userId),
        eq(identityProofChallenges.action, input.action),
        isNull(identityProofChallenges.usedAt),
        gt(identityProofChallenges.expiresAt, now),
        // A proof may not claim to live longer than the challenge it spends.
        gte(identityProofChallenges.expiresAt, new Date(proof.expiresAt)),
        input.mintedRoot === null
          ? isNull(identityProofChallenges.rootPublicKey)
          : eq(identityProofChallenges.rootPublicKey, input.mintedRoot),
      ),
    )
    .returning({ id: identityProofChallenges.id });
  if (burned.length === 0) throw proofInvalid();
}
