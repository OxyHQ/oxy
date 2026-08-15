/**
 * The `oxy_sk_…` machine bearer token — its format, its generation, and the two
 * halves storage keeps (issue #972 §2.3).
 *
 * ## The format
 *
 *     oxy_sk_<16 hex id>_<64 hex secret>
 *
 * One string, sent verbatim as `Authorization: Bearer …` by a stock OpenAI SDK
 * with no token exchange in front of it. It splits at a fixed offset into:
 *
 *   - **the prefix** — `oxy_sk_` plus the id, stored in
 *     `application_credentials.token_prefix` (unique). This is what a lookup
 *     matches on, so resolution is an index probe rather than a scan over every
 *     credential's hash. It is PUBLIC: 64 bits of id identify the row and
 *     authorise nothing.
 *   - **the secret** — 32 CSPRNG bytes, 256 bits, uniform. Never stored; only
 *     the SHA-256 of the FULL token is, in `token_hash`.
 *
 * Hex on both halves rather than base64url, so the shape is a single
 * unambiguous regex and the separator can never appear inside either half —
 * base64url's alphabet includes `_`, which would make "split at the first
 * underscore after the prefix" a rule with an exception.
 *
 * ## Why the hash covers the WHOLE token
 *
 * Hashing only the secret half would make the stored digest independent of which
 * row it sits on, so a `token_hash` copied between rows would still verify. With
 * the prefix inside the pre-image, a digest is bound to the one prefix it was
 * minted for and a transplanted hash verifies against nothing.
 *
 * Pure and dependency-free apart from `node:crypto`, so the format rules are
 * unit-testable without a database.
 */

import crypto from 'crypto';

/** The scheme every machine bearer token starts with. */
export const MACHINE_TOKEN_PREFIX = 'oxy_sk_';

/** Bytes of the lookup id. 8 → 16 hex characters, 64 bits. */
const TOKEN_ID_BYTES = 8;

/**
 * Bytes of the secret half. 32 → 64 hex characters, 256 bits — the number the
 * schema's "SHA-256 is the right primitive here" argument rests on. Lowering it
 * invalidates that argument, not just the entropy.
 */
const TOKEN_SECRET_BYTES = 32;

/**
 * The one shape accepted, anchored at both ends. Anything else — a truncated
 * token, an `oxy_dk_…` public identifier, a JWT, a bearer with a trailing
 * newline — is refused before a query is ever issued.
 */
const MACHINE_TOKEN_PATTERN = /^oxy_sk_([0-9a-f]{16})_([0-9a-f]{64})$/;

/** A freshly minted token and the two values storage keeps. */
export interface GeneratedMachineCredentialToken {
  /** The full bearer string. Returned to the caller EXACTLY once, then dropped. */
  token: string;
  /** `oxy_sk_<id>` — the lookup half, stored in `token_prefix`. */
  tokenPrefix: string;
  /** SHA-256 of `token`, stored in `token_hash`. */
  tokenHash: string;
}

/** SHA-256 of a full bearer token, hex. The only hash this module computes. */
export function hashMachineCredentialToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a machine bearer token.
 *
 * The SOLE writer of this format. Every property the schema's hash argument
 * depends on — uniform, CSPRNG, 256-bit, never caller-supplied — is decided
 * here and nowhere else.
 */
export function generateMachineCredentialToken(): GeneratedMachineCredentialToken {
  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const secret = crypto.randomBytes(TOKEN_SECRET_BYTES).toString('hex');
  const tokenPrefix = `${MACHINE_TOKEN_PREFIX}${tokenId}`;
  const token = `${tokenPrefix}_${secret}`;
  return { token, tokenPrefix, tokenHash: hashMachineCredentialToken(token) };
}

/**
 * The lookup prefix of a well-formed machine bearer token, or `null` when the
 * value is not one.
 *
 * `null` is the answer for BOTH "this is some other kind of bearer" and "this is
 * a malformed machine token", on purpose: the caller's next move is the same in
 * either case (fall through to the other auth lanes, resolve nothing), and
 * distinguishing them would only give a caller a way to ask whether a string
 * looks like an Oxy machine key.
 */
export function machineCredentialTokenPrefix(value: string): string | null {
  const match = MACHINE_TOKEN_PATTERN.exec(value);
  return match ? `${MACHINE_TOKEN_PREFIX}${match[1]}` : null;
}
