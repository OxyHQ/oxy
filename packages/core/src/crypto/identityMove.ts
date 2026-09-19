/**
 * Identity move — the crypto of giving a web root to Commons (ADR 0024 D6).
 *
 * Both sides run this: the web holder (the initiator, holding the root) and
 * Commons (the responder, receiving it). The relay in between sees a commitment,
 * two ephemeral public keys and ciphertext. The initiator commits to its key
 * before the responder chooses one and reveals it only afterwards, so the 6-digit
 * code both screens show exposes a relay that substituted a key — it cannot grind
 * one until the codes agree. The receipt binds the move, the root, both keys and
 * the ciphertext actually relayed.
 *
 * PURE: no storage, no network. Contract: `@oxy.so/contracts` `identityMove`.
 */

import './polyfill';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { verifySignature } from '@oxy.so/protocol';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import {
  IDENTITY_MOVE_QR_PREFIX,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessage,
  buildMoveSasInput,
} from '@oxy.so/contracts';
import { decryptAead, encryptAead, AEAD_KEY_LENGTH } from './aead';
import { deriveSharedSecret } from './ecdh';
import { hkdfSha256 } from './kdf';
import { deriveIdentityFromMnemonic, wipeBytes, type OpenedMnemonicIdentity } from './webIdentityCarrier';

const MOVE_KDF_INFO = utf8ToBytes('oxy-identity-move-v1');

function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** A fresh ephemeral key pair for one move. Keep the private key in memory only. */
export function generateMoveEphemeralKeyPair(): { privateKey: string; publicKey: string } {
  return generateSecp256k1KeyPair();
}

/** The symmetric key both sides derive: HKDF(ECDH, salt = moveId). */
export function deriveMoveKey(ownEphemeralPrivateKey: string, otherEphemeralPublicKey: string, moveId: string): Uint8Array {
  const shared = deriveSharedSecret(ownEphemeralPrivateKey, otherEphemeralPublicKey);
  try {
    return hkdfSha256(shared, utf8ToBytes(moveId.toLowerCase()), MOVE_KDF_INFO, AEAD_KEY_LENGTH);
  } finally {
    wipeBytes(shared);
  }
}

/** Initiator: commit to the ephemeral key before anyone else's key is known. The nonce stays in memory until the reveal. */
export function createMoveCommitment(initiatorEphemeralPublicKey: string): { commitment: string; nonce: string } {
  const nonceBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = bytesToHex(nonceBytes);
  return { commitment: sha256Hex(buildMoveCommitmentInput(initiatorEphemeralPublicKey, nonce)), nonce };
}

/** Responder: does the revealed key match the commitment read before joining? */
export function verifyMoveCommitment(initiatorEphemeralPublicKey: string, nonce: string, commitment: string): boolean {
  return sha256Hex(buildMoveCommitmentInput(initiatorEphemeralPublicKey, nonce)) === commitment.toLowerCase();
}

/** The 6-digit code, bound to the move, both keys in their roles, and the commitment. */
export function deriveMoveSas(input: {
  moveId: string;
  initiatorEphemeralPublicKey: string;
  responderEphemeralPublicKey: string;
  initiatorCommitment: string;
}): string {
  const digest = sha256(utf8ToBytes(buildMoveSasInput(input)));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

/** The digest a receipt binds: what was actually relayed. */
export function digestMoveCiphertext(sealed: { nonce: string; ciphertext: string }): string {
  return sha256Hex(buildMoveCiphertextDigestInput(sealed));
}

export interface MoveReceiptClaims {
  moveId: string;
  rootPublicKey: string;
  initiatorEphemeralPublicKey: string;
  responderEphemeralPublicKey: string;
  ciphertextDigest: string;
}

/**
 * Responder: sign the receipt with a signer that reads the root back from durable
 * storage (Commons passes its keychain signer), so a receipt exists only for a
 * root that was actually stored.
 */
export async function signMoveReceipt(sign: (message: string) => Promise<string>, claims: MoveReceiptClaims): Promise<{ signature: string }> {
  return { signature: await sign(buildMoveReceiptMessage(claims)) };
}

/** Initiator: is this receipt the root's, for exactly this move and ciphertext? */
export function verifyMoveReceipt(claims: MoveReceiptClaims, signature: string): Promise<boolean> {
  return verifySignature(buildMoveReceiptMessage(claims), signature, claims.rootPublicKey);
}

function moveAad(moveId: string, publicKey: string): Uint8Array {
  return utf8ToBytes(JSON.stringify({ v: 1, purpose: 'identity-move', moveId: moveId.toLowerCase(), publicKey: publicKey.toLowerCase() }));
}

/** Initiator: seal the phrase entropy (12–24 words) for the responder. */
export function sealIdentityForMove(
  identity: Pick<OpenedMnemonicIdentity, 'mnemonic' | 'publicKey'>,
  moveKey: Uint8Array,
  moveId: string,
): { nonce: string; ciphertext: string } {
  if (typeof identity.mnemonic !== 'string' || !identity.mnemonic) {
    throw new Error('Only an identity with a recovery phrase can be moved this way');
  }
  const entropy = mnemonicToEntropy(identity.mnemonic, wordlist);
  try {
    const { nonce, ciphertext } = encryptAead(moveKey, entropy, moveAad(moveId, identity.publicKey));
    return { nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
  } finally {
    wipeBytes(entropy);
  }
}

/**
 * Responder: open the sealed identity. The derived public key must be the one
 * the move declared — anything else is refused, never imported.
 */
export function openMovedIdentity(
  sealed: { nonce: string; ciphertext: string },
  moveKey: Uint8Array,
  moveId: string,
  expectedPublicKey: string,
): OpenedMnemonicIdentity {
  let entropy: Uint8Array;
  try {
    entropy = decryptAead(moveKey, hexToBytes(sealed.nonce), hexToBytes(sealed.ciphertext), moveAad(moveId, expectedPublicKey));
  } catch {
    throw new Error('The identity could not be opened. The codes may not have matched — start again.');
  }
  try {
    const identity = deriveIdentityFromMnemonic(entropyToMnemonic(entropy, wordlist));
    if (identity.publicKey !== expectedPublicKey.toLowerCase()) {
      throw new Error('The received identity is not the one being moved');
    }
    return identity;
  } finally {
    wipeBytes(entropy);
  }
}

/** The QR payload for a move. */
export function buildMoveQrPayload(moveId: string): string {
  return `${IDENTITY_MOVE_QR_PREFIX}${moveId.toLowerCase()}`;
}

/** The move id in a scanned payload, or `null` when it is not a move QR. */
export function parseMoveQrPayload(raw: string): string | null {
  const value = raw.trim();
  if (!value.toLowerCase().startsWith(IDENTITY_MOVE_QR_PREFIX)) return null;
  const id = value.slice(IDENTITY_MOVE_QR_PREFIX.length).toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}
