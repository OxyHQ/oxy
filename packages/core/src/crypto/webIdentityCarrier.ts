/**
 * Web identity carrier — the crypto of "one identity, two carriers".
 *
 * An Oxy identity is a BIP-39 mnemonic; its seed's first 32 bytes are the
 * secp256k1 key (`recoveryPhrase.ts`). Commons keeps that key in the device
 * keychain. This module lets a browser carry the SAME identity without Oxy ever
 * being able to use it:
 *
 *   entropy ──AEAD(DEK)──▶ sealedEntropy
 *   DEK     ──AEAD(KEK_i)─▶ wraps[i]            KEK_i = HKDF(PRF output of passkey i)
 *
 * The PRF output is produced inside the user's authenticator, behind user
 * verification, and never leaves the page that asked for it. The envelope is
 * therefore safe to store anywhere — the identity origin's IndexedDB and the
 * server copy alike — and opens only with a registered passkey or the phrase.
 *
 * PURE: no storage, no network, no WebAuthn call, no platform globals beyond the
 * CSPRNG the AEAD polyfill guarantees. The caller runs the ceremony and hands the
 * PRF output in; everything here is deterministic given its inputs, so it is
 * identical on web, Node and React Native, and fully unit-testable.
 *
 * Contract: `WebIdentityEnvelope` in `@oxy.so/contracts`.
 */

import './polyfill';
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { signMessage } from '@oxy.so/protocol';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import {
  WEB_IDENTITY_ENVELOPE_VERSION,
  type WebIdentityEnvelope,
  type WebIdentityWrap,
} from '@oxy.so/contracts';
import { AEAD_KEY_LENGTH, decryptAead, encryptAead } from './aead';
import { hkdfSha256 } from './kdf';

/**
 * The PRF input every identity-carrier ceremony evaluates (`prf.eval.first`).
 *
 * Fixed rather than per-wrap: discoverable sign-in has no credential list to key
 * `evalByCredential` by, and each passkey's output is already distinct. A future
 * scheme change bumps the label — and with it every KEK — instead of mutating it.
 */
export const WEB_IDENTITY_PRF_INPUT: Uint8Array = sha256(utf8ToBytes('oxy-web-identity-carrier/prf/v1'));

/** HKDF salt of the key-encryption-key schedule. Versioned with the envelope. */
const KEK_SALT = utf8ToBytes('oxy-web-identity-carrier/kek/v1');

/** A WebAuthn PRF output is 32 bytes (HMAC-SHA-256). */
const PRF_OUTPUT_LENGTH = 32;

/** Why an envelope did not open. Every value is a normal outcome a UI can explain. */
export type WebIdentityUnlockFailure =
  /** The passkey used is not one of the envelope's wraps. */
  | 'unknown-credential'
  /**
   * The passkey IS listed but its PRF output does not open its wrap — a synced
   * copy returning a different PRF value, or a provider that silently changed it.
   * Recoverable with another passkey or the phrase.
   */
  | 'prf-mismatch'
  /** The envelope itself is malformed or tampered with. */
  | 'corrupt';

export class WebIdentityUnlockError extends Error {
  constructor(readonly failure: WebIdentityUnlockFailure, message: string) {
    super(message);
    this.name = 'WebIdentityUnlockError';
  }
}

/** The identity in usable form. Hold it for one operation, then {@link wipeBytes}. */
export interface OpenedWebIdentity {
  mnemonic: string;
  /** 32-byte secp256k1 private key, lowercase hex. */
  privateKey: string;
  /** Uncompressed SEC1 public key, lowercase hex (Oxy's canonical form). */
  publicKey: string;
}

function aadFor(parts: Record<string, string | number>): Uint8Array {
  return utf8ToBytes(JSON.stringify(parts));
}

function entropyAad(publicKey: string): Uint8Array {
  return aadFor({ v: WEB_IDENTITY_ENVELOPE_VERSION, purpose: 'entropy', publicKey });
}

function wrapAad(publicKey: string, credentialId: string): Uint8Array {
  return aadFor({ v: WEB_IDENTITY_ENVELOPE_VERSION, purpose: 'wrap', publicKey, credentialId });
}

/** Overwrite a buffer holding secret material. Best effort — JS gives no stronger guarantee. */
export function wipeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Derive the identity from a mnemonic exactly as Commons does
 * (`RecoveryPhraseService`): seed → first 32 bytes → secp256k1.
 */
export function deriveIdentityFromMnemonic(mnemonic: string): OpenedWebIdentity {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error('Invalid recovery phrase');
  }
  const seed = mnemonicToSeedSync(normalized);
  const privateKeyBytes = seed.slice(0, 32);
  wipeBytes(seed);
  const privateKey = bytesToHex(privateKeyBytes);
  wipeBytes(privateKeyBytes);
  return { mnemonic: normalized, privateKey, publicKey: deriveSecp256k1PublicKey(privateKey) };
}

/** A brand-new 12-word identity. Nothing is persisted. */
export function generateWebIdentity(): OpenedWebIdentity {
  return deriveIdentityFromMnemonic(generateMnemonic(wordlist, 128));
}

/** A fresh random data key for a new envelope. */
export function generateDataKey(): Uint8Array {
  const key = new Uint8Array(AEAD_KEY_LENGTH);
  globalThis.crypto.getRandomValues(key);
  return key;
}

/** The key-encryption key a passkey's PRF output yields for its own wrap. */
export function deriveKeyEncryptionKey(prfOutput: Uint8Array, credentialId: string): Uint8Array {
  if (prfOutput.length !== PRF_OUTPUT_LENGTH) {
    throw new Error(`PRF output must be ${PRF_OUTPUT_LENGTH} bytes, got ${prfOutput.length}`);
  }
  return hkdfSha256(prfOutput, KEK_SALT, utf8ToBytes(credentialId), AEAD_KEY_LENGTH);
}

/** Wrap `dataKey` for one passkey. */
export function wrapDataKey(
  dataKey: Uint8Array,
  prfOutput: Uint8Array,
  credentialId: string,
  publicKey: string,
  now: Date = new Date(),
): WebIdentityWrap {
  const kek = deriveKeyEncryptionKey(prfOutput, credentialId);
  try {
    const { nonce, ciphertext } = encryptAead(kek, dataKey, wrapAad(publicKey, credentialId));
    return {
      credentialId,
      nonce: bytesToHex(nonce),
      wrappedKey: bytesToHex(ciphertext),
      createdAt: now.toISOString(),
    };
  } finally {
    wipeBytes(kek);
  }
}

/**
 * Seal an identity into a new envelope that opens with the given passkey.
 *
 * Returns the data key too, so the caller can add further wraps in the same
 * session; wipe it when done.
 */
export function sealWebIdentity(
  identity: Pick<OpenedWebIdentity, 'mnemonic' | 'publicKey'>,
  firstWrap: { prfOutput: Uint8Array; credentialId: string },
  now: Date = new Date(),
): { envelope: WebIdentityEnvelope; dataKey: Uint8Array } {
  const derived = deriveIdentityFromMnemonic(identity.mnemonic);
  if (derived.publicKey !== identity.publicKey.toLowerCase()) {
    throw new Error('The recovery phrase does not belong to this identity');
  }
  const dataKey = generateDataKey();
  const entropy = mnemonicToEntropy(derived.mnemonic, wordlist);
  try {
    const { nonce, ciphertext } = encryptAead(dataKey, entropy, entropyAad(derived.publicKey));
    const envelope: WebIdentityEnvelope = {
      version: WEB_IDENTITY_ENVELOPE_VERSION,
      algorithm: 'xchacha20poly1305',
      publicKey: derived.publicKey,
      entropyNonce: bytesToHex(nonce),
      sealedEntropy: bytesToHex(ciphertext),
      wraps: [wrapDataKey(dataKey, firstWrap.prfOutput, firstWrap.credentialId, derived.publicKey, now)],
    };
    return { envelope, dataKey };
  } finally {
    wipeBytes(entropy);
  }
}

/** Recover the data key with one passkey's PRF output. */
export function unwrapDataKey(
  envelope: WebIdentityEnvelope,
  prfOutput: Uint8Array,
  credentialId: string,
): Uint8Array {
  const wrap = envelope.wraps.find((entry) => entry.credentialId === credentialId);
  if (!wrap) {
    throw new WebIdentityUnlockError('unknown-credential', 'This passkey cannot open this identity');
  }
  const kek = deriveKeyEncryptionKey(prfOutput, credentialId);
  try {
    return decryptAead(kek, hexToBytes(wrap.nonce), hexToBytes(wrap.wrappedKey), wrapAad(envelope.publicKey, credentialId));
  } catch {
    throw new WebIdentityUnlockError('prf-mismatch', 'This passkey returned a different secret than when it was registered');
  } finally {
    wipeBytes(kek);
  }
}

/**
 * Open an envelope with its data key.
 *
 * The derived public key is checked against the envelope's own: a sealed entropy
 * that decrypts into a different identity is treated as corruption, never used.
 */
export function openWebIdentity(envelope: WebIdentityEnvelope, dataKey: Uint8Array): OpenedWebIdentity {
  let entropy: Uint8Array;
  try {
    entropy = decryptAead(
      dataKey,
      hexToBytes(envelope.entropyNonce),
      hexToBytes(envelope.sealedEntropy),
      entropyAad(envelope.publicKey),
    );
  } catch {
    throw new WebIdentityUnlockError('corrupt', 'The sealed identity could not be opened');
  }
  try {
    const identity = deriveIdentityFromMnemonic(entropyToMnemonic(entropy, wordlist));
    if (identity.publicKey !== envelope.publicKey.toLowerCase()) {
      throw new WebIdentityUnlockError('corrupt', 'The sealed identity does not match its public key');
    }
    return identity;
  } finally {
    wipeBytes(entropy);
  }
}

/** Unwrap and open in one step. */
export function unlockWebIdentity(
  envelope: WebIdentityEnvelope,
  prfOutput: Uint8Array,
  credentialId: string,
): OpenedWebIdentity {
  const dataKey = unwrapDataKey(envelope, prfOutput, credentialId);
  try {
    return openWebIdentity(envelope, dataKey);
  } finally {
    wipeBytes(dataKey);
  }
}

/** Add (or replace) one passkey's wrap. Requires the data key of an unlocked envelope. */
export function addWrap(
  envelope: WebIdentityEnvelope,
  dataKey: Uint8Array,
  prfOutput: Uint8Array,
  credentialId: string,
  now: Date = new Date(),
): WebIdentityEnvelope {
  // Proves `dataKey` belongs to THIS envelope before anything new can open it.
  openWebIdentity(envelope, dataKey);
  const others = envelope.wraps.filter((entry) => entry.credentialId !== credentialId);
  return {
    ...envelope,
    wraps: [...others, wrapDataKey(dataKey, prfOutput, credentialId, envelope.publicKey, now)],
  };
}

/** Remove one passkey's wrap. The last wrap can never be removed — an envelope nobody can open is a loss. */
export function removeWrap(envelope: WebIdentityEnvelope, credentialId: string): WebIdentityEnvelope {
  const remaining = envelope.wraps.filter((entry) => entry.credentialId !== credentialId);
  if (remaining.length === 0) {
    throw new Error('An identity envelope must keep at least one passkey');
  }
  return { ...envelope, wraps: remaining };
}

/**
 * The message an identity key signs to authorize an account action
 * (`link_identity`, `web_envelope_delete`, …): `JSON.stringify({ action, userId,
 * timestamp })`, byte-identical to what the API reconstructs.
 */
export function buildIdentityActionMessage(action: string, userId: string, timestamp: number): string {
  return JSON.stringify({ action, userId, timestamp });
}

/** Sign an identity-action message with an opened identity's key. */
export async function signIdentityAction(
  identity: Pick<OpenedWebIdentity, 'privateKey'>,
  action: string,
  userId: string,
  timestamp: number = Date.now(),
): Promise<{ signature: string; timestamp: number }> {
  const signature = await signMessage(buildIdentityActionMessage(action, userId, timestamp), identity.privateKey);
  return { signature, timestamp };
}

/**
 * The 6-digit short authentication string both sides of an identity transfer show.
 *
 * Bound to the pairing and to BOTH ephemeral public keys in their roles, so a relay
 * that substitutes either key produces a different code on each screen. The user
 * comparing the two codes is what makes the transfer safe against the relay itself.
 */
export function deriveTransferSas(input: {
  pairingId: string;
  initiatorEphemeralPublicKey: string;
  responderEphemeralPublicKey: string;
}): string {
  const digest = sha256(
    utf8ToBytes(
      JSON.stringify({
        v: 'oxy-identity-transfer-sas-v1',
        pairingId: input.pairingId.toLowerCase(),
        initiator: input.initiatorEphemeralPublicKey.toLowerCase(),
        responder: input.responderEphemeralPublicKey.toLowerCase(),
      }),
    ),
  );
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}
