/**
 * An organization's identity key (ADR 0061), without Zod. Schemas:
 * `../organizationIdentityKey.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 *
 * An organization's key is its DID `#key-1`: the key Peable derives the
 * organization's FairCoin receive addresses from. It is created in Commons by an
 * owner or admin and never signs anybody in. A change is ONE identity proof
 * ceremony (ADR 0024 D7): the server's challenge, then the same claims signed by
 * the actor's own root, by the new key and (to replace) by the current key when
 * the device holds it. The claims differ only in `rootPublicKey`, so no
 * signature can stand in for another.
 */

import type {
  OrganizationIdentityKeyState,
  OrganizationKeyApplyRequest,
  OrganizationKeyChallenge,
  OrganizationKeyChallengeRequest,
} from '../organizationIdentityKey';
import {
  array,
  boolean,
  datetime,
  exact,
  int,
  literal,
  maxLength,
  minLength,
  nullable,
  number,
  oneOf,
  optional,
  pattern,
  positive,
  strictObject,
  string,
  trim,
} from './check';
import {
  CHALLENGE,
  HEX_DIGEST,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_AUDIENCE,
  type IdentityProofClaims,
} from './identityProof';

/** `create`: an organization without a key gets one. `replace`: a new key takes the current one's place. */
export const ORGANIZATION_KEY_OPERATIONS = ['create', 'replace'] as const;

export type OrganizationKeyOperation = (typeof ORGANIZATION_KEY_OPERATIONS)[number];

/** The identity-proof action each operation is signed under. */
export const ORGANIZATION_KEY_PROOF_ACTIONS = {
  create: IDENTITY_PROOF_ACTIONS.organizationKeyCreate,
  replace: IDENTITY_PROOF_ACTIONS.organizationKeyReplace,
} as const satisfies Record<OrganizationKeyOperation, string>;

export const ORGANIZATION_KEY_PROOF_ACTION_VALUES = [
  ORGANIZATION_KEY_PROOF_ACTIONS.create,
  ORGANIZATION_KEY_PROOF_ACTIONS.replace,
] as const;

export type OrganizationKeyProofAction = (typeof ORGANIZATION_KEY_PROOF_ACTION_VALUES)[number];

/**
 * Stable error codes of the organization-key routes (`error.code`). The proof,
 * key-in-use and already-linked refusals use `IDENTITY_ERROR_CODES`.
 */
export const ORGANIZATION_KEY_ERROR_CODES = {
  /** The caller is not an owner or admin of a claimed, active organization. */
  forbidden: 'ORGANIZATION_KEY_FORBIDDEN',
  /** The signing person has no root of their own (only a Commons account can do this). */
  actorRootRequired: 'ORGANIZATION_KEY_ACTOR_ROOT_REQUIRED',
  /** `replace` on an organization without a key. */
  noKey: 'ORGANIZATION_KEY_MISSING',
  /** The key was already used, by this or another account, and is never reused. */
  keyUsed: 'ORGANIZATION_KEY_USED',
} as const;

export type OrganizationKeyErrorCode =
  (typeof ORGANIZATION_KEY_ERROR_CODES)[keyof typeof ORGANIZATION_KEY_ERROR_CODES];

/**
 * The payload whose digest every signature of one operation binds. Both sides
 * build it here, so the client and the verifier digest the same object.
 */
export function organizationKeyPayload(input: {
  operation: OrganizationKeyOperation;
  accountId: string;
  publicKey: string;
  previousPublicKey: string | null;
}): {
  operation: OrganizationKeyOperation;
  accountId: string;
  publicKey: string;
  previousPublicKey: string | null;
} {
  return {
    operation: input.operation,
    accountId: input.accountId,
    publicKey: input.publicKey,
    previousPublicKey: input.previousPublicKey,
  };
}

/** The claims one signer (`rootPublicKey`) signs for `challenge`. */
export function organizationKeyProofClaims(
  challenge: OrganizationKeyChallenge,
  rootPublicKey: string,
): IdentityProofClaims {
  return {
    action: challenge.action,
    subject: challenge.accountId,
    actor: challenge.actorId,
    rootPublicKey,
    payloadDigest: challenge.payloadDigest,
    expectedRevision: null,
    audience: challenge.audience,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
  };
}

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

const publicKey = string(trim, minLength(1), maxLength(130));
const signature = string(trim, minLength(1), maxLength(512));
const challengeHex = string(pattern(CHALLENGE));
const timestamp = number(int, positive);

export const organizationKeyChallengeRequestCheck = exact<OrganizationKeyChallengeRequest>()(
  strictObject({ operation: oneOf(ORGANIZATION_KEY_OPERATIONS), publicKey }),
);

export const organizationKeyChallengeCheck = exact<OrganizationKeyChallenge>()(
  strictObject({
    operation: oneOf(ORGANIZATION_KEY_OPERATIONS),
    action: oneOf(ORGANIZATION_KEY_PROOF_ACTION_VALUES),
    accountId: string(minLength(1)),
    actorId: string(minLength(1)),
    actorPublicKey: string(minLength(1)),
    publicKey: string(minLength(1)),
    previousPublicKey: nullable(string(minLength(1))),
    payloadDigest: string(pattern(HEX_DIGEST)),
    audience: literal(IDENTITY_PROOF_AUDIENCE),
    challenge: challengeHex,
    expiresAt: timestamp,
  }),
);

export const organizationKeyApplyRequestCheck = exact<OrganizationKeyApplyRequest>()(
  strictObject({
    operation: oneOf(ORGANIZATION_KEY_OPERATIONS),
    publicKey,
    challenge: challengeHex,
    expiresAt: timestamp,
    actorSignature: signature,
    keySignature: signature,
    previousKeySignature: optional(signature),
  }),
);

export const organizationIdentityKeyStateCheck = exact<OrganizationIdentityKeyState>()(
  strictObject({
    accountId: string(minLength(1)),
    publicKey: nullable(string(minLength(1))),
    keys: array(
      strictObject({
        publicKey: string(minLength(1)),
        method: oneOf(ORGANIZATION_KEY_OPERATIONS),
        linkedByUserId: nullable(string()),
        previousKeyProven: boolean,
        linkedAt: string(datetime),
        retiredAt: nullable(string(datetime)),
      }),
    ),
  }),
);
