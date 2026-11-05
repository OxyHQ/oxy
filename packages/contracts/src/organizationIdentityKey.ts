import { integerCheck } from './numberChecks';
import { isoDateTime, utf16MaxLength, utf16MinLength } from './stringChecks';
/**
 * An organization's identity key (ADR 0061): its DID `#key-1`, created in
 * Commons by an owner or admin, and the key Peable derives the organization's
 * FairCoin receive addresses from.
 *
 * - `GET  /accounts/:id/identity-key`            the current key and its history
 * - `POST /accounts/:id/identity-key/challenge`  a one-use challenge for one change
 * - `POST /accounts/:id/identity-key`            apply it with the signatures
 *
 * No private key or phrase crosses this contract.
 */
import { z } from 'zod';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  ORGANIZATION_KEY_OPERATIONS,
  ORGANIZATION_KEY_PROOF_ACTION_VALUES,
} from './client/organizationIdentityKey';
import { CHALLENGE, HEX_DIGEST, IDENTITY_PROOF_AUDIENCE } from './client/identityProof';
export {
  ORGANIZATION_KEY_OPERATIONS,
  ORGANIZATION_KEY_PROOF_ACTIONS,
  ORGANIZATION_KEY_PROOF_ACTION_VALUES,
  ORGANIZATION_KEY_ERROR_CODES,
  organizationKeyPayload,
  organizationKeyProofClaims,
} from './client/organizationIdentityKey';
export type {
  OrganizationKeyOperation,
  OrganizationKeyProofAction,
  OrganizationKeyErrorCode,
} from './client/organizationIdentityKey';

const publicKey = z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(130));
const signature = z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(512));

/** `POST /accounts/:id/identity-key/challenge` */
export const organizationKeyChallengeRequestSchema = z
  .object({ operation: z.enum(ORGANIZATION_KEY_OPERATIONS), publicKey })
  .strict();
export type OrganizationKeyChallengeRequest = z.infer<typeof organizationKeyChallengeRequestSchema>;

/**
 * The challenge and every claim the signers sign
 * (`organizationKeyProofClaims(challenge, signerPublicKey)`).
 */
export const organizationKeyChallengeSchema = z
  .object({
    operation: z.enum(ORGANIZATION_KEY_OPERATIONS),
    action: z.enum(ORGANIZATION_KEY_PROOF_ACTION_VALUES),
    /** The organization (the proof's `subject`). */
    accountId: z.string().check(utf16MinLength(1)),
    /** The signed-in person performing it (the proof's `actor`). */
    actorId: z.string().check(utf16MinLength(1)),
    /** The actor's own root, which signs `actorSignature`. */
    actorPublicKey: z.string().check(utf16MinLength(1)),
    /** The new key, canonical (lowercase, uncompressed). */
    publicKey: z.string().check(utf16MinLength(1)),
    /** The key it replaces, or `null` for `create`. */
    previousPublicKey: z.string().check(utf16MinLength(1)).nullable(),
    payloadDigest: z.string().regex(HEX_DIGEST),
    audience: z.literal(IDENTITY_PROOF_AUDIENCE),
    challenge: z.string().regex(CHALLENGE),
    /** Unix milliseconds. */
    expiresAt: z.number().check(integerCheck()).positive(),
  })
  .strict();
export type OrganizationKeyChallenge = z.infer<typeof organizationKeyChallengeSchema>;

/** `POST /accounts/:id/identity-key` */
export const organizationKeyApplyRequestSchema = z
  .object({
    operation: z.enum(ORGANIZATION_KEY_OPERATIONS),
    publicKey,
    challenge: z.string().regex(CHALLENGE),
    expiresAt: z.number().check(integerCheck()).positive(),
    /** By the actor's own root. */
    actorSignature: signature,
    /** By the new key: proof of possession. */
    keySignature: signature,
    /** By the current key, when replacing and the device holds it. */
    previousKeySignature: signature.optional(),
  })
  .strict();
export type OrganizationKeyApplyRequest = z.infer<typeof organizationKeyApplyRequestSchema>;

/**
 * `GET /accounts/:id/identity-key`, and the answer of a change: the current
 * key (`null` for an organization without one) and every key it has had,
 * oldest first. A retired key is never used again by any account.
 */
export const organizationIdentityKeyStateSchema = z
  .object({
    accountId: z.string().check(utf16MinLength(1)),
    publicKey: z.string().check(utf16MinLength(1)).nullable(),
    keys: z.array(
      z
        .object({
          publicKey: z.string().check(utf16MinLength(1)),
          method: z.enum(ORGANIZATION_KEY_OPERATIONS),
          linkedByUserId: z.string().nullable(),
          /** Whether a `replace` was also signed by the key it replaced. */
          previousKeyProven: z.boolean(),
          linkedAt: z.string().check(isoDateTime()),
          retiredAt: z.string().check(isoDateTime()).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type OrganizationIdentityKeyState = z.infer<typeof organizationIdentityKeyStateSchema>;
