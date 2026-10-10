import {
  rotateKeyChallengeResponseSchema,
  rotateKeyCompleteRequestSchema,
  rotateKeyCompleteResponseSchema,
  safeParseContract,
} from '../index';

describe('rotateKeyChallengeResponseSchema', () => {
  it('round-trips a valid challenge response', () => {
    const payload = {
      challenge: 'rotate-challenge-abc',
      expiresAt: '2026-07-16T12:00:00.000Z',
    };
    expect(safeParseContract(rotateKeyChallengeResponseSchema, payload)).toEqual(payload);
  });

  it('rejects missing expiresAt', () => {
    expect(safeParseContract(rotateKeyChallengeResponseSchema, { challenge: 'x' })).toBeNull();
  });
});

describe('rotateKeyCompleteRequestSchema', () => {
  const validRequest = {
    newPublicKey: '02a1b2c3d4e5f60718293a4b5c6d7e8f90',
    challenge: 'rotate-challenge-abc',
    signature: 'sig-old-key',
    newKeyProof: 'sig-new-key',
    timestamp: 1_752_000_000_000,
  };

  it('round-trips a valid complete request', () => {
    expect(safeParseContract(rotateKeyCompleteRequestSchema, validRequest)).toEqual(validRequest);
  });

  it('accepts optional signOutEverywhere', () => {
    const withSignOut = { ...validRequest, signOutEverywhere: true };
    expect(safeParseContract(rotateKeyCompleteRequestSchema, withSignOut)).toEqual(withSignOut);
  });

  it('rejects empty newPublicKey', () => {
    expect(
      safeParseContract(rotateKeyCompleteRequestSchema, {
        ...validRequest,
        newPublicKey: '   ',
      }),
    ).toBeNull();
  });
});

describe('rotateKeyCompleteResponseSchema', () => {
  it('round-trips a successful rotation response', () => {
    const payload = {
      success: true,
      publicKey: '02a1b2c3d4e5f60718293a4b5c6d7e8f90',
      message: 'Key rotated successfully',
    };
    expect(safeParseContract(rotateKeyCompleteResponseSchema, payload)).toEqual(payload);
  });
});
