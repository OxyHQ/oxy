import {
  authSessionCreateSchema,
  verifyChallengeSchema,
  workloadServiceTokenSchema,
} from '../auth.schemas';

describe('public authentication device binding', () => {
  it('strips deviceId from signed-challenge verification input', () => {
    const parsed = verifyChallengeSchema.parse({
      publicKey: 'public-key',
      challenge: 'challenge',
      signature: 'signature',
      timestamp: Date.now(),
      deviceId: 'victim-device',
    });

    expect(parsed).not.toHaveProperty('deviceId');
  });

  it('strips deviceId from unauthenticated QR session creation input', () => {
    const parsed = authSessionCreateSchema.parse({
      sessionToken: 'secret-session-token',
      clientId: 'client-id',
      deviceId: 'victim-device',
    });

    expect(parsed).not.toHaveProperty('deviceId');
  });
});

describe('workload protocol retirement boundary', () => {
  const proof = {
    provider: 'aws-iam',
    nonce: 'synthetic-challenge',
    attestation: { signed: 'opaque' },
  };
  it('accepts only explicit protocol 2 without application scopes', () => {
    expect(workloadServiceTokenSchema.safeParse({ ...proof, protocolVersion: 2 }).success).toBe(
      true,
    );
    for (const protocolVersion of [undefined, 1]) {
      expect(workloadServiceTokenSchema.safeParse({ ...proof, protocolVersion }).success).toBe(
        false,
      );
    }
    for (const scopes of [[], ['files:read']]) {
      expect(
        workloadServiceTokenSchema.safeParse({ ...proof, protocolVersion: 2, scopes }).success,
      ).toBe(false);
    }
  });
});
