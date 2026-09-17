/**
 * Signing the one identity-proof format (ADR 0024 D7).
 *
 * The bytes come from `@oxy.so/contracts` `buildIdentityProofMessage`, which the
 * API verifies against; payload digests hash `canonicalJson`. Nothing here builds
 * its own JSON.
 */

import './polyfill';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { signMessage } from '@oxy.so/protocol';
import {
  IDENTITY_PROOF_VERSION,
  buildIdentityProofMessage,
  canonicalJson,
  type IdentityProof,
  type IdentityProofClaims,
} from '@oxy.so/contracts';

/** SHA-256 hex of the canonical JSON of `payload` — the `payloadDigest` claim. */
export function digestIdentityPayload(payload: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(payload))));
}

/** Sign `claims` with the root, producing the proof as it travels. */
export async function signIdentityProof(
  identity: { privateKey: string; publicKey: string },
  claims: IdentityProofClaims,
): Promise<IdentityProof> {
  if (claims.rootPublicKey !== identity.publicKey.toLowerCase()) {
    throw new Error('identity proof: the claims name a different root');
  }
  const signature = await signMessage(buildIdentityProofMessage(claims), identity.privateKey);
  return { v: IDENTITY_PROOF_VERSION, challenge: claims.challenge, expiresAt: claims.expiresAt, signature };
}
