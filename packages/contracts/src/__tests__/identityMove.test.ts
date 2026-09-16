import {
  IDENTITY_MOVE_QR_PREFIX,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessageV2,
  buildMoveSasInputV2,
  identityMoveRevealRequestSchema,
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

  it('version 2 creates with a commitment only, and reveals the key with its nonce', () => {
    expect(identityMoveCreateRequestSchema.safeParse({ protocolVersion: 2, initiatorCommitment: 'c'.repeat(64) }).success).toBe(true);
    // A version-2 create must not carry the key it is committing to.
    expect(identityMoveCreateRequestSchema.safeParse({ protocolVersion: 2, initiatorCommitment: 'c'.repeat(64), initiatorEphemeralPublicKey: KEY }).success).toBe(false);
    expect(identityMoveRevealRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY, commitmentNonce: 'd'.repeat(64) }).success).toBe(true);
    expect(identityMoveRevealRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY }).success).toBe(false);
    expect(identityMoveReceiptRequestSchema.safeParse({ v: 2, signature: 'sig' }).success).toBe(true);
  });

  it('builds commitment, SAS and receipt bytes that bind every field, case-insensitively', () => {
    const commitment = buildMoveCommitmentInput(KEY.toUpperCase(), 'AB'.repeat(32));
    expect(commitment).toBe(buildMoveCommitmentInput(KEY, 'ab'.repeat(32)));
    expect(commitment).not.toBe(buildMoveCommitmentInput(KEY, 'ac'.repeat(32)));
    const sas = { moveId: 'f'.repeat(32), initiatorEphemeralPublicKey: KEY, responderEphemeralPublicKey: `04${'b'.repeat(128)}`, initiatorCommitment: 'c'.repeat(64) };
    expect(buildMoveSasInputV2(sas)).not.toBe(buildMoveSasInputV2({ ...sas, initiatorCommitment: 'e'.repeat(64) }));
    const receipt = { moveId: 'f'.repeat(32), rootPublicKey: KEY, initiatorEphemeralPublicKey: KEY, responderEphemeralPublicKey: `04${'b'.repeat(128)}`, ciphertextDigest: 'd'.repeat(64) };
    expect(buildMoveReceiptMessageV2(receipt)).toContain('"domain":"oxy-identity-move-receipt"');
    expect(buildMoveReceiptMessageV2(receipt)).not.toBe(buildMoveReceiptMessageV2({ ...receipt, ciphertextDigest: 'e'.repeat(64) }));
    expect(buildMoveCiphertextDigestInput({ nonce: 'A'.repeat(48), ciphertext: 'B'.repeat(64) })).toBe(buildMoveCiphertextDigestInput({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) }));
  });

  it('bounds the sealed payload to one phrase entropy of 12 to 24 words', () => {
    const proof = { signature: 'sig', timestamp: 1 };
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64), ...proof }).success).toBe(true);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(96), ...proof }).success).toBe(true);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(66), ...proof }).success).toBe(false);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(98), ...proof }).success).toBe(false);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(24), ciphertext: 'b'.repeat(64), ...proof }).success).toBe(false);
    expect(identityMoveReceiptRequestSchema.safeParse({ signature: '', timestamp: 1 }).success).toBe(false);
  });

  it('describes a state with nothing decryptable beyond the sealed payload', () => {
    const state = {
      moveId: 'f'.repeat(32),
      status: 'joined',
      protocolVersion: 1,
      initiatorCommitment: null,
      initiatorCommitmentNonce: null,
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
