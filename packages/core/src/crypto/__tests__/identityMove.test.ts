/**
 * Moving an identity: both sides derive the same key and code; the responder
 * receives exactly the identity that was declared; a relay that swaps a key
 * gets a different code and cannot open the identity; receipts cannot be forged.
 */

import {
  buildMoveQrPayload,
  deriveMoveKey,
  deriveMoveSas,
  generateMoveEphemeralKeyPair,
  IDENTITY_MOVE_ACTIONS,
  openMovedIdentity,
  parseMoveQrPayload,
  sealIdentityForMove,
  signMoveAction,
  verifyMoveReceipt,
} from '../identityMove';
import { generateWebIdentity } from '../webIdentityCarrier';

const MOVE_ID = '0123456789abcdef0123456789abcdef';

describe('a move between two honest carriers', () => {
  it('delivers the declared identity and both screens show the same code', () => {
    const identity = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();

    const webKey = deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID);
    const commonsKey = deriveMoveKey(commons.privateKey, web.publicKey, MOVE_ID);
    expect(Buffer.from(webKey).equals(Buffer.from(commonsKey))).toBe(true);

    expect(deriveMoveSas(MOVE_ID, web.publicKey, commons.publicKey)).toMatch(/^\d{6}$/);

    const sealed = sealIdentityForMove(identity, webKey, MOVE_ID);
    expect(JSON.stringify(sealed)).not.toContain(identity.privateKey);

    const received = openMovedIdentity(sealed, commonsKey, MOVE_ID, identity.publicKey);
    expect(received).toEqual(identity);
  });
});

describe('a relay that substitutes a key', () => {
  it('shows a different code on each screen and cannot open the identity', () => {
    const identity = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const attacker = generateMoveEphemeralKeyPair();

    // Web talks to the attacker thinking it is Commons; Commons talks to the attacker thinking it is the web.
    const webSas = deriveMoveSas(MOVE_ID, web.publicKey, attacker.publicKey);
    const commonsSas = deriveMoveSas(MOVE_ID, attacker.publicKey, commons.publicKey);
    expect(webSas).not.toBe(commonsSas);

    // Even sealed to the attacker, Commons' own key cannot open it.
    const sealedToAttacker = sealIdentityForMove(identity, deriveMoveKey(web.privateKey, attacker.publicKey, MOVE_ID), MOVE_ID);
    expect(() =>
      openMovedIdentity(sealedToAttacker, deriveMoveKey(commons.privateKey, web.publicKey, MOVE_ID), MOVE_ID, identity.publicKey),
    ).toThrow('could not be opened');
  });

  it('refuses a sealed identity that is not the one the move declared', () => {
    const declared = generateWebIdentity();
    const other = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const key = deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID);

    const sealedOther = sealIdentityForMove(other, key, MOVE_ID);
    expect(() => openMovedIdentity(sealedOther, key, MOVE_ID, declared.publicKey)).toThrow();
  });

  it('binds the ciphertext to its move id', () => {
    const identity = generateWebIdentity();
    const web = generateMoveEphemeralKeyPair();
    const commons = generateMoveEphemeralKeyPair();
    const key = deriveMoveKey(web.privateKey, commons.publicKey, MOVE_ID);
    const sealed = sealIdentityForMove(identity, key, MOVE_ID);
    expect(() => openMovedIdentity(sealed, key, 'ffffffffffffffffffffffffffffffff', identity.publicKey)).toThrow();
  });
});

describe('receipts', () => {
  it('verify only when signed by the moved identity for this move', async () => {
    const identity = generateWebIdentity();
    const receipt = await signMoveAction(identity, IDENTITY_MOVE_ACTIONS.received, MOVE_ID);

    expect(await verifyMoveReceipt(identity.publicKey, MOVE_ID, receipt)).toBe(true);
    expect(await verifyMoveReceipt(identity.publicKey, 'ffffffffffffffffffffffffffffffff', receipt)).toBe(false);
    expect(await verifyMoveReceipt(generateWebIdentity().publicKey, MOVE_ID, receipt)).toBe(false);

    const sealProof = await signMoveAction(identity, IDENTITY_MOVE_ACTIONS.seal, MOVE_ID);
    expect(await verifyMoveReceipt(identity.publicKey, MOVE_ID, sealProof)).toBe(false);
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
