import { privateAutoOperationId } from '@oxy.so/contracts';
import {
  privateAutoApprovalFixture,
  privateAutoInputFixture,
} from '../../../../contracts/src/__tests__/privateAutoExecution.fixture';
import { reviewedPrivateAutoApproval } from '../../config/privateAutoClassification';
import { decisionAvailability } from '../../config/decisionAvailability';
import {
  bindPrivateAutoExecution,
  privateAutoHash,
  privateAutoRecoveryIdentity,
  type PrivateAutoParentAdmission,
  type PrivateAutoChildBinding,
} from '../privateAutoExecution.service';

const now = Date.parse('2026-10-04T00:00:00Z');
const approval = privateAutoApprovalFixture;
const parent: PrivateAutoParentAdmission = {
  id: '018f2118-95bc-7aca-914e-17632106cad8',
  requestId: 'synthetic-parent-request',
  parentRequestId: null,
  accountId: approval.principal.accountId,
  applicationId: approval.principal.applicationId,
  applicationCredentialId: approval.principal.credentialId,
  delegatedUserId: null,
  environment: 'production',
  economicTreatment: 'internal_metered',
  economicPolicyVersion: approval.economicPolicyVersion,
  economicRelationshipId: approval.economicRelationshipId,
  status: 'admitted',
  expiresAt: new Date(now + 60_000),
  finalAuthorizedDeploymentId: null,
};
function binding(state = 'synthetic task'): PrivateAutoChildBinding {
  return {
    parentMeteredUsageId: parent.id,
    parentRequestId: parent.requestId,
    requestId: privateAutoOperationId(parent.id),
    principal: {
      lane: 'service_token',
      applicationId: parent.applicationId,
      credentialId: parent.applicationCredentialId,
      ownerAccountId: parent.accountId,
      environment: 'production',
      scopes: ['inference:invoke', 'inference:usage:read'],
      applicationType: 'internal',
      applicationIsInternal: true,
    },
    policy: approval.policy,
    input: privateAutoInputFixture(state),
    deadlineAt: now + 1000,
    signal: new AbortController().signal,
  };
}
const attestation = {
  contractVersion: '3.7.0',
  snapshotId: 'synthetic-snapshot',
  approval,
  catalogueEvidenceHash: 'c'.repeat(64),
};

describe('source-bound variable private Auto admission', () => {
  it('keeps ordinary/public decisions inactive and refuses absent private approval', () => {
    expect(decisionAvailability().available).toBe(false);
    expect(
      bindPrivateAutoExecution(undefined, parent, binding(), attestation, now),
    ).toBeUndefined();
  });
  it('binds different exact child input hashes to the same non-reusable parent operation identity', () => {
    const a = bindPrivateAutoExecution(
      approval,
      parent,
      binding('first synthetic private text'),
      attestation,
      now,
    );
    const b = bindPrivateAutoExecution(
      approval,
      parent,
      binding('another private text'),
      attestation,
      now,
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.operationId).toBe(b?.operationId);
    expect(a?.inputSha256).not.toBe(b?.inputSha256);
    expect(a?.inputSha256).toBe(privateAutoHash(binding('first synthetic private text').input));
  });
  it.each([
    'accountId',
    'applicationId',
    'applicationCredentialId',
    'environment',
    'economicPolicyVersion',
    'economicRelationshipId',
  ] as const)('refuses foreign parent %s', (field) => {
    expect(
      bindPrivateAutoExecution(
        approval,
        { ...parent, [field]: 'foreign' },
        binding(),
        attestation,
        now,
      ),
    ).toBeUndefined();
  });
  it('rejects absent, expired, settled, nested or already finally authorized parent', () => {
    for (const value of [
      undefined,
      { ...parent, expiresAt: new Date(now) },
      { ...parent, status: 'settled' },
      { ...parent, parentRequestId: 'another-parent' },
      { ...parent, finalAuthorizedDeploymentId: 'generation' },
    ]) {
      expect(
        bindPrivateAutoExecution(approval, value, binding(), attestation, now),
      ).toBeUndefined();
    }
  });
  it('refuses expired reviews, changed attestation, policy, source principal and cancellation', () => {
    expect(
      reviewedPrivateAutoApproval({ ...approval, expiresAt: new Date(now).toISOString() }, now),
    ).toBeUndefined();
    expect(
      reviewedPrivateAutoApproval(
        {
          ...approval,
          review: { ...approval.review, evidenceExpiresAt: new Date(now + 1000).toISOString() },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        binding(),
        { ...attestation, approval: { ...approval, keyId: 'changed' } },
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), policy: { ...approval.policy, policyVersion: 2 } },
        attestation,
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), principal: { ...binding().principal, lane: 'machine_credential' } },
        attestation,
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), signal: AbortSignal.abort() },
        attestation,
        now,
      ),
    ).toBeUndefined();
  });
  it('enforces full controlled input bytes, without silently truncating state', () => {
    expect(
      bindPrivateAutoExecution(approval, parent, binding('x'.repeat(8192)), attestation, now),
    ).toBeUndefined();
  });
  it('retains the original absolute deadline and never starts an expired classifier', () => {
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), deadlineAt: now },
        attestation,
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), deadlineAt: now + 1001 },
        attestation,
        now,
      ),
    ).toBeUndefined();
    const permit = bindPrivateAutoExecution(
      approval,
      parent,
      { ...binding(), deadlineAt: now + 500 },
      attestation,
      now,
    );
    expect(permit?.runtimeExpiresAt).toBe(new Date(now + 500).toISOString());
    expect(permit?.expiresAt).toBe(approval.expiresAt);
  });
  it('refuses delegated parent or child in admission and settled recovery', () => {
    expect(
      bindPrivateAutoExecution(
        approval,
        { ...parent, delegatedUserId: 'synthetic-user' },
        binding(),
        attestation,
        now,
      ),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(
        approval,
        parent,
        { ...binding(), delegatedUserId: 'synthetic-user' },
        attestation,
        now,
      ),
    ).toBeUndefined();
    expect(
      privateAutoRecoveryIdentity(
        { ...parent, status: 'settled', delegatedUserId: 'synthetic-user' },
        binding(),
      ),
    ).toBeUndefined();
    expect(
      privateAutoRecoveryIdentity(parent, { ...binding(), delegatedUserId: 'synthetic-user' }),
    ).toBeUndefined();
  });
  it('allows only read-only original-child recovery after settlement/expiry, with current own read authority', () => {
    const settled = {
      ...parent,
      status: 'settled',
      expiresAt: new Date(now - 1),
      finalAuthorizedDeploymentId: 'final',
    };
    expect(privateAutoRecoveryIdentity(settled, binding())).toEqual({
      requestId: binding().requestId,
      parentRequestId: parent.requestId,
    });
    expect(
      privateAutoRecoveryIdentity(settled, {
        ...binding(),
        principal: { ...binding().principal, scopes: ['inference:invoke'] },
      }),
    ).toBeUndefined();
    expect(
      privateAutoRecoveryIdentity(settled, { ...binding(), requestId: 'new-child' }),
    ).toBeUndefined();
    expect(
      bindPrivateAutoExecution(approval, settled, binding(), attestation, now),
    ).toBeUndefined();
  });
});
