/**
 * secp256k1 primitives shared by every Oxy runtime.
 *
 * This module owns the curve binding and the wire formats used across Oxy:
 * 32-byte private keys, compressed or uncompressed SEC1 public keys,
 * RFC 6979 deterministic ECDSA signatures encoded as DER, and the 32-byte
 * ECDH x-coordinate. Callers never receive a library-specific key object.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";

const HEX = /^[0-9a-fA-F]+$/;
const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-fA-F]{64}$/;
const UNCOMPRESSED_PUBLIC_KEY = /^04[0-9a-fA-F]{128}$/;

export interface Secp256k1KeyPair {
  /** Canonical lowercase 32-byte scalar. */
  privateKey: string;
  /** Lowercase uncompressed SEC1 public key (65 bytes). */
  publicKey: string;
}

export interface Secp256k1SignatureOptions {
  /** Normalize S into the lower half of the curve order. Defaults to false for wire compatibility. */
  lowS?: boolean;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function hexToBytes(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || !HEX.test(value)) {
    throw new Error(`${label} must be an even-length hexadecimal string`);
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Normalize a legacy short/cased scalar to canonical 32-byte lowercase hex.
 * The scalar must be within the secp256k1 order; zero and overflow are rejected.
 */
export function normalizeSecp256k1PrivateKey(privateKeyHex: string): string {
  if (
    typeof privateKeyHex !== "string" ||
    privateKeyHex.length === 0 ||
    privateKeyHex.length > 64 ||
    !HEX.test(privateKeyHex)
  ) {
    throw new Error(
      "secp256k1 private key must contain 1 to 64 hexadecimal characters",
    );
  }

  const normalized = privateKeyHex.toLowerCase().padStart(64, "0");
  const privateKey = hexToBytes(normalized, "secp256k1 private key");
  if (!secp256k1.utils.isValidSecretKey(privateKey)) {
    throw new Error("secp256k1 private key is outside the valid scalar range");
  }
  return normalized;
}

/** True when a value is a valid secp256k1 scalar (legacy short hex accepted). */
export function isValidSecp256k1PrivateKey(privateKeyHex: string): boolean {
  try {
    normalizeSecp256k1PrivateKey(privateKeyHex);
    return true;
  } catch {
    return false;
  }
}

function parsePrivateKey(privateKeyHex: string): Uint8Array {
  return hexToBytes(
    normalizeSecp256k1PrivateKey(privateKeyHex),
    "secp256k1 private key",
  );
}

function parsePublicKey(publicKeyHex: string): Uint8Array {
  if (
    typeof publicKeyHex !== "string" ||
    (!COMPRESSED_PUBLIC_KEY.test(publicKeyHex) &&
      !UNCOMPRESSED_PUBLIC_KEY.test(publicKeyHex))
  ) {
    throw new Error(
      "secp256k1 public key must be a compressed or uncompressed SEC1 hex key",
    );
  }

  const publicKey = hexToBytes(publicKeyHex, "secp256k1 public key");
  // Parsing validates the SEC1 prefix, coordinate range, and curve equation.
  secp256k1.Point.fromBytes(publicKey);
  return publicKey;
}

function parseDigest(digestHex: string): Uint8Array {
  if (typeof digestHex !== "string" || digestHex.length !== 64) {
    throw new Error(
      "secp256k1 digest must be exactly 32 bytes of hexadecimal data",
    );
  }
  return hexToBytes(digestHex, "secp256k1 digest");
}

/** True for a valid compressed or uncompressed SEC1 secp256k1 public key. */
export function isValidSecp256k1PublicKey(publicKeyHex: string): boolean {
  try {
    parsePublicKey(publicKeyHex);
    return true;
  } catch {
    return false;
  }
}

/** Generate a canonical private key and its uncompressed public key. */
export function generateSecp256k1KeyPair(): Secp256k1KeyPair {
  const privateKey = secp256k1.utils.randomSecretKey();
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(secp256k1.getPublicKey(privateKey, false)),
  };
}

/** Derive a compressed or uncompressed SEC1 public key from a private scalar. */
export function deriveSecp256k1PublicKey(
  privateKeyHex: string,
  compressed = false,
): string {
  return bytesToHex(
    secp256k1.getPublicKey(parsePrivateKey(privateKeyHex), compressed),
  );
}

/** Parse and re-encode a public key in canonical lowercase SEC1 form. */
export function normalizeSecp256k1PublicKey(
  publicKeyHex: string,
  compressed = false,
): string {
  const point = secp256k1.Point.fromBytes(parsePublicKey(publicKeyHex));
  return point.toHex(compressed);
}

/**
 * Sign a 32-byte digest with deterministic RFC 6979 ECDSA and return DER hex.
 *
 * `lowS` defaults to false because historical Oxy signatures used elliptic's
 * default and therefore may occupy either half of the curve order. Verification
 * accepts both forms; callers that require low-S normalization opt in explicitly.
 */
export function signSecp256k1Digest(
  privateKeyHex: string,
  digestHex: string,
  options: Secp256k1SignatureOptions = {},
): string {
  const signature = secp256k1.sign(
    parseDigest(digestHex),
    parsePrivateKey(privateKeyHex),
    {
      lowS: options.lowS ?? false,
    },
  );
  return signature.toHex("der");
}

/** Verify a DER-encoded ECDSA signature, accepting historical high-S signatures. */
export function verifySecp256k1Digest(
  publicKeyHex: string,
  digestHex: string,
  signatureDerHex: string,
): boolean {
  const publicKey = parsePublicKey(publicKeyHex);
  const digest = parseDigest(digestHex);
  const signature = hexToBytes(signatureDerHex, "secp256k1 DER signature");

  // Parse once up front so malformed or non-DER input is rejected explicitly.
  secp256k1.Signature.fromBytes(signature, "der");
  return secp256k1.verify(signature, digest, publicKey, {
    format: "der",
    lowS: false,
  });
}

/** Derive the fixed-width 32-byte ECDH x-coordinate shared secret. */
export function deriveSecp256k1SharedSecret(
  privateKeyHex: string,
  publicKeyHex: string,
): Uint8Array {
  const encodedPoint = secp256k1.getSharedSecret(
    parsePrivateKey(privateKeyHex),
    parsePublicKey(publicKeyHex),
    true,
  );
  if (encodedPoint.length !== 33) {
    throw new Error("secp256k1 ECDH returned an unexpected point encoding");
  }
  return encodedPoint.slice(1);
}
