/**
 * Owner authorization for node writes — the implementation of `@oxy.so/protocol`'s
 * injected {@link OwnerAuth}, bound to the node's configured owner public key.
 *
 * Two write paths, both anchored on the owner key:
 *
 *  1. **Signed records** (`POST /records`, `POST /sync/push`) — self-authenticating.
 *     The envelope is signed by the owner's key, so the owner check is simply
 *     "is `envelope.publicKey` the owner key?" ({@link isOwnerKey}). The signature
 *     itself is verified in the protocol record verifier.
 *
 *  2. **Blob pins** (`PUT /blobs/:hash`) — the body is raw bytes, not a signed
 *     envelope, so the owner proves control with a fresh signed header over the
 *     action ({@link verifyOwnerActionSignature}). This reuses the SAME
 *     `@oxy.so/protocol` secp256k1 verification rather than a shared bearer secret.
 *
 * The owner-auth message format and key-equality helper live HERE (not in
 * `@oxy.so/protocol`) so the protocol package stays free of `@oxy.so/core` — the
 * node injects this implementation into `createNodeApp`.
 *
 * Public-key equality is compared with `verifySecret` (`@oxy.so/core/server`) —
 * constant-time and length-guarded, the blessed helper for identity equality.
 */

import { verifySignature } from '@oxy.so/protocol';
import { OWNER_ACTION_BLOB_PIN, OWNER_AUTH_MAX_AGE_MS, type OwnerAuth } from '@oxy.so/protocol/node';
import { verifySecret } from '@oxy.so/core/server';

/** True iff `publicKey` is the node's configured owner key (case-insensitive, constant-time). */
export function isOwnerKey(publicKey: string, ownerPublicKey: string): boolean {
  if (typeof publicKey !== 'string' || publicKey.length === 0) {
    return false;
  }
  return verifySecret(publicKey.toLowerCase(), ownerPublicKey.toLowerCase());
}

/** The canonical message an owner signs to authorize a node action. */
export function ownerActionMessage(action: string, timestamp: number): string {
  return `oxy-node:${action}:${timestamp}`;
}

export interface OwnerActionAuth {
  /** The signer's claimed public key (must equal the owner key). */
  publicKey: string;
  /** DER-encoded (hex) secp256k1 signature over {@link ownerActionMessage}. */
  signature: string;
  /** Epoch milliseconds the authorization was created (freshness-checked). */
  timestamp: number;
}

/**
 * Verify an owner-signed authorization for a node `action` (e.g. `blob-pin:<hash>`).
 *
 * Requires that the signer IS the owner key, the timestamp is fresh (within
 * {@link OWNER_AUTH_MAX_AGE_MS}), and the secp256k1 signature over
 * {@link ownerActionMessage} verifies against the owner key.
 */
export async function verifyOwnerActionSignature(
  ownerPublicKey: string,
  action: string,
  auth: OwnerActionAuth,
): Promise<boolean> {
  if (!isOwnerKey(auth.publicKey, ownerPublicKey)) {
    return false;
  }
  if (!Number.isFinite(auth.timestamp)) {
    return false;
  }
  if (Math.abs(Date.now() - auth.timestamp) > OWNER_AUTH_MAX_AGE_MS) {
    return false;
  }
  const message = ownerActionMessage(action, auth.timestamp);
  return verifySignature(message, auth.signature, auth.publicKey);
}

/**
 * Build the {@link OwnerAuth} the generic `createNodeApp` engine consults, bound
 * to the node's configured owner public key. The blob-pin action is
 * `blob-pin:<hash>` (the hash binds the authorization to the specific blob).
 */
export function createOwnerAuth(ownerPublicKey: string): OwnerAuth {
  return {
    isOwnerKey(publicKey: string): boolean {
      return isOwnerKey(publicKey, ownerPublicKey);
    },
    verifyBlobPin(hash, auth): Promise<boolean> {
      return verifyOwnerActionSignature(ownerPublicKey, `${OWNER_ACTION_BLOB_PIN}:${hash}`, auth);
    },
  };
}
