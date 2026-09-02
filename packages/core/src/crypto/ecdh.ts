/**
 * ECDH shared-secret derivation (secp256k1)
 *
 * Derives a raw 32-byte ECDH shared secret from a local private key and a
 * remote public key, using the shared `@oxyhq/protocol` secp256k1 primitive.
 * This is the key-exchange
 * step for the Commons device-to-device transfer flow: each side computes the
 * same shared secret, which is then run through `hkdfSha256` to derive the
 * symmetric key handed to `encryptAead` / `decryptAead`.
 *
 * The returned value is the raw x-coordinate of the ECDH point, big-endian,
 * zero-padded to 32 bytes. It is NOT itself a symmetric key — always pass it
 * through a KDF (HKDF) with a context-binding `info` before use.
 *
 * ESM/CJS safe: static `import` only, no `require()`.
 */

import { deriveSecp256k1SharedSecret } from '@oxyhq/protocol/secp256k1';

/**
 * Compute the ECDH shared secret between a local private key and a remote
 * public key on secp256k1.
 *
 * Symmetric by construction:
 * `deriveSharedSecret(privA, pubB) === deriveSharedSecret(privB, pubA)`.
 *
 * @param privateKeyHex     Local private key, hex (up to 64 chars; canonicalized).
 * @param otherPublicKeyHex Remote public key, hex — compressed (`02`/`03` + 32
 *                          bytes) or uncompressed (`04` + 64 bytes).
 * @returns                 The 32-byte big-endian shared secret.
 */
export function deriveSharedSecret(
  privateKeyHex: string,
  otherPublicKeyHex: string,
): Uint8Array {
  return deriveSecp256k1SharedSecret(privateKeyHex, otherPublicKeyHex);
}
