/**
 * Signature Service - ECDSA Digital Signatures (device-key bound)
 *
 * Handles signing and verification of messages with the user's DEVICE identity
 * key (read from {@link KeyManager} / secure storage). All cryptography itself —
 * canonical signing input, SHA-256, secp256k1 sign/verify, envelope assembly —
 * is delegated to `@oxy.so/protocol`; this service only resolves the key from
 * storage and orchestrates the protocol primitives.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import {
  signEnvelope,
  signMessage,
  verifySignature,
  sha256,
  loadExpoCrypto,
  loadNodeCrypto,
  isReactNative,
  isNodeJS,
} from '@oxy.so/protocol';
import { KeyManager } from './keyManager';
import { logger } from '../logger';

export interface SignedMessage {
  message: string;
  signature: string;
  publicKey: string;
  timestamp: number;
}

export interface AuthChallenge {
  challenge: string;
  publicKey: string;
  timestamp: number;
}

export class SignatureService {
  /**
   * Generate a random challenge string (for offline use)
   * Uses expo-crypto in React Native, crypto.randomBytes in Node.js
   */
  static async generateChallenge(): Promise<string> {
    // In React Native, use expo-crypto
    if (isReactNative()) {
      const Crypto = await loadExpoCrypto();
      const randomBytes = await Crypto.getRandomBytesAsync(32);
      return Array.from(new Uint8Array(randomBytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    if (isNodeJS()) {
      try {
        const nodeCrypto = await loadNodeCrypto();
        return nodeCrypto.randomBytes(32).toString('hex');
      } catch (error) {
        // Node crypto failed to load — log and fall through to Web Crypto API
        logger.warn('[oxy.crypto] Node crypto unavailable, falling back to Web Crypto', { component: 'SignatureService' }, error);
      }
    }

    // Browser: use Web Crypto API
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Hash a message using SHA-256
   */
  static async hashMessage(message: string): Promise<string> {
    return sha256(message);
  }

  /**
   * Sign a message using the stored device private key
   * Returns the signature in DER format (hex encoded)
   */
  static async sign(message: string): Promise<string> {
    const privateKey = await KeyManager.getPrivateKey();
    if (!privateKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }
    return signMessage(message, privateKey);
  }

  /**
   * Create a signed message object with metadata
   */
  static async createSignedMessage(message: string): Promise<SignedMessage> {
    const publicKey = await KeyManager.getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    const timestamp = Date.now();
    const messageWithTimestamp = `${message}:${timestamp}`;
    const signature = await SignatureService.sign(messageWithTimestamp);

    return {
      message,
      signature,
      publicKey,
      timestamp,
    };
  }

  /**
   * Verify a signed message object
   * Checks both signature validity and timestamp freshness
   */
  static async verifySignedMessage(
    signedMessage: SignedMessage,
    maxAgeMs: number = 5 * 60 * 1000 // 5 minutes default
  ): Promise<boolean> {
    const { message, signature, publicKey, timestamp } = signedMessage;

    // Check timestamp freshness
    const now = Date.now();
    if (now - timestamp > maxAgeMs) {
      return false;
    }

    // Verify signature
    const messageWithTimestamp = `${message}:${timestamp}`;
    return verifySignature(messageWithTimestamp, signature, publicKey);
  }

  /**
   * Create a signed authentication challenge response
   * Used for challenge-response authentication
   */
  static async signChallenge(challenge: string): Promise<AuthChallenge> {
    const publicKey = await KeyManager.getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    const timestamp = Date.now();
    const message = `auth:${publicKey}:${challenge}:${timestamp}`;
    const signature = await SignatureService.sign(message);

    return {
      challenge: signature,
      publicKey,
      timestamp,
    };
  }

  /**
   * Create a signed authentication challenge response using the SHARED identity
   * key (the cross-app `group.so.oxy.shared` keychain key), not the primary
   * device key.
   *
   * Mirrors {@link signChallenge} exactly — same message format
   * (`auth:${publicKey}:${challenge}:${timestamp}`) so the server verification
   * path is unchanged — but sources the shared public/private key from
   * `KeyManager` and signs with the protocol's explicit-key {@link signMessage}.
   * Used by "Sign in with Oxy" same-device shared-keychain SSO (Mechanism A): a
   * sibling native app proves control of the shared identity to mint its own
   * session.
   *
   * Throws if no shared identity exists (native-only; the shared keychain is
   * unavailable on web).
   */
  static async signChallengeWithSharedKey(challenge: string): Promise<AuthChallenge> {
    const publicKey = await KeyManager.getSharedPublicKey();
    const privateKey = await KeyManager.getSharedPrivateKey();
    if (!publicKey || !privateKey) {
      throw new Error('No shared identity found. Cannot sign with the shared key.');
    }

    const timestamp = Date.now();
    const message = `auth:${publicKey}:${challenge}:${timestamp}`;
    const signature = await signMessage(message, privateKey);

    return {
      challenge: signature,
      publicKey,
      timestamp,
    };
  }

  /**
   * Verify a challenge response
   */
  static async verifyChallengeResponse(
    originalChallenge: string,
    response: AuthChallenge,
    maxAgeMs: number = 5 * 60 * 1000
  ): Promise<boolean> {
    const { challenge: signature, publicKey, timestamp } = response;

    // Check timestamp freshness
    const now = Date.now();
    if (now - timestamp > maxAgeMs) {
      return false;
    }

    const message = `auth:${publicKey}:${originalChallenge}:${timestamp}`;
    return verifySignature(message, signature, publicKey);
  }

  /**
   * Create a registration signature
   * Used when registering a new identity with the server
   * Format matches server expectation: oxy:register:{publicKey}:{timestamp}
   */
  static async createRegistrationSignature(): Promise<{ signature: string; publicKey: string; timestamp: number }> {
    const publicKey = await KeyManager.getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    const timestamp = Date.now();
    const message = `oxy:register:${publicKey}:${timestamp}`;
    const signature = await SignatureService.sign(message);

    return {
      signature,
      publicKey,
      timestamp,
    };
  }

  /**
   * Sign arbitrary data for API requests
   * Creates a canonical string representation and signs it
   */
  static async signRequestData(data: Record<string, unknown>): Promise<{
    signature: string;
    publicKey: string;
    timestamp: number;
  }> {
    const publicKey = await KeyManager.getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    const timestamp = Date.now();

    // Create canonical string representation
    const sortedKeys = Object.keys(data).sort();
    const canonicalParts = sortedKeys.map(key => `${key}:${JSON.stringify(data[key])}`);
    const canonicalString = canonicalParts.join('|');

    const message = `request:${publicKey}:${timestamp}:${canonicalString}`;
    const signature = await SignatureService.sign(message);

    return {
      signature,
      publicKey,
      timestamp,
    };
  }

  /**
   * Build a signed-record envelope for a self-issued identity/profile record.
   *
   * The envelope is self-issued: `issuer` equals `subject` (the signer's DID).
   * The signature covers the canonical JSON of every field EXCEPT `publicKey`
   * and `signature`; `alg` is `ES256K-DER-SHA256` (secp256k1 over the SHA-256 of
   * the canonical bytes, DER-encoded). The cryptography is delegated to the
   * protocol's {@link signEnvelope}, which derives the (uncompressed-hex)
   * `publicKey` from the stored device key — identical to the registered
   * verification method.
   *
   * Requires a stored identity (native secure storage); throws if none exists.
   *
   * @param type - The record category (`'identity'` or `'profile'`).
   * @param subject - The subject DID the record is about (also the issuer).
   * @param record - The arbitrary record payload to attest to.
   */
  static async signRecord(
    type: SignedRecordEnvelope['type'],
    subject: string,
    record: Record<string, unknown>,
  ): Promise<SignedRecordEnvelope> {
    const privateKey = await KeyManager.getPrivateKey();
    if (!privateKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    return signEnvelope(
      {
        version: 1,
        type,
        subject,
        issuer: subject,
        record,
        issuedAt: Date.now(),
      },
      privateKey,
    );
  }

  /**
   * Build a signed-record envelope (v2) carrying the per-subject hash-chain
   * fields.
   *
   * Identical to {@link signRecord} (self-issued: `issuer === subject`; same
   * `ES256K-DER-SHA256` scheme) but `version` is `2` and the signed bytes
   * additionally cover the chain fields:
   *
   * @param type - The record category.
   * @param subject - The subject DID the record is about (also the issuer).
   * @param record - The arbitrary record payload to attest to.
   * @param chain - The hash-chain coordinates:
   *   - `seq` — strictly-increasing sequence number for this subject's chain.
   *   - `prev` — the `recordId` of the previous record, or `null` at genesis.
   *   - `collection` + `rkey` — the AtProto-style record key.
   *
   * The caller is responsible for fetching the current chain head (so `seq` /
   * `prev` are correct) before signing. Requires a stored identity; throws if
   * none exists.
   */
  static async signRecordV2(
    type: SignedRecordEnvelope['type'],
    subject: string,
    record: Record<string, unknown>,
    chain: { seq: number; prev: string | null; collection: string; rkey: string },
  ): Promise<SignedRecordEnvelope> {
    const privateKey = await KeyManager.getPrivateKey();
    if (!privateKey) {
      throw new Error('No identity found. Please create or import an identity first.');
    }

    const { seq, prev, collection, rkey } = chain;
    return signEnvelope(
      {
        version: 2,
        type,
        subject,
        issuer: subject,
        record,
        issuedAt: Date.now(),
        seq,
        prev,
        collection,
        rkey,
      },
      privateKey,
    );
  }
}

export default SignatureService;
