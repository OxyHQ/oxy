import {
  NativeProductAgentStateDriftError,
  NativeProductAgentUsernameCollisionError,
  nativeProductAgentBootstrapFailureResult,
} from '../nativeProductAgentBootstrapFailure';

describe('native product-agent bootstrap failure projection', () => {
  const expectedAccountId = '01a0646a-078f-7000-8000-000000000001';
  const unsafeMarker = 'must-not-cross-the-result-boundary';
  const holder = {
    id: '6a50444ce8026582b9490001',
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
  const boundApplication = {
    id: '6a2f851751b784a86fd0e922',
    ownerAccountId: holder.id,
    type: 'first_party' as const,
    status: 'active' as const,
    isOfficial: true,
    isInternal: false,
    createdByUserId: '69b2d3df5d12f58c9800d651',
    name: unsafeMarker,
    webhookSecret: unsafeMarker,
  };

  it('returns only the reviewed holder projection and explicit expected account id', () => {
    const result = nativeProductAgentBootstrapFailureResult(
      new NativeProductAgentUsernameCollisionError(
        expectedAccountId,
        holder,
        boundApplication,
      ),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'username_collision',
      expectedAccountId,
      holder: {
        id: holder.id,
        kind: 'project',
        type: 'local',
        parentAccountId: '69b2d3df5d12f58c9800d651',
        rootAccountId: '69b2d3df5d12f58c9800d651',
        accountStatus: 'active',
        privacyIsPrivateAccount: false,
      },
      boundApplication: {
        id: '6a2f851751b784a86fd0e922',
        ownerAccountId: holder.id,
        type: 'first_party',
        status: 'active',
        isOfficial: true,
        isInternal: false,
        createdByUserId: '69b2d3df5d12f58c9800d651',
      },
    });
    expect(JSON.stringify(result)).not.toContain(unsafeMarker);
  });

  it('projects only an allowlisted drift target and field', () => {
    const result = nativeProductAgentBootstrapFailureResult(
      new NativeProductAgentStateDriftError('homiio_project_ancestry', 'path'),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'live_state_drift',
      target: 'homiio_project_ancestry',
      field: 'path',
    });
    expect(JSON.stringify(result)).not.toContain(unsafeMarker);
  });

  it('reports an absent bound application without inferring one', () => {
    const result = nativeProductAgentBootstrapFailureResult(
      new NativeProductAgentUsernameCollisionError(expectedAccountId, holder),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'username_collision',
      expectedAccountId,
      holder: {
        id: '6a50444ce8026582b9490001',
        kind: 'project',
        type: 'local',
        parentAccountId: '69b2d3df5d12f58c9800d651',
        rootAccountId: '69b2d3df5d12f58c9800d651',
        accountStatus: 'active',
        privacyIsPrivateAccount: false,
      },
      boundApplication: null,
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
