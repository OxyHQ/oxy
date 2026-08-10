import { authSessionCreateSchema, verifyChallengeSchema } from '../auth.schemas';

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
