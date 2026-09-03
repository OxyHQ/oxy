import {
  NativeProductAgentUsernameCollisionError,
  nativeProductAgentBootstrapFailureResult,
} from '../nativeProductAgentBootstrapFailure';

describe('native product-agent bootstrap failure projection', () => {
  const expectedAccountId = '01a0646a-078f-72ea-8759-86326484a7e0';
  const unsafeMarker = 'must-not-cross-the-result-boundary';
  const holder = {
    id: '6a50444ce8026582b949089d',
    kind: 'project' as const,
    type: 'local' as const,
    parentAccountId: '69b2d3df5d12f58c9800d651',
    rootAccountId: '69b2d3df5d12f58c9800d651',
    accountStatus: 'active' as const,
    privacyIsPrivateAccount: false,
    email: unsafeMarker,
    nameDisplay: unsafeMarker,
    secretHash: unsafeMarker,
  };

  it('returns only the reviewed holder projection and explicit expected account id', () => {
    const result = nativeProductAgentBootstrapFailureResult(
      new NativeProductAgentUsernameCollisionError(expectedAccountId, holder),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'username_collision',
      expectedAccountId,
      holder: {
        id: '6a50444ce8026582b949089d',
        kind: 'project',
        type: 'local',
        parentAccountId: '69b2d3df5d12f58c9800d651',
        rootAccountId: '69b2d3df5d12f58c9800d651',
        accountStatus: 'active',
        privacyIsPrivateAccount: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(unsafeMarker);
  });

  it.each([
    [
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
      'database_unavailable',
    ],
    [
      new Error('EXPECTED_OXY_ORGANIZATION_ID does not match this image'),
      'manifest_binding_mismatch',
    ],
    [new Error('EXPECTED_PLAN_SHA256 mismatch'), 'plan_rejected'],
    [
      new Error('Sindi service credential secret hash is malformed'),
      'service_credential_invalid',
    ],
    [new Error('Client-id collision'), 'identity_collision'],
    [new Error('Existing Homiio application was not found'), 'required_record_missing'],
    [new Error('Account kind drifted'), 'live_state_drift'],
    [new Error(unsafeMarker), 'bootstrap_failed'],
    [new Error('Username collision for sindi'), 'identity_collision'],
  ])('classifies %p without returning its message', (error, expectedCode) => {
    const result = nativeProductAgentBootstrapFailureResult(error);

    expect(result).toEqual({ status: 'failed', code: expectedCode });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});
