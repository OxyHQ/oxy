import {
  classifyHolderBearer,
  holderContextEvidence,
  type HolderContextObservation,
  type VerifiedHolderBearer,
} from '../holderContextEvidence';

function fixture() {
  const bearer = 'synthetic-bearer';
  const deviceId = 'synthetic-device';
  const expiration = new Date(Date.now() + 60_000);
  const verified: VerifiedHolderBearer = {
    token: {
      version: 2,
      subjectAccountId: 'subject',
      principalUserId: 'subject',
      sessionId: 'session',
      applicationId: null,
      clientId: null,
      deviceSessionId: 'device-session',
      deviceContextId: 'context',
      scopes: [],
    },
    payload: {
      userId: 'subject',
      sessionId: 'session',
      deviceId,
      type: 'access',
      exp: Math.floor(expiration.getTime() / 1000),
    },
  };
  const observation: HolderContextObservation = {
    inRecovery: false,
    credentialId: 'credential',
    deviceSessionId: 'device-session',
    revision: 7,
    contextId: 'context',
    actorId: 'subject',
    accountId: 'subject',
    sessionId: 'session',
    personSessionId: 'session',
    accessToken: bearer,
    sessionExpiresAt: new Date(expiration.getTime() + 60_000),
  };
  return { bearer, deviceId, verified, observation };
}

describe('holder context evidence', () => {
  it('returns only the observed v2 holder/context binding, bounded by the bearer expiry', () => {
    const { bearer, deviceId, verified, observation } = fixture();
    expect(classifyHolderBearer(verified, deviceId)).toBe('valid');
    const result = holderContextEvidence(verified, deviceId, bearer, observation);
    expect(result).toEqual({
      status: 'ok',
      evidence: {
        version: 1,
        deviceId,
        deviceSessionId: 'device-session',
        revision: 7,
        contextId: 'context',
        actorId: 'subject',
        accountId: 'subject',
        sessionId: 'session',
        expiresAt: new Date((verified.payload.exp ?? 0) * 1000).toISOString(),
      },
    });
    expect(JSON.stringify(result)).not.toContain(bearer);
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it.each([
    ['legacy bearer', { version: 1 }],
    ['OAuth application', { applicationId: 'application' }],
    ['OAuth client', { clientId: 'client' }],
    ['unbound device', { deviceSessionId: null }],
    ['unbound context', { deviceContextId: null }],
    ['delegated account', { principalUserId: 'another-person' }],
  ])('does not produce shared-device evidence for %s', (_label, patch) => {
    const { deviceId, verified } = fixture();
    expect(
      classifyHolderBearer({ ...verified, token: { ...verified.token, ...patch } }, deviceId),
    ).toBe('unsupported_bearer');
  });

  it.each([
    ['another subject', { userId: 'other' }],
    ['another session', { sessionId: 'other' }],
    ['missing expiry', { exp: undefined }],
    ['non-finite expiry', { exp: Number.POSITIVE_INFINITY }],
  ])('rejects a verified bearer with %s', (_label, patch) => {
    const { deviceId, verified } = fixture();
    expect(
      classifyHolderBearer({ ...verified, payload: { ...verified.payload, ...patch } }, deviceId),
    ).toBe('invalid_bearer');
  });

  it('treats a valid bearer for another device as an unavailable binding, not an invalid credential', () => {
    const { deviceId, verified } = fixture();
    expect(
      classifyHolderBearer(
        { ...verified, payload: { ...verified.payload, deviceId: 'other' } },
        deviceId,
      ),
    ).toBe('binding_unavailable');
  });

  it.each([
    ['holder', { credentialId: null }],
    ['device', { deviceSessionId: 'other' }],
    ['context', { contextId: 'other' }],
    ['actor', { actorId: 'other' }],
    ['subject', { accountId: 'other' }],
    ['session', { sessionId: 'other' }],
    ['principal session', { personSessionId: 'other' }],
    ['exact bearer', { accessToken: 'other-bearer' }],
    ['missing revision', { revision: null }],
  ])('does not grant evidence when the observed %s differs', (_label, patch) => {
    const { bearer, deviceId, verified, observation } = fixture();
    expect(holderContextEvidence(verified, deviceId, bearer, { ...observation, ...patch })).toEqual(
      {
        status: 'binding_unavailable',
      },
    );
  });

  it('fails closed when the writer observation is missing or is a replica', () => {
    const { bearer, deviceId, verified, observation } = fixture();
    expect(() => holderContextEvidence(verified, deviceId, bearer, undefined)).toThrow(
      'Session authority is not a writable primary',
    );
    expect(() =>
      holderContextEvidence(verified, deviceId, bearer, { ...observation, inRecovery: true }),
    ).toThrow('Session authority is not a writable primary');
  });

  it('does not issue evidence after either token or session expiry', () => {
    const { bearer, deviceId, verified, observation } = fixture();
    expect(
      holderContextEvidence(
        { ...verified, payload: { ...verified.payload, exp: Math.floor(Date.now() / 1000) - 1 } },
        deviceId,
        bearer,
        observation,
      ),
    ).toEqual({ status: 'invalid_bearer' });
    expect(
      holderContextEvidence(verified, deviceId, bearer, {
        ...observation,
        sessionExpiresAt: new Date(Date.now() - 1),
      }),
    ).toEqual({ status: 'invalid_bearer' });
  });
});
