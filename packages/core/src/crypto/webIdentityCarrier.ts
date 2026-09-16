/**
 * Web identity carrier — the crypto of "one identity, two carriers".
 *
 * An Oxy root is usually a BIP-39 mnemonic whose seed's first 32 bytes are the
 * secp256k1 key (`recoveryPhrase.ts`), and for a few imported identities a raw
 * private key with no phrase. Commons keeps it in the device keychain. This
 * module lets a browser hold the SAME root without Oxy ever being able to use it:
 *
 *   secret  ──AEAD(DEK)──▶ sealed secret        (v1: 12-word entropy; v2: entropy or raw key)
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
  type WebIdentityEnvelopeVersion,
  type WebIdentitySecretKind,
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

/** HKDF salt of the key-encryption-key schedule. Shared by envelope versions 1 and 2. */
const KEK_SALT = utf8ToBytes('oxy-web-identity-carrier/kek/v1');

/** A WebAuthn PRF output is 32 bytes (HMAC-SHA-256). Nothing shorter or longer is usable. */
export const WEB_IDENTITY_PRF_OUTPUT_LENGTH = 32;

/** Why an envelope did not open. Every value is a normal outcome a UI can explain. */
export type WebIdentityUnlockFailure =
  /** The passkey used is not one of the envelope's wraps. */
  | 'unknown-credential'
  /**
   * The passkey IS listed but its PRF output does not open its wrap — a synced
   * copy returning a different PRF value, or a provider that silently changed it.
   * Recoverable with another passkey or the recovery material.
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

/** A root that came from a BIP-39 phrase (12–24 words). Hold it for one operation, then wipe. */
export interface OpenedMnemonicIdentity {
  kind: 'mnemonic';
  mnemonic: string;
  /** 32-byte secp256k1 private key, lowercase hex (`seed[0:32]`). */
  privateKey: string;
  /** Uncompressed SEC1 public key, lowercase hex (Oxy's canonical form). */
  publicKey: string;
}

/**
 * A root that was imported as a raw private key and never had a phrase. It has
 * no mnemonic, and nothing may ever derive or display one for it (ADR 0024 D5).
 */
export interface OpenedRawKeyIdentity {
  kind: 'raw-key';
  mnemonic: null;
  privateKey: string;
  publicKey: string;
}

/** The identity in usable form. Hold it for one operation, then wipe it. */
export type OpenedWebIdentity = OpenedMnemonicIdentity | OpenedRawKeyIdentity;

/** Material a person can recover a root from. */
export type WebIdentityRecoveryMaterial =
  | { kind: 'mnemonic'; mnemonic: string }
  | { kind: 'raw-key'; privateKey: string };

function aadFor(parts: Record<string, string | number | null>): Uint8Array {
  return utf8ToBytes(JSON.stringify(parts));
}

/** Version-1 AAD: byte-identical to what every existing v1 envelope was sealed with. */
function entropyAadV1(publicKey: string): Uint8Array {
  return aadFor({ v: 1, purpose: 'entropy', publicKey });
}

function wrapAadV1(publicKey: string, credentialId: string): Uint8Array {
  return aadFor({ v: 1, purpose: 'wrap', publicKey, credentialId });
}

function secretAadV2(publicKey: string, secretKind: WebIdentitySecretKind): Uint8Array {
  return aadFor({ v: 2, purpose: 'secret', secretKind, publicKey });
}

function wrapAadV2(publicKey: string, credentialId: string, rpId: string | null): Uint8Array {
  return aadFor({ v: 2, purpose: 'wrap', publicKey, credentialId, rpId });
}

function wrapAad(envelope: Pick<WebIdentityEnvelope, 'version' | 'publicKey'>, credentialId: string, rpId: string | null): Uint8Array {
  return envelope.version === 1
    ? wrapAadV1(envelope.publicKey, credentialId)
    : wrapAadV2(envelope.publicKey, credentialId, rpId);
}

/** Overwrite a buffer holding secret material. Best effort — JS gives no stronger guarantee. */
export function wipeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Best-effort removal of secret strings from an opened identity. */
export function wipeOpenedIdentity(identity: OpenedWebIdentity): void {
  (identity as { privateKey: string }).privateKey = '';
  if (identity.kind === 'mnemonic') (identity as { mnemonic: string }).mnemonic = '';
}

/** Normalize a typed phrase: trimmed, lowercase, single spaces. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
}

/**
 * Derive the identity from a mnemonic exactly as Commons does
 * (`RecoveryPhraseService`): seed → first 32 bytes → secp256k1. Any standard
 * BIP-39 length (12, 15, 18, 21, 24 words) is accepted; the derivation does not
 * depend on the length.
 */
export function deriveIdentityFromMnemonic(mnemonic: string): OpenedMnemonicIdentity {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error('Invalid recovery phrase');
  }
  const seed = mnemonicToSeedSync(normalized);
  const privateKeyBytes = seed.slice(0, 32);
  wipeBytes(seed);
  const privateKey = bytesToHex(privateKeyBytes);
  wipeBytes(privateKeyBytes);
  return { kind: 'mnemonic', mnemonic: normalized, privateKey, publicKey: deriveSecp256k1PublicKey(privateKey) };
}

/** A raw 32-byte private key (hex, optional `0x`) as an identity. Never gains a phrase. */
export function deriveIdentityFromPrivateKey(privateKey: string): OpenedRawKeyIdentity {
  const normalized = privateKey.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Invalid private key');
  }
  let publicKey: string;
  try {
    publicKey = deriveSecp256k1PublicKey(normalized);
  } catch {
    throw new Error('Invalid private key');
  }
  return { kind: 'raw-key', mnemonic: null, privateKey: normalized, publicKey };
}

/**
 * Read what a person typed as recovery material: a BIP-39 phrase, or a 64-hex
 * private key. Throws `Invalid recovery material` for anything else.
 */
export function parseRecoveryMaterial(input: string): WebIdentityRecoveryMaterial {
  const trimmed = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) return { kind: 'raw-key', privateKey: trimmed };
  const words = normalizeMnemonic(trimmed);
  if (words && validateMnemonic(words, wordlist)) return { kind: 'mnemonic', mnemonic: words };
  throw new Error('Invalid recovery material');
}

/** Derive the identity recovery material names. */
export function deriveIdentityFromRecoveryMaterial(material: WebIdentityRecoveryMaterial): OpenedWebIdentity {
  return material.kind === 'mnemonic'
    ? deriveIdentityFromMnemonic(material.mnemonic)
    : deriveIdentityFromPrivateKey(material.privateKey);
}

/** A brand-new 12-word identity. Nothing is persisted. */
export function generateWebIdentity(): OpenedMnemonicIdentity {
  return deriveIdentityFromMnemonic(generateMnemonic(wordlist, 128));
}

/** A fresh random data key for a new envelope. */
export function generateDataKey(): Uint8Array {
  const key = new Uint8Array(AEAD_KEY_LENGTH);
  globalThis.crypto.getRandomValues(key);
  return key;
}

/** Whether `bytes` is a usable PRF output: exactly 32 bytes. */
export function isUsablePrfOutput(bytes: Uint8Array | null | undefined): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.byteLength === WEB_IDENTITY_PRF_OUTPUT_LENGTH;
}

/** The key-encryption key a passkey's PRF output yields for its own wrap. */
export function deriveKeyEncryptionKey(prfOutput: Uint8Array, credentialId: string): Uint8Array {
  if (prfOutput.length !== WEB_IDENTITY_PRF_OUTPUT_LENGTH) {
    throw new Error(`PRF output must be ${WEB_IDENTITY_PRF_OUTPUT_LENGTH} bytes, got ${prfOutput.length}`);
  }
  return hkdfSha256(prfOutput, KEK_SALT, utf8ToBytes(credentialId), AEAD_KEY_LENGTH);
}

/** One passkey's contribution to an envelope. */
export interface WrapInput {
  prfOutput: Uint8Array;
  credentialId: string;
  /** The RP ID the passkey lives under. Bound into version-2 wraps; recorded on every wrap. */
  rpId?: string;
  /** Set when this PRF output came from a ceremony separate from the one that created the wrap. */
  verifiedAt?: string;
}

function wrapFor(
  envelope: Pick<WebIdentityEnvelope, 'version' | 'publicKey'>,
  dataKey: Uint8Array,
  input: WrapInput,
  now: Date,
): WebIdentityWrap {
  const kek = deriveKeyEncryptionKey(input.prfOutput, input.credentialId);
  try {
    const { nonce, ciphertext } = encryptAead(kek, dataKey, wrapAad(envelope, input.credentialId, input.rpId ?? null));
    return {
      credentialId: input.credentialId,
      nonce: bytesToHex(nonce),
      wrappedKey: bytesToHex(ciphertext),
      createdAt: now.toISOString(),
      ...(input.rpId ? { rpId: input.rpId } : {}),
      ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
    };
  } finally {
    wipeBytes(kek);
  }
}

/**
 * Wrap `dataKey` for one passkey of a version-1 envelope.
 *
 * @deprecated Kept for version-1 callers; use {@link addWrap}.
 */
export function wrapDataKey(
  dataKey: Uint8Array,
  prfOutput: Uint8Array,
  credentialId: string,
  publicKey: string,
  now: Date = new Date(),
): WebIdentityWrap {
  return wrapFor({ version: 1, publicKey }, dataKey, { prfOutput, credentialId }, now);
}

function secretOf(identity: OpenedWebIdentity): { kind: WebIdentitySecretKind; bytes: Uint8Array } {
  if (identity.kind === 'mnemonic') {
    return { kind: 'mnemonic-entropy', bytes: mnemonicToEntropy(identity.mnemonic, wordlist) };
  }
  return { kind: 'raw-private-key', bytes: hexToBytes(identity.privateKey) };
}

/**
 * Seal an identity into a new envelope that opens with the given passkey.
 *
 * `version` defaults to {@link WEB_IDENTITY_ENVELOPE_VERSION}. Version 1 can only
 * carry a 12-word phrase; anything else needs version 2.
 *
 * Returns the data key too, so the caller can add further wraps in the same
 * session; wipe it when done.
 */
export function sealWebIdentity(
  identity: OpenedWebIdentity | Pick<OpenedMnemonicIdentity, 'mnemonic' | 'publicKey'>,
  firstWrap: WrapInput,
  now: Date = new Date(),
  options: { version?: WebIdentityEnvelopeVersion } = {},
): { envelope: WebIdentityEnvelope; dataKey: Uint8Array } {
  const derived: OpenedWebIdentity =
    'kind' in identity && identity.kind === 'raw-key'
      ? deriveIdentityFromPrivateKey(identity.privateKey)
      : deriveIdentityFromMnemonic((identity as { mnemonic: string }).mnemonic);
  if (derived.publicKey !== identity.publicKey.toLowerCase()) {
    throw new Error('The recovery material does not belong to this identity');
  }
  const version = options.version ?? WEB_IDENTITY_ENVELOPE_VERSION;
  const secret = secretOf(derived);
  wipeOpenedIdentity(derived);
  const dataKey = generateDataKey();
  try {
    if (version === 1) {
      if (secret.kind !== 'mnemonic-entropy' || secret.bytes.length !== 16) {
        wipeBytes(dataKey);
        throw new Error('A version-1 envelope carries only a 12-word phrase');
      }
      const { nonce, ciphertext } = encryptAead(dataKey, secret.bytes, entropyAadV1(identity.publicKey.toLowerCase()));
      const base = { version: 1 as const, publicKey: identity.publicKey.toLowerCase() };
      const envelope: WebIdentityEnvelope = {
        ...base,
        algorithm: 'xchacha20poly1305',
        entropyNonce: bytesToHex(nonce),
        sealedEntropy: bytesToHex(ciphertext),
        wraps: [wrapFor(base, dataKey, firstWrap, now)],
      };
      return { envelope, dataKey };
    }
    const publicKey = identity.publicKey.toLowerCase();
    const { nonce, ciphertext } = encryptAead(dataKey, secret.bytes, secretAadV2(publicKey, secret.kind));
    const base = { version: 2 as const, publicKey };
    const envelope: WebIdentityEnvelope = {
      ...base,
      algorithm: 'xchacha20poly1305',
      secretKind: secret.kind,
      secretNonce: bytesToHex(nonce),
      sealedSecret: bytesToHex(ciphertext),
      wraps: [wrapFor(base, dataKey, firstWrap, now)],
    };
    return { envelope, dataKey };
  } finally {
    wipeBytes(secret.bytes);
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
    return decryptAead(kek, hexToBytes(wrap.nonce), hexToBytes(wrap.wrappedKey), wrapAad(envelope, credentialId, wrap.rpId ?? null));
  } catch {
    throw new WebIdentityUnlockError('prf-mismatch', 'This passkey returned a different secret than when it was registered');
  } finally {
    wipeBytes(kek);
  }
}

/**
 * Open an envelope with its data key.
 *
 * The derived public key is checked against the envelope's own: a sealed secret
 * that decrypts into a different identity is treated as corruption, never used.
 */
export function openWebIdentity(envelope: WebIdentityEnvelope, dataKey: Uint8Array): OpenedWebIdentity {
  const publicKey = envelope.publicKey.toLowerCase();
  let secret: Uint8Array;
  let kind: WebIdentitySecretKind;
  try {
    if (envelope.version === 1) {
      kind = 'mnemonic-entropy';
      secret = decryptAead(dataKey, hexToBytes(envelope.entropyNonce), hexToBytes(envelope.sealedEntropy), entropyAadV1(envelope.publicKey));
    } else {
      kind = envelope.secretKind;
      secret = decryptAead(dataKey, hexToBytes(envelope.secretNonce), hexToBytes(envelope.sealedSecret), secretAadV2(envelope.publicKey, envelope.secretKind));
    }
  } catch {
    throw new WebIdentityUnlockError('corrupt', 'The sealed identity could not be opened');
  }
  try {
    let identity: OpenedWebIdentity;
    try {
      identity =
        kind === 'mnemonic-entropy'
          ? deriveIdentityFromMnemonic(entropyToMnemonic(secret, wordlist))
          : deriveIdentityFromPrivateKey(bytesToHex(secret));
    } catch {
      throw new WebIdentityUnlockError('corrupt', 'The sealed identity is malformed');
    }
    if (identity.publicKey !== publicKey) {
      wipeOpenedIdentity(identity);
      throw new WebIdentityUnlockError('corrupt', 'The sealed identity does not match its public key');
    }
    return identity;
  } finally {
    wipeBytes(secret);
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

/**
 * Add (or replace) one passkey's wrap. Requires the data key of an unlocked
 * envelope. Accepts the legacy positional form `(envelope, dataKey, prfOutput,
 * credentialId, now)` as well as a {@link WrapInput}.
 */
export function addWrap(
  envelope: WebIdentityEnvelope,
  dataKey: Uint8Array,
  input: WrapInput | Uint8Array,
  credentialIdOrNow?: string | Date,
  maybeNow?: Date,
): WebIdentityEnvelope {
  const wrapInput: WrapInput =
    input instanceof Uint8Array ? { prfOutput: input, credentialId: credentialIdOrNow as string } : input;
  const now = (input instanceof Uint8Array ? maybeNow : (credentialIdOrNow as Date | undefined)) ?? new Date();
  // Proves `dataKey` belongs to THIS envelope before anything new can open it.
  wipeOpenedIdentity(openWebIdentity(envelope, dataKey));
  const others = envelope.wraps.filter((entry) => entry.credentialId !== wrapInput.credentialId);
  return {
    ...envelope,
    wraps: [...others, wrapFor(envelope, dataKey, wrapInput, now)],
  } as WebIdentityEnvelope;
}

/**
 * Record that a wrap's passkey opened the envelope in a ceremony of its own. The
 * AEAD does not cover `verifiedAt`; it is holder metadata the owner writes with a
 * root proof, not a cryptographic claim.
 */
export function markWrapVerified(envelope: WebIdentityEnvelope, credentialId: string, now: Date = new Date()): WebIdentityEnvelope {
  if (!envelope.wraps.some((entry) => entry.credentialId === credentialId)) {
    throw new WebIdentityUnlockError('unknown-credential', 'This passkey cannot open this identity');
  }
  return {
    ...envelope,
    wraps: envelope.wraps.map((entry) =>
      entry.credentialId === credentialId ? { ...entry, verifiedAt: now.toISOString() } : entry,
    ),
  } as WebIdentityEnvelope;
}

/** Remove one passkey's wrap. The last wrap can never be removed — an envelope nobody can open is a loss. */
export function removeWrap(envelope: WebIdentityEnvelope, credentialId: string): WebIdentityEnvelope {
  const remaining = envelope.wraps.filter((entry) => entry.credentialId !== credentialId);
  if (remaining.length === 0) {
    throw new Error('An identity envelope must keep at least one passkey');
  }
  return { ...envelope, wraps: remaining } as WebIdentityEnvelope;
}

/**
 * The version-1 message an identity key signed to authorize an account action:
 * `JSON.stringify({ action, userId, timestamp })`. It binds no payload, revision
 * or one-use challenge, and the web-envelope routes no longer accept it.
 *
 * @deprecated Use `signIdentityProof` (ADR 0024 D7). Removed in the next major.
 */
export function buildIdentityActionMessage(action: string, userId: string, timestamp: number): string {
  return JSON.stringify({ action, userId, timestamp });
}

/**
 * Sign a version-1 identity-action message.
 *
 * @deprecated Use `signIdentityProof` (ADR 0024 D7). Removed in the next major.
 */
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
