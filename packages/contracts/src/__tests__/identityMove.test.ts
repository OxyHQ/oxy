import {
  IDENTITY_MOVE_QR_PREFIX,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessage,
  buildMoveSasInput,
  buildMoveSealPayload,
  identityMoveCreateRequestSchema,
  identityMoveIdSchema,
  identityMoveReceiptRequestSchema,
  identityMoveRevealRequestSchema,
  identityMoveSealRequestSchema,
  identityMoveStateSchema,
} from '../identityMove';

const KEY = `04${'a'.repeat(128)}`;
const PROOF = { v: 2, challenge: 'c'.repeat(64), expiresAt: 1, signature: 'sig' };

describe('identity move contract', () => {
  it('accepts only 128-bit lowercase hex move ids', () => {
    expect(identityMoveIdSchema.safeParse('0123456789abcdef0123456789abcdef').success).toBe(true);
    expect(identityMoveIdSchema.safeParse('0123456789ABCDEF0123456789ABCDEF').success).toBe(false);
    expect(identityMoveIdSchema.safeParse('abc').success).toBe(false);
  });

  it('creates with a commitment only — never the key it commits to', () => {
    expect(identityMoveCreateRequestSchema.safeParse({ initiatorCommitment: 'c'.repeat(64) }).success).toBe(true);
    expect(identityMoveCreateRequestSchema.safeParse({ initiatorCommitment: 'c'.repeat(64), initiatorEphemeralPublicKey: KEY }).success).toBe(false);
    expect(identityMoveCreateRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY }).success).toBe(false);
  });

  it('reveals only an uncompressed key with its nonce', () => {
    expect(identityMoveRevealRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY, commitmentNonce: 'd'.repeat(64) }).success).toBe(true);
    expect(identityMoveRevealRequestSchema.safeParse({ initiatorEphemeralPublicKey: `02${'a'.repeat(64)}`, commitmentNonce: 'd'.repeat(64) }).success).toBe(false);
    expect(identityMoveRevealRequestSchema.safeParse({ initiatorEphemeralPublicKey: KEY }).success).toBe(false);
  });

  it('seals one phrase entropy of 12 to 24 words, under a root proof and nothing weaker', () => {
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64), proof: PROOF }).success).toBe(true);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(96), proof: PROOF }).success).toBe(true);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(66), proof: PROOF }).success).toBe(false);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(24), ciphertext: 'b'.repeat(64), proof: PROOF }).success).toBe(false);
    expect(identityMoveSealRequestSchema.safeParse({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64), signature: 'sig', timestamp: 1 }).success).toBe(false);
    expect(identityMoveReceiptRequestSchema.safeParse({ signature: '' }).success).toBe(false);
    expect(identityMoveReceiptRequestSchema.safeParse({ signature: 'sig', timestamp: 1 }).success).toBe(false);
  });

  it('builds commitment, code, seal and receipt bytes that bind every field, case-insensitively', () => {
    const commitment = buildMoveCommitmentInput(KEY.toUpperCase(), 'AB'.repeat(32));
    expect(commitment).toBe(buildMoveCommitmentInput(KEY, 'ab'.repeat(32)));
    expect(commitment).not.toBe(buildMoveCommitmentInput(KEY, 'ac'.repeat(32)));
    const sas = { moveId: 'f'.repeat(32), initiatorEphemeralPublicKey: KEY, responderEphemeralPublicKey: `04${'b'.repeat(128)}`, initiatorCommitment: 'c'.repeat(64) };
    expect(buildMoveSasInput(sas)).not.toBe(buildMoveSasInput({ ...sas, initiatorCommitment: 'e'.repeat(64) }));
    const receipt = { moveId: 'f'.repeat(32), rootPublicKey: KEY, initiatorEphemeralPublicKey: KEY, responderEphemeralPublicKey: `04${'b'.repeat(128)}`, ciphertextDigest: 'd'.repeat(64) };
    expect(buildMoveReceiptMessage(receipt)).toContain('"domain":"oxy-identity-move-receipt"');
    expect(buildMoveReceiptMessage(receipt)).not.toBe(buildMoveReceiptMessage({ ...receipt, ciphertextDigest: 'e'.repeat(64) }));
    expect(buildMoveCiphertextDigestInput({ nonce: 'A'.repeat(48), ciphertext: 'B'.repeat(64) })).toBe(buildMoveCiphertextDigestInput({ nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) }));
    expect(buildMoveSealPayload('F'.repeat(32), { nonce: 'A'.repeat(48), ciphertext: 'B'.repeat(64) })).toEqual({ moveId: 'f'.repeat(32), nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) });
  });

  it('describes a state with nothing decryptable beyond the sealed payload', () => {
    const state = {
      moveId: 'f'.repeat(32),
      status: 'joined',
      initiatorCommitment: 'c'.repeat(64),
      initiatorCommitmentNonce: null,
      publicKey: KEY,
      initiatorEphemeralPublicKey: null,
      responderEphemeralPublicKey: KEY,
      nonce: null,
      ciphertext: null,
      receiptSignature: null,
      expiresAt: new Date().toISOString(),
    };
    expect(identityMoveStateSchema.safeParse(state).success).toBe(true);
    expect(identityMoveStateSchema.safeParse({ ...state, status: 'done' }).success).toBe(false);
    expect(IDENTITY_MOVE_QR_PREFIX).toBe('oxycommons://move?id=');
  });
});
