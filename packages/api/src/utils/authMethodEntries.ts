/**
 * Auth-method ↔ DID verification-method mapping (self-sovereign identity — B4).
 *
 * Single source of the `AuthMethodEntry[]` shape served by `GET /auth/methods`
 * and embedded in the signed data export. Each entry maps a linked auth method
 * to its DID verification-method fragment: an `identity` method carries the
 * `#key-1` verification-method id (its key is a DID verification method); a
 * `webauthn` passkey carries none.
 */

import type { AuthMethodEntry } from '@oxy.so/contracts';

/** The verification-method fragment for the primary identity key. */
export const IDENTITY_VERIFICATION_METHOD_ID = '#key-1';

export interface AuthMethodEntriesInput {
  publicKey?: string | null;
  authMethods?: Array<{
    type?: string | null;
    linkedAt?: Date | null;
    metadata?: { credentialID?: string | null; name?: string | null } | null;
  } | null> | null;
  /** Fallback `linkedAt` for methods predating the `authMethods[]` stamp. */
  createdAt: Date;
}

/**
 * Build the contract-shaped list of linked authentication methods for an
 * account. The identity entry is present when the account holds a `publicKey`;
 * and one `webauthn` entry per registered passkey row (carrying its
 * `credentialId` + `name`). A passkey is NOT a DID verification method, so its
 * entry has no `verificationMethodId` — a passkey-only account stays custodial.
 */
export function buildAuthMethodEntries(input: AuthMethodEntriesInput): AuthMethodEntry[] {
  const entries: AuthMethodEntry[] = [];
  const methods = input.authMethods ?? [];
  const linkedAtFor = (type: string): Date =>
    methods.find((method) => method?.type === type)?.linkedAt ?? input.createdAt;

  if (input.publicKey) {
    entries.push({
      type: 'identity',
      linkedAt: linkedAtFor('identity'),
      verificationMethodId: IDENTITY_VERIFICATION_METHOD_ID,
    });
  }

  for (const method of methods) {
    if (method?.type === 'webauthn') {
      const entry: AuthMethodEntry = { type: 'webauthn', linkedAt: method.linkedAt ?? input.createdAt };
      if (method.metadata?.credentialID) entry.credentialId = method.metadata.credentialID;
      if (method.metadata?.name) entry.name = method.metadata.name;
      entries.push(entry);
    }
  }

  return entries;
}
