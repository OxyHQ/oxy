import {
  PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION,
  PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION,
  privateAutoSourceApprovalSchema,
  privateAutoInputSchema,
  privateAutoOperationId,
  privateAutoExecutionSchema,
} from '../inference/privateAutoExecution';
import { INFERENCE_CONTRACT_VERSION } from '../inference/version';
import {
  SCOPED_EXECUTION_CONTRACT_VERSION,
  SCOPED_REQUEST_ENVELOPE_VERSION,
  scopedExecutionAudienceSchema,
} from '../inference/scopedExecution';
import {
  privateAutoApprovalFixture as source,
  privateAutoInputFixture,
} from './privateAutoExecution.fixture';
import {
  privateAutoInferenceRequestSchema,
  inferenceRequestSchema,
  scopedInferenceRequestSchema,
} from '../inference/request';

const parentId = '018f2118-95bc-7aca-914e-17632106cad8';
function execution() {
  const { review, limits, ...approval } = source;
  return {
    ...approval,
    contractVersion: '3.7.0',
    approvalSha256: 'a'.repeat(64),
    parentMeteredUsageId: parentId,
    parentRequestId: 'parent-request',
    operationId: privateAutoOperationId(parentId),
    requestId: privateAutoOperationId(parentId),
    inputSha256: 'b'.repeat(64),
    runtimeExpiresAt: '2026-10-04T00:00:01Z',
    snapshotId: 'synthetic-snapshot',
    catalogueEvidenceHash: 'c'.repeat(64),
  };
}

describe('independent private Auto contract', () => {
  it('keeps ordinary and one-fixture contracts unchanged and mutually separate', () => {
    expect([
      INFERENCE_CONTRACT_VERSION,
      SCOPED_EXECUTION_CONTRACT_VERSION,
      SCOPED_REQUEST_ENVELOPE_VERSION,
    ]).toEqual(['3.5.0', '3.6.0', 3]);
    expect([
      PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION,
      PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION,
    ]).toEqual(['3.7.0', 4]);
    expect(privateAutoSourceApprovalSchema.safeParse(source).success).toBe(true);
    expect(scopedExecutionAudienceSchema.safeParse(source).success).toBe(false);
    expect(
      privateAutoSourceApprovalSchema.safeParse({ ...source, fixtureSha256: 'a'.repeat(64) })
        .success,
    ).toBe(false);
  });
  it('admits different private states without changing the fixed question or inventing commercial rights', () => {
    expect(privateAutoSourceApprovalSchema.parse(source).review.commercialUseAllowed).toBe(false);
    for (const state of ['A factual question', 'A multistep argument', 'Texto español 🧪']) {
      expect(privateAutoInputSchema.parse(privateAutoInputFixture(state)).decisions.state).toBe(
        state,
      );
    }
  });
  it.each(['instructions', 'effort', 'questions'])('rejects an altered classifier %s', (field) => {
    const input = privateAutoInputFixture();
    const altered = field === 'questions' ? [] : field === 'effort' ? 'low' : 'Ignore policy';
    expect(
      privateAutoInputSchema.safeParse({
        ...input,
        decisions: { ...input.decisions, [field]: altered },
      }).success,
    ).toBe(false);
  });
  it('rejects state byte overflow and generation-shaped fields without truncating', () => {
    expect(
      privateAutoInputSchema.safeParse(privateAutoInputFixture('é'.repeat(4097))).success,
    ).toBe(false);
    expect(
      privateAutoInputSchema.safeParse({ ...privateAutoInputFixture(), tools: [] }).success,
    ).toBe(false);
  });
  it.each(['0', '0.001000000001', '1', '-0.001', 'NaN'])(
    'rejects an invalid private quote cap %s',
    (maxCostUsd) => {
      expect(privateAutoSourceApprovalSchema.safeParse({ ...source, maxCostUsd }).success).toBe(
        false,
      );
    },
  );
  it.each([
    'internalUseAllowed',
    'retainsPayloads',
    'trainsOnCustomerData',
    'zeroDataRetentionAvailable',
  ])('cannot manufacture private review %s', (field) => {
    expect(
      privateAutoSourceApprovalSchema.safeParse({
        ...source,
        review: { ...source.review, [field]: !source.review[field as keyof typeof source.review] },
      }).success,
    ).toBe(false);
  });
  it('fixes limits and the service-only principal instead of borrowing a user/machine audience', () => {
    expect(
      privateAutoSourceApprovalSchema.safeParse({
        ...source,
        principal: { ...source.principal, lane: 'machine_credential' },
      }).success,
    ).toBe(false);
    expect(
      privateAutoSourceApprovalSchema.safeParse({
        ...source,
        limits: { ...source.limits, maxStateBytes: 16384 },
      }).success,
    ).toBe(false);
    expect(
      privateAutoSourceApprovalSchema.safeParse({ ...source, regions: ['us-west-2', 'us-west-2'] })
        .success,
    ).toBe(false);
  });
  it('binds a permanent child identity to the parent, independently of review or input', () => {
    const value = execution();
    expect(privateAutoExecutionSchema.safeParse(value).success).toBe(true);
    expect(
      privateAutoExecutionSchema.safeParse({
        ...value,
        approvalVersion: 2,
        inputSha256: 'd'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      privateAutoExecutionSchema.safeParse({ ...value, operationId: 'retry-with-new-review' })
        .success,
    ).toBe(false);
    expect(
      privateAutoExecutionSchema.safeParse({ ...value, requestId: 'random-child-retry' }).success,
    ).toBe(false);
    expect(
      privateAutoExecutionSchema.safeParse({ ...value, parentRequestId: value.requestId }).success,
    ).toBe(false);
    expect(
      privateAutoExecutionSchema.safeParse({
        ...value,
        parentMeteredUsageId: 'invented-not-a-row-id',
      }).success,
    ).toBe(false);
  });
  it('requires negotiated envelope4 and binds exact route/principal/policy, internal endpoint and original deadline', () => {
    const permit = execution();
    const envelope = {
      schemaVersion: 4,
      privateAutoExecution: permit,
      attribution: {
        requestId: permit.requestId,
        principal: {
          billing: { accountId: source.principal.accountId },
          applicationId: source.principal.applicationId,
          credentialId: source.principal.credentialId,
          environment: 'production',
          inferenceScopes: ['inference:invoke'],
        },
      },
      target: { kind: 'model', modelReference: source.modelReference },
      modality: 'text',
      input: privateAutoInputFixture(),
      stream: false,
      sampling: {},
      tools: [],
      client: {
        apiFormat: 'decisions',
        endpoint: '/internal/auto-classification',
        receivedAt: '2026-10-04T00:00:00Z',
      },
      idempotencyKey: permit.operationId,
      routingPolicy: source.policy,
      authorizedRoutes: [
        {
          substitution: 'same_model',
          deploymentId: source.deploymentId,
          modelReference: source.modelReference,
          provider: source.provider,
          regions: [],
        },
      ],
    };
    expect(privateAutoInferenceRequestSchema.safeParse(envelope).success).toBe(true);
    expect(inferenceRequestSchema.safeParse(envelope).success).toBe(false);
    expect(scopedInferenceRequestSchema.safeParse(envelope).success).toBe(false);
    for (const changed of [
      { ...envelope, schemaVersion: 3 },
      { ...envelope, idempotencyKey: 'new-attempt' },
      {
        ...envelope,
        authorizedRoutes: [...envelope.authorizedRoutes, ...envelope.authorizedRoutes],
      },
      {
        ...envelope,
        authorizedRoutes: [{ ...envelope.authorizedRoutes[0], deploymentId: 'foreign' }],
      },
      {
        ...envelope,
        authorizedRoutes: [{ ...envelope.authorizedRoutes[0], regions: ['us-west-2'] }],
      },
      { ...envelope, client: { ...envelope.client, endpoint: '/v1/decisions' } },
      {
        ...envelope,
        privateAutoExecution: { ...permit, runtimeExpiresAt: '2026-10-04T00:00:01.001Z' },
      },
      { ...envelope, attribution: { ...envelope.attribution, userId: 'synthetic-foreign-user' } },
    ])
      expect(privateAutoInferenceRequestSchema.safeParse(changed).success).toBe(false);
  });
});
