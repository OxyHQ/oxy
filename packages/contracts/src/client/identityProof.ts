/**
 * The identity-proof message format, without Zod. Schemas: `../identityProof.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

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
  /**
   * Link Commons' root to an account that has none (`POST /auth/link`).
   * The account becomes self-custodied and its email is deleted
   * (ADR 0029 D3).
   */
  link: 'link_identity',
} as const;

export type IdentityProofAction =
  (typeof IDENTITY_PROOF_ACTIONS)[keyof typeof IDENTITY_PROOF_ACTIONS];

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
  /** The revision the operation expects to replace, or `null` when it replaces nothing. */
  expectedRevision: number | null;
  audience: string;
  /** The one-use server challenge. */
  challenge: string;
  /** Unix milliseconds after which the proof is refused. */
  expiresAt: number;
}

export const HEX_DIGEST = /^[0-9a-f]{64}$/;

export const ROOT_KEY = /^04[0-9a-f]{128}$/;

export const CHALLENGE = /^[0-9a-f]{64}$/;

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
  if (!IDENTITY_PROOF_ACTION_VALUES.includes(claims.action))
    throw new Error('identity proof: unknown action');
  if (!claims.subject || !claims.actor)
    throw new Error('identity proof: subject and actor are required');
  if (!ROOT_KEY.test(claims.rootPublicKey))
    throw new Error('identity proof: rootPublicKey must be canonical');
  if (claims.payloadDigest !== null && !HEX_DIGEST.test(claims.payloadDigest)) {
    throw new Error('identity proof: payloadDigest must be a lowercase SHA-256 hex digest');
  }
  if (
    claims.expectedRevision !== null &&
    (!Number.isSafeInteger(claims.expectedRevision) || claims.expectedRevision < 0)
  ) {
    throw new Error('identity proof: expectedRevision must be a non-negative integer');
  }
  if (!CHALLENGE.test(claims.challenge))
    throw new Error('identity proof: challenge must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0)
    throw new Error('identity proof: expiresAt must be unix milliseconds');
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

/**
 * Stable error codes the root routes answer with (`error.code` in the API error
 * body). Clients map these through their localization, never the English message.
 */
export const IDENTITY_ERROR_CODES = {
  proofInvalid: 'IDENTITY_PROOF_INVALID',
  rootAlreadyLinked: 'IDENTITY_ROOT_ALREADY_LINKED',
  rootLinkedElsewhere: 'IDENTITY_ROOT_LINKED_ELSEWHERE',
  freshFactorRequired: 'IDENTITY_FRESH_FACTOR_REQUIRED',
  notPersonal: 'IDENTITY_NOT_PERSONAL_ACCOUNT',
} as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];
