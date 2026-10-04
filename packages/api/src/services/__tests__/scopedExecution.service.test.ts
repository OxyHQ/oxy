import { bindScopedPermit, hashScopedInput, attestScopedPermit, scopedPermitForContext } from '../scopedExecution.service';
import type { EdgeExecutionContext } from '../inferenceEdge.service';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';

const input = { format: 'decisions' as const, decisions: { state: 'synthetic', questions: [] } };
const permit: ScopedExecutionAudience = {
  permitId: 'synthetic-permit', idempotencyKey: 'synthetic-idempotency', fixtureSha256: hashScopedInput(input),
  expiresAt: '2099-01-01T00:00:00.000Z',
  principal: { accountId: 'synthetic-account', applicationId: 'synthetic-application', credentialId: 'synthetic-credential', environment: 'production' },
  policy: { routingPolicyId: 'synthetic-policy', policyVersion: 1 }, deploymentId: 'synthetic-deployment',
  provider: 'typesafe', keyId: 'synthetic-key', modelReference: 'typesafe/jev@1.13.0', upstreamModelId: 'jev-1.13.0',
  priceVersionId: 'synthetic-price', providerRateCardVersionId: 'synthetic-card', providerSourceVersion: 'synthetic-source', maxCostUsd: '0.01',
};
const context = {
  principal: { ownerAccountId: permit.principal.accountId, applicationId: permit.principal.applicationId,
    credentialId: permit.principal.credentialId, environment: 'production', scopes: ['inference:invoke'] },
  idempotencyKey: permit.idempotencyKey,
  request: { input, stream: false, operation: { kind: 'decisions' }, target: { kind: 'model', modelReference: permit.modelReference } },
} as EdgeExecutionContext;

describe('source-bound scoped execution', () => {
  it('has no production source authorization', () => {
    expect(scopedPermitForContext(context)).toBeUndefined();
  });
  it('binds a synthetic permit only to the existing exact principal/input', () => {
    expect(bindScopedPermit(permit, context, 0)).toEqual(permit);
    expect(bindScopedPermit(permit, { ...context, principal: { ...context.principal, credentialId: 'another' } }, 0)).toBeUndefined();
    expect(bindScopedPermit(permit, { ...context, idempotencyKey: 'retry-with-new-key' }, 0)).toBeUndefined();
    expect(bindScopedPermit(permit, context, Date.parse(permit.expiresAt))).toBeUndefined();
    expect(bindScopedPermit(permit, { ...context, principal: { ...context.principal, scopes: [] } }, 0)).toBeUndefined();
  });
  it('hashes the whole wire input and rejects unsupported JSON values', () => {
    expect(hashScopedInput({ a: 1, b: [2] })).toEqual(hashScopedInput({ b: [2], a: 1 }));
    expect(hashScopedInput({ ...input, format: 'text' })).not.toEqual(permit.fixtureSha256);
    expect(() => hashScopedInput({ input: undefined })).toThrow();
  });
  it('requires negotiated echo and exact card/source/key evidence', () => {
    const evidence = { modelRevisionId: 'actual-revision', deploymentId: permit.deploymentId, priceVersionId: permit.priceVersionId,
      commercialPermission: 'platform_internal_only', permissionState: 'approved' as const, legalReviewStatus: 'approved' as const,
      legalReviewEvidenceRef: 'synthetic-reviewed-evidence', policy: permit.policy,
      eligibility: { availabilityScope: 'platform_internal', licenseId: 'synthetic-license', commercialUseAllowed: true, retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
        policyAdmitted: true as const, capabilityAdmitted: true as const, privacyAdmitted: true as const } };
    const descriptor = { ...permit, regions: [], scopedExecution: permit };
    const attestation = { snapshotId: 'actual-snapshot', scopedExecutionContractVersion: '3.6.0' as const, deployments: [descriptor] };
    const result = attestScopedPermit(permit, attestation, 'actual-request', evidence);
    expect(result?.requestId).toBe('actual-request');
    expect(result?.permitId).toBe(permit.permitId);
    expect(attestScopedPermit(permit, { ...attestation, scopedExecutionContractVersion: undefined }, 'actual-request', evidence)).toBeUndefined();
    expect(attestScopedPermit(permit, { ...attestation, deployments: [{ ...descriptor, providerSourceVersion: 'another-source' }] }, 'actual-request', evidence)).toBeUndefined();
    expect(attestScopedPermit(permit, attestation, 'actual-request', { ...evidence, legalReviewEvidenceRef: '' })).toBeUndefined();
    expect(attestScopedPermit(permit, attestation, 'actual-request', { ...evidence, priceVersionId: 'another-price' })).toBeUndefined();
  });
});

it('attests the explicit private discriminator without inventing public approval and refuses expired evidence', () => {
  const evidence = { modelRevisionId: 'synthetic-revision', deploymentId: permit.deploymentId,
    priceVersionId: permit.priceVersionId, commercialPermission: 'standard_application_use',
    admission: 'private_commissioning' as const, permissionState: 'pending_review' as const,
    deploymentStatus: 'disabled' as const, legalReviewStatus: 'approved' as const,
    legalReviewEvidenceRef: 'synthetic-specific-review', policy: permit.policy,
    eligibility: { availabilityScope: 'platform_internal', licenseId: 'synthetic-reviewed', commercialUseAllowed: true,
      retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
      policyAdmitted: true as const, capabilityAdmitted: true as const, privacyAdmitted: true as const } };
  const descriptor = { ...permit, regions: [], scopedExecution: permit };
  const attestation = { snapshotId: 'synthetic-private-snapshot', scopedExecutionContractVersion: '3.6.0' as const, deployments: [descriptor] };
  expect(attestScopedPermit(permit, attestation, 'synthetic-private-request', evidence)?.catalogueEvidenceHash).toBe(hashScopedInput(evidence));
  expect(attestScopedPermit(permit, attestation, 'synthetic-private-request', { ...evidence,
    eligibility: { ...evidence.eligibility, availabilityScope: 'public_payg' } })).toBeUndefined();
  expect(attestScopedPermit({ ...permit, expiresAt: new Date(0).toISOString() }, attestation, 'synthetic-private-request', evidence)).toBeUndefined();
});
