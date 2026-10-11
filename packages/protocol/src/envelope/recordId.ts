/**
 * Content hashing — SHA-256 + `recordId` (content address).
 *
 * `sha256` is the protocol's single platform-aware SHA-256: it uses
 * `expo-crypto` on React Native, Node's built-in `crypto` on the server, and
 * the Web Crypto API in the browser — always producing the same lowercase-hex
 * digest. `computeRecordId` is `sha256(signedRecordSigningInput(fields))`: the
 * content address that a record's chain `prev` pointer references.
 */

import { isReactNative, isNodeJS } from '../platform/platform';
import { loadExpoCrypto, loadNodeCrypto } from '../platform/crypto';
import { signedRecordSigningInput, type SignedRecordSigningFields } from './signingInput';

/**
 * Compute the SHA-256 hash of a string, returned as lowercase hex.
 *
 * Platform-aware: `expo-crypto` (RN) → Node `crypto` (server) → Web Crypto
 * (browser). The three paths produce byte-identical digests, so a record
 * hashed on a device and re-hashed on the server agree.
 */
export async function sha256(message: string): Promise<string> {
  // In React Native, use expo-crypto
  if (isReactNative()) {
    const Crypto = await loadExpoCrypto();
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, message);
  }

  if (isNodeJS()) {
    try {
      const nodeCrypto = await loadNodeCrypto();
      return nodeCrypto.createHash('sha256').update(message).digest('hex');
    } catch {
      // Node crypto failed to load — fall through to the Web Crypto API below,
      // which is a correct, equivalent SHA-256 on any runtime that exposes it.
    }
  }

  // Browser: use Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute the `recordId` (content address) of a signed record: the SHA-256 hex
 * digest of its canonical {@link signedRecordSigningInput}.
 *
 * Deterministic and stable across runtimes (it reuses the same canonicalization
 * + SHA-256 the signature itself is built on). The recordId is what `prev`
 * references in the per-subject hash chain, so every implementation MUST
 * compute it identically — all call this function. It is taken over the SIGNING
 * input (excluding `publicKey`/`signature`), so it is a pure content address of
 * the record's meaning, independent of who signed.
 */
export async function computeRecordId(fields: SignedRecordSigningFields): Promise<string> {
  return sha256(signedRecordSigningInput(fields));
}
