/**
 * Identity transfer protocol version 2 (ADR 0024 D6, #1302).
 *
 * Version 1's 6-digit code was derived from two public keys the relay saw before
 * it had to commit to anything, so an active relay could substitute keys on both
 * sides and grind one of its own keys until both codes agreed. The first test
 * DEMONSTRATES that on version 1 (with a bounded search); the rest show version
 * 2's commitment removes the relay's freedom and the receipt binds what was sent.
 */

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import { signMessage } from '@oxy.so/protocol';
import {
  createMoveCommitment,
  deriveMoveKey,
  deriveMoveSas,
  deriveMoveSasV2,
  digestMoveCiphertext,
  openMovedIdentity,
  sealIdentityForMove,
  signMoveReceiptV2,
  verifyMoveCommitment,
  verifyMoveReceiptV2,
} from '../identityMove';
import { deriveIdentityFromMnemonic, generateWebIdentity } from '../webIdentityCarrier';

const MOVE_ID = '0123456789abcdef0123456789abcdef';

describe('why version 1 had to change', () => {
  it('lets a relay that sees both public keys first steer the two codes together', () => {
    const web = generateSecp256k1KeyPair();
    const commons = generateSecp256k1KeyPair();
    // The relay shows Commons its own "initiator" key, learns Commons' key, and
    // grinds the "responder" key it shows the web until the codes agree. The
    // search is bounded here so the test stays fast: it asks for 2 of 6 digits.
    const relayToCommons = generateSecp256k1KeyPair();
    const commonsCode = deriveMoveSas(MOVE_ID, relayToCommons.publicKey, commons.publicKey);
    let found: string | null = null;
    for (let attempt = 0; attempt < 5_000 && !found; attempt += 1) {
      const candidate = generateSecp256k1KeyPair();
      if (deriveMoveSas(MOVE_ID, web.publicKey, candidate.publicKey).slice(0, 2) === commonsCode.slice(0, 2)) found = candidate.publicKey;
    }
    expect(found).not.toBeNull();
  });
});

describe('version 2 commitment', () => {
  it('binds the revealed key to the commitment Commons read before joining', () => {
    const web = generateSecp256k1KeyPair();
    const { commitment, nonce } = createMoveCommitment(web.publicKey);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMoveCommitment(web.publicKey, nonce, commitment)).toBe(true);
    expect(verifyMoveCommitment(generateSecp256k1KeyPair().publicKey, nonce, commitment)).toBe(false);
    expect(verifyMoveCommitment(web.publicKey, 'ab'.repeat(32), commitment)).toBe(false);
  });

  it('derives the same code on both honest sides, and a different one when any input differs', () => {
    const web = generateSecp256k1KeyPair();
    const commons = generateSecp256k1KeyPair();
    const { commitment } = createMoveCommitment(web.publicKey);
    const input = { moveId: MOVE_ID, initiatorEphemeralPublicKey: web.publicKey, responderEphemeralPublicKey: commons.publicKey, initiatorCommitment: commitment };
    const code = deriveMoveSasV2(input);
    expect(code).toMatch(/^\d{6}$/);
    expect(deriveMoveSasV2({ ...input, moveId: MOVE_ID.toUpperCase() })).toBe(code);
    expect(deriveMoveSasV2({ ...input, initiatorCommitment: createMoveCommitment(web.publicKey).commitment })).not.toBe(code);
    expect(deriveMoveSasV2({ ...input, responderEphemeralPublicKey: generateSecp256k1KeyPair().publicKey })).not.toBe(code);
  });
});

describe('version 2 receipt', () => {
  async function honestTransfer(words = 12) {
    const identity = deriveIdentityFromMnemonic(
      words === 24
        ? 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
        : generateWebIdentity().mnemonic,
    );
    const web = generateSecp256k1KeyPair();
    const commons = generateSecp256k1KeyPair();
    const sealed = sealIdentityForMove(identity, deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID), MOVE_ID);
    const received = openMovedIdentity(sealed, deriveMoveKey(commons.privateKey, web.publicKey, MOVE_ID), MOVE_ID, identity.publicKey);
    const claims = {
      moveId: MOVE_ID,
      rootPublicKey: identity.publicKey,
      initiatorEphemeralPublicKey: web.publicKey,
      responderEphemeralPublicKey: commons.publicKey,
      ciphertextDigest: digestMoveCiphertext(sealed),
    };
    return { identity, received, sealed, claims };
  }

  it('moves 24-word phrases too', async () => {
    const { identity, received } = await honestTransfer(24);
    expect(received.mnemonic).toBe(identity.mnemonic);
  });

  it('verifies for exactly the move, root, keys and ciphertext it was made over', async () => {
    const { received, sealed, claims } = await honestTransfer();
    const receipt = await signMoveReceiptV2((message) => signMessage(message, received.privateKey), claims);
    expect(receipt.v).toBe(2);
    expect(await verifyMoveReceiptV2(claims, receipt.signature)).toBe(true);

    const other = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}00` };
    for (const changed of [
      { ...claims, moveId: 'ffffffffffffffffffffffffffffffff' },
      { ...claims, responderEphemeralPublicKey: generateSecp256k1KeyPair().publicKey },
      { ...claims, initiatorEphemeralPublicKey: generateSecp256k1KeyPair().publicKey },
      { ...claims, ciphertextDigest: digestMoveCiphertext(other) },
    ]) {
      expect(await verifyMoveReceiptV2(changed, receipt.signature)).toBe(false);
    }
  });

  it('is not the root’s if another key signed it', async () => {
    const { claims } = await honestTransfer();
    const forged = await signMoveReceiptV2((message) => signMessage(message, generateWebIdentity().privateKey), claims);
    expect(await verifyMoveReceiptV2(claims, forged.signature)).toBe(false);
  });
});
