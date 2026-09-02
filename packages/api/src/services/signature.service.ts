/**
 * Signature Verification Service
 * 
 * Handles ECDSA signature verification for the backend.
 * Used to authenticate users via their public key and digital signatures.
 */

import {
  isValidSecp256k1PublicKey,
  normalizeSecp256k1PublicKey,
  signSecp256k1Digest,
  verifySecp256k1Digest,
} from '@oxyhq/protocol/secp256k1';
import crypto from 'crypto';

// Challenge expiration time in milliseconds (5 minutes)
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Maximum age for signed requests (5 minutes)
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Allow client clocks slightly ahead of the server (device skew). */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

export class SignatureService {
  /**
   * True when `timestamp` is within `[now - maxAgeMs, now + MAX_CLOCK_SKEW_MS]`.
   */
  static isTimestampFresh(timestamp: number, maxAgeMs: number = MAX_SIGNATURE_AGE_MS): boolean {
    const age = Date.now() - timestamp;
    return age <= maxAgeMs && age >= -MAX_CLOCK_SKEW_MS;
  }
  /**
   * Generate a random challenge string
   */
  static generateChallenge(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Compute SHA-256 hash of a message
   */
  static hashMessage(message: string): string {
    return crypto.createHash('sha256').update(message).digest('hex');
  }

  /**
   * Sign a message with a secp256k1 private key.
   *
   * Produces a DER-encoded (hex) signature over the SHA-256 of `message` — the
   * exact inverse of {@link verifySignature}. Used server-side for the Oxy
   * custodial signing key: the signed data-export attestation
   * (`ES256K-DER-SHA256` over the canonical bundle) and custodial provenance.
   * The private key NEVER leaves the server; it is read from env by callers.
   *
   * @param message - The message to sign (the canonical signing input)
   * @param privateKey - The secp256k1 private key (hex encoded)
   * @returns DER-encoded signature (hex)
   */
  static signMessage(message: string, privateKey: string): string {
    const messageHash = SignatureService.hashMessage(message);
    return signSecp256k1Digest(privateKey, messageHash);
  }

  /**
   * Verify an ECDSA signature
   *
   * @param message - The original message that was signed
   * @param signature - The signature in DER format (hex encoded)
   * @param publicKey - The public key (hex encoded, uncompressed)
   * @returns true if the signature is valid
   */
  static verifySignature(message: string, signature: string, publicKey: string): boolean {
    try {
      const messageHash = SignatureService.hashMessage(message);
      return verifySecp256k1Digest(publicKey, messageHash, signature);
    } catch {
      return false;
    }
  }

  /**
   * Verify an authentication challenge response
   * 
   * @param publicKey - The user's public key
   * @param challenge - The original challenge string
   * @param signature - The signature of the auth message
   * @param timestamp - The timestamp when the signature was created
   * @returns true if the challenge response is valid
   */
  static verifyChallengeResponse(
    publicKey: string,
    challenge: string,
    signature: string,
    timestamp: number
  ): boolean {
    if (!SignatureService.isTimestampFresh(timestamp, CHALLENGE_TTL_MS)) {
      return false;
    }

    // Verify the signature
    const message = `auth:${publicKey}:${challenge}:${timestamp}`;
    return SignatureService.verifySignature(message, signature, publicKey);
  }

  /**
   * Verify a registration signature
   * Signature format: oxy:register:{publicKey}:{timestamp}
   */
  static verifyRegistrationSignature(
    publicKey: string,
    signature: string,
    timestamp: number
  ): boolean {
    if (!SignatureService.isTimestampFresh(timestamp, MAX_SIGNATURE_AGE_MS)) {
      return false;
    }

    const message = `oxy:register:${publicKey}:${timestamp}`;
    return SignatureService.verifySignature(message, signature, publicKey);
  }

  /**
   * Verify a signed request
   * Used for authenticated API operations
   */
  static verifyRequestSignature(
    publicKey: string,
    data: Record<string, unknown>,
    signature: string,
    timestamp: number
  ): boolean {
    if (!SignatureService.isTimestampFresh(timestamp, MAX_SIGNATURE_AGE_MS)) {
      return false;
    }

    // Create canonical string representation
    const sortedKeys = Object.keys(data).sort();
    const canonicalParts = sortedKeys.map(key => `${key}:${JSON.stringify(data[key])}`);
    const canonicalString = canonicalParts.join('|');
    
    const message = `request:${publicKey}:${timestamp}:${canonicalString}`;
    return SignatureService.verifySignature(message, signature, publicKey);
  }

  /**
   * Validate that a string is a valid public key
   */
  static isValidPublicKey(publicKey: string): boolean {
    return isValidSecp256k1PublicKey(publicKey);
  }

  /**
   * Canonicalize a secp256k1 public key to ONE form: uncompressed, lowercased
   * hex. `isValidPublicKey` accepts the same point in compressed (`02/03…`),
   * uncompressed (`04…`), or any-case encodings, but the `User.publicKey` unique
   * index and the conflict/lookup queries are raw-string/case-sensitive. Storing
   * and comparing the canonical form makes those checks encoding-independent, so
   * two encodings of the same point can never coexist across accounts.
   *
   * @param publicKey - The public key in any valid hex encoding.
   * @returns The uncompressed, lowercased hex encoding of the same point.
   * @throws if `publicKey` is not a valid secp256k1 public key.
   */
  static canonicalizePublicKey(publicKey: string): string {
    return normalizeSecp256k1PublicKey(publicKey);
  }

  /**
   * Get a shortened display version of a public key
   */
  static shortenPublicKey(publicKey: string): string {
    if (publicKey.length <= 16) return publicKey;
    return `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`;
  }
}

export default SignatureService;

