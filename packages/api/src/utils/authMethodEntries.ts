/**
 * Auth-method ↔ DID verification-method mapping (self-sovereign identity — B4).
 *
 * Single source of the `AuthMethodEntry[]` shape served by `GET /auth/methods`
 * and embedded in the signed data export. The one auth method is the account's
 * identity key, which carries the `#key-1` verification-method id. Email,
 * password and authenticator are sign-in factors, not DID verification
 * methods, so they are not listed.
 */

import type { AuthMethodEntry } from '@oxy.so/contracts';

/** The verification-method fragment for the primary identity key. */
export const IDENTITY_VERIFICATION_METHOD_ID = '#key-1';

export interface AuthMethodEntriesInput {
  publicKey?: string | null;
  authMethods?: Array<{ type?: string | null; linkedAt?: Date | null } | null> | null;
  /** Fallback `linkedAt` for methods predating the `authMethods[]` stamp. */
  createdAt: Date;
}

/**
 * Build the contract-shaped list of linked authentication methods for an
 * account: the identity entry when the account holds a `publicKey`, or none.
 */
export function buildAuthMethodEntries(input: AuthMethodEntriesInput): AuthMethodEntry[] {
  if (!input.publicKey) return [];
  const linkedAt = (input.authMethods ?? []).find((method) => method?.type === 'identity')?.linkedAt;
  return [{ type: 'identity', linkedAt: linkedAt ?? input.createdAt, verificationMethodId: IDENTITY_VERIFICATION_METHOD_ID }];
}
