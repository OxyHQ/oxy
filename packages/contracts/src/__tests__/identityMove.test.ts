import {
  IDENTITY_MOVE_QR_PREFIX,
  identityMoveCreateRequestSchema,
  identityMoveIdSchema,
  identityMoveReceiptRequestSchema,
  identityMoveSealRequestSchema,
  identityMoveStateSchema,
} from '../identityMove';

const KEY = `04${'a'.repeat(128)}`;

describe('identity move contract', () => {
  it('accepts only 128-bit lowercase hex move ids', () => {
    expect(identityMoveIdSchema.safeParse('0123456789abcdef0123456789abcdef').success).toBe(true);
    expect(identityMoveIdSchema.safeParse('0123456789ABCDEF0123456789ABCDEF').success).toBe(false);
    expect(identityMoveIdSchema.safeParse('abc').success).toBe(false);
  });

  it('accepts only uncompressed ephemeral keys', () => {
    expect(identityMoveCreateRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY }).success).toBe(true);
    expect(identityMoveCreateRequestSchema.safeParse({ initiatorEphemeralPublicKey: `02${'a'.repeat(64)}` }).success).toBe(false);
  });

  it('bounds the sealed payload to exactly one 16-byte entropy', () => {
    const proof = { signature: 'sig', timestamp: 1 };
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64), ...proof }).success).toBe(true);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(66), ...proof }).success).toBe(false);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(24), ciphertext: 'b'.repeat(64), ...proof }).success).toBe(false);
    expect(identityMoveReceiptRequestSchema.safeParse({ signature: '', timestamp: 1 }).success).toBe(false);
  });

  it('describes a state with nothing decryptable beyond the sealed payload', () => {
    const state = {
      moveId: 'f'.repeat(32),
      status: 'joined',
      publicKey: KEY,
      initiatorEphemeralPublicKey: KEY,
      responderEphemeralPublicKey: KEY,
      nonce: null,
      ciphertext: null,
      receiptSignature: null,
      receiptTimestamp: null,
      expiresAt: new Date().toISOString(),
    };
    expect(identityMoveStateSchema.safeParse(state).success).toBe(true);
    expect(identityMoveStateSchema.safeParse({ ...state, status: 'done' }).success).toBe(false);
    expect(IDENTITY_MOVE_QR_PREFIX).toBe('oxycommons://move?id=');
  });
});
