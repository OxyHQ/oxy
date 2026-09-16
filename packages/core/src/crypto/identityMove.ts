/**
 * Identity move — the crypto of taking a web identity into Commons.
 *
 * Both carriers run this: `id.oxy.so` (the initiator, holding the identity) and
 * Commons (the responder, receiving it). The relay in between sees two ephemeral
 * public keys and ciphertext; the 6-digit SAS both screens show is what makes a
 * relay that swapped a key visible to the person.
 *
 * PURE: no storage, no network. Contract: `@oxy.so/contracts` `identityMove`.
 */

import './polyfill';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { signMessage, verifySignature } from '@oxy.so/protocol';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import {
  IDENTITY_MOVE_QR_PREFIX,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessageV2,
  buildMoveSasInputV2,
} from '@oxy.so/contracts';
import { sha256 } from '@noble/hashes/sha256';
import { decryptAead, encryptAead, AEAD_KEY_LENGTH } from './aead';
import { deriveSharedSecret } from './ecdh';
import { hkdfSha256 } from './kdf';
import { deriveIdentityFromMnemonic, deriveTransferSas, wipeBytes, type OpenedMnemonicIdentity } from './webIdentityCarrier';

const MOVE_KDF_INFO = utf8ToBytes('oxy-identity-move-v1');

/** Actions the identity key signs during a move. */
export const IDENTITY_MOVE_ACTIONS = {
  seal: 'identity_move_seal',
  received: 'identity_move_received',
} as const;

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

function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/**
 * Version 2, initiator: commit to the ephemeral key before anyone else's key is
 * known. The nonce stays in memory until the reveal.
 */
export function createMoveCommitment(initiatorEphemeralPublicKey: string): { commitment: string; nonce: string } {
  const nonceBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = bytesToHex(nonceBytes);
  return { commitment: sha256Hex(buildMoveCommitmentInput(initiatorEphemeralPublicKey, nonce)), nonce };
}

/** Version 2, responder: does the revealed key match the commitment read before joining? */
export function verifyMoveCommitment(initiatorEphemeralPublicKey: string, nonce: string, commitment: string): boolean {
  return sha256Hex(buildMoveCommitmentInput(initiatorEphemeralPublicKey, nonce)) === commitment.toLowerCase();
}

/** Version 2: the 6-digit code, bound to the move, both keys in their roles, and the commitment. */
export function deriveMoveSasV2(input: {
  moveId: string;
  initiatorEphemeralPublicKey: string;
  responderEphemeralPublicKey: string;
  initiatorCommitment: string;
}): string {
  const digest = sha256(utf8ToBytes(buildMoveSasInputV2(input)));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

/** The digest a version-2 receipt binds: what was actually relayed. */
export function digestMoveCiphertext(sealed: { nonce: string; ciphertext: string }): string {
  return sha256Hex(buildMoveCiphertextDigestInput(sealed));
}

export interface MoveReceiptV2Claims {
  moveId: string;
  rootPublicKey: string;
  initiatorEphemeralPublicKey: string;
  responderEphemeralPublicKey: string;
  ciphertextDigest: string;
}

/**
 * Version 2, responder: sign the receipt with a signer that reads the root back
 * from durable storage (Commons passes its keychain signer), so a receipt exists
 * only for a root that was actually stored.
 */
export async function signMoveReceiptV2(sign: (message: string) => Promise<string>, claims: MoveReceiptV2Claims): Promise<{ v: 2; signature: string }> {
  return { v: 2, signature: await sign(buildMoveReceiptMessageV2(claims)) };
}

/** Version 2, initiator: is this receipt the root's, for exactly this move and ciphertext? */
export function verifyMoveReceiptV2(claims: MoveReceiptV2Claims, signature: string): Promise<boolean> {
  return verifySignature(buildMoveReceiptMessageV2(claims), signature, claims.rootPublicKey);
}

/** The 6-digit code both screens show, bound to the move and both ephemeral keys in their roles. */
export function deriveMoveSas(moveId: string, initiatorEphemeralPublicKey: string, responderEphemeralPublicKey: string): string {
  return deriveTransferSas({ pairingId: moveId, initiatorEphemeralPublicKey, responderEphemeralPublicKey });
}

function moveAad(moveId: string, publicKey: string): Uint8Array {
  return utf8ToBytes(JSON.stringify({ v: 1, purpose: 'identity-move', moveId: moveId.toLowerCase(), publicKey: publicKey.toLowerCase() }));
}

/** Initiator: seal the identity's entropy for the responder. */
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

/** The exact bytes a move proof or receipt signs. */
export function buildMoveMessage(action: string, moveId: string, timestamp: number): string {
  return JSON.stringify({ action, moveId: moveId.toLowerCase(), timestamp });
}

/** Sign a move action with the identity key. */
export async function signMoveAction(
  identity: { privateKey: string },
  action: string,
  moveId: string,
  timestamp: number = Date.now(),
): Promise<{ signature: string; timestamp: number }> {
  return { signature: await signMessage(buildMoveMessage(action, moveId, timestamp), identity.privateKey), timestamp };
}

/**
 * Initiator: is this receipt really from the identity? Checked locally with the
 * identity's public key, so a server that claims "completed" without Commons
 * having the key cannot make the web destroy its copy.
 */
export function verifyMoveReceipt(publicKey: string, moveId: string, receipt: { signature: string; timestamp: number }): Promise<boolean> {
  return verifySignature(buildMoveMessage(IDENTITY_MOVE_ACTIONS.received, moveId, receipt.timestamp), receipt.signature, publicKey);
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
