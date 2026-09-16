/**
 * Giving a root to Commons (ADR 0024 D6): both sides derive the same key and code;
 * the responder receives exactly the declared identity; the initiator's key is
 * committed before the responder's is chosen, so a relay cannot steer both codes
 * together; and the receipt binds the move, root, both keys and the relayed
 * ciphertext.
 */

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import { signMessage } from '@oxy.so/protocol';
import {
  buildMoveQrPayload,
  createMoveCommitment,
  deriveMoveKey,
  deriveMoveSas,
  digestMoveCiphertext,
  generateMoveEphemeralKeyPair,
  openMovedIdentity,
  parseMoveQrPayload,
  sealIdentityForMove,
  signMoveReceipt,
  verifyMoveCommitment,
  verifyMoveReceipt,
} from '../identityMove';
import { deriveIdentityFromMnemonic, generateWebIdentity } from '../webIdentityCarrier';

const MOVE_ID = '0123456789abcdef0123456789abcdef';
const MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

function code(initiator: string, responder: string, commitment: string, moveId = MOVE_ID): string {
  return deriveMoveSas({ moveId, initiatorEphemeralPublicKey: initiator, responderEphemeralPublicKey: responder, initiatorCommitment: commitment });
}

describe('a move between two honest sides', () => {
  it('delivers the declared identity — 12 or 24 words — and both screens show the same code', () => {
    for (const identity of [generateWebIdentity(), deriveIdentityFromMnemonic(MNEMONIC_24)]) {
      const web = generateMoveEphemeralKeyPair();
      const commons = generateMoveEphemeralKeyPair();
      const { commitment, nonce } = createMoveCommitment(web.publicKey);
      expect(verifyMoveCommitment(web.publicKey, nonce, commitment)).toBe(true);

      const webKey = deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID);
      const commonsKey = deriveMoveKey(commons.privateKey, web.publicKey, MOVE_ID);
      expect(Buffer.from(webKey).equals(Buffer.from(commonsKey))).toBe(true);
      expect(code(web.publicKey, commons.publicKey, commitment)).toMatch(/^\d{6}$/);
      expect(code(web.publicKey, commons.publicKey, commitment, MOVE_ID.toUpperCase())).toBe(code(web.publicKey, commons.publicKey, commitment));

      const sealed = sealIdentityForMove(identity, webKey, MOVE_ID);
      expect(JSON.stringify(sealed)).not.toContain(identity.privateKey);
      expect(openMovedIdentity(sealed, commonsKey, MOVE_ID, identity.publicKey)).toEqual(identity);
    }
  });
});

describe('a relay that substitutes keys', () => {
  it('cannot reveal a key the commitment does not open', () => {
    const web = generateSecp256k1KeyPair();
    const { commitment, nonce } = createMoveCommitment(web.publicKey);
    expect(verifyMoveCommitment(generateSecp256k1KeyPair().publicKey, nonce, commitment)).toBe(false);
    expect(verifyMoveCommitment(web.publicKey, 'ab'.repeat(32), commitment)).toBe(false);
  });

  it('shows a different code on each screen and cannot open the identity', () => {
    const identity = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const attacker = generateMoveEphemeralKeyPair();
    const { commitment } = createMoveCommitment(web.publicKey);
    const attackerCommitment = createMoveCommitment(attacker.publicKey).commitment;

    expect(code(web.publicKey, attacker.publicKey, commitment)).not.toBe(code(attacker.publicKey, commons.publicKey, attackerCommitment));

    const sealedToAttacker = sealIdentityForMove(identity, deriveMoveKey(web.privateKey, attacker.publicKey, MOVE_ID), MOVE_ID);
    expect(() =>
      openMovedIdentity(sealedToAttacker, deriveMoveKey(commons.privateKey, web.publicKey, MOVE_ID), MOVE_ID, identity.publicKey),
    ).toThrow('could not be opened');
  });

  it('changes the code when any input changes, including the commitment', () => {
    const web = generateSecp256k1KeyPair();
    const commons = generateSecp256k1KeyPair();
    const { commitment } = createMoveCommitment(web.publicKey);
    const base = code(web.publicKey, commons.publicKey, commitment);
    expect(code(web.publicKey, commons.publicKey, createMoveCommitment(web.publicKey).commitment)).not.toBe(base);
    expect(code(web.publicKey, generateSecp256k1KeyPair().publicKey, commitment)).not.toBe(base);
    expect(code(commons.publicKey, web.publicKey, commitment)).not.toBe(base);
  });

  it('refuses a sealed identity that is not the one the move declared, or another move’s ciphertext', () => {
    const declared = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const key = deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID);
    expect(() => openMovedIdentity(sealIdentityForMove(generateWebIdentity(), key, MOVE_ID), key, MOVE_ID, declared.publicKey)).toThrow();
    expect(() => openMovedIdentity(sealIdentityForMove(declared, key, MOVE_ID), key, 'ffffffffffffffffffffffffffffffff', declared.publicKey)).toThrow();
  });
});

describe('receipts', () => {
  function transfer() {
    const identity = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const sealed = sealIdentityForMove(identity, deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID), MOVE_ID);
    const claims = {
      moveId: MOVE_ID,
      rootPublicKey: identity.publicKey,
      initiatorEphemeralPublicKey: web.publicKey,
      responderEphemeralPublicKey: commons.publicKey,
      ciphertextDigest: digestMoveCiphertext(sealed),
    };
    return { identity, sealed, claims };
  }

  it('verify for exactly the move, root, keys and ciphertext they were made over', async () => {
    const { identity, sealed, claims } = transfer();
    const receipt = await signMoveReceipt((message) => signMessage(message, identity.privateKey), claims);
    expect(await verifyMoveReceipt(claims, receipt.signature)).toBe(true);

    const other = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}00` };
    for (const changed of [
      { ...claims, moveId: 'ffffffffffffffffffffffffffffffff' },
      { ...claims, responderEphemeralPublicKey: generateSecp256k1KeyPair().publicKey },
      { ...claims, initiatorEphemeralPublicKey: generateSecp256k1KeyPair().publicKey },
      { ...claims, ciphertextDigest: digestMoveCiphertext(other) },
    ]) {
      expect(await verifyMoveReceipt(changed, receipt.signature)).toBe(false);
    }
  });

  it('are not the root’s if another key signed them', async () => {
    const { claims } = transfer();
    const forged = await signMoveReceipt((message) => signMessage(message, generateWebIdentity().privateKey), claims);
    expect(await verifyMoveReceipt(claims, forged.signature)).toBe(false);
  });
});

describe('QR payload', () => {
  it('round-trips and rejects anything else', () => {
    expect(parseMoveQrPayload(buildMoveQrPayload(MOVE_ID))).toBe(MOVE_ID);
    expect(parseMoveQrPayload(`  ${buildMoveQrPayload(MOVE_ID).toUpperCase()} `)).toBe(MOVE_ID);
    expect(parseMoveQrPayload('oxycommons://approve?code=abc')).toBeNull();
    expect(parseMoveQrPayload('oxycommons://move?id=123')).toBeNull();
  });
});
