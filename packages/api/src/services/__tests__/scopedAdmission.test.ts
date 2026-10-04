import { ALIA_INFERENCE_CONSUMER_APPLICATION_ID } from '../../config/inferenceEconomicPolicy';
jest.mock('../../config/postgres', () => ({ getDb: jest.fn(() => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) })) }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import * as scope from '../scopedExecution.service';
import * as catalogue from '../inferenceCatalogue.service';
import * as policies from '../inferenceRoutingPolicy.service';
import * as ledger from '../inferenceLedger.service';
import * as flags from '../../config/rolloutFlags';
import * as telemetry from '../inferenceTelemetry.service';
import * as metered from '../inferenceMeteredUsage.service';
import { buildEnvelope, admitRequest, PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY, type EdgeExecutionContext } from '../inferenceEdge.service';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';

const context: EdgeExecutionContext = {
  requestId: 'req-synthetic-scoped', receivedAt: 1, apiFormat: 'decisions', endpoint: '/v1/decisions',
  signal: new AbortController().signal, idempotencyKey: 'synthetic-key',
  principal: { lane: 'service_token', ownerAccountId: 'synthetic-account', applicationId: 'synthetic-app',
    credentialId: 'synthetic-credential', environment: 'production', scopes: ['inference:invoke'], applicationType: 'internal', applicationIsInternal: true },
  request: { operation: { kind: 'decisions' }, target: { kind: 'model', modelReference: 'typesafe/jev@fixture-v1' },
    input: { format: 'decisions', decisions: { state: 'SYNTHETIC', questions: [{ kind: 'noul', id: 'q', question: 'Synthetic?' }] } },
    stream: false, sampling: {}, tools: [] },
};
const permit: ScopedExecutionAudience = {
  permitId: 'synthetic-permit', idempotencyKey: context.idempotencyKey!, fixtureSha256: scope.hashScopedInput(context.request.input),
  expiresAt: '2099-01-01T00:00:00.000Z', principal: { accountId: 'synthetic-account', applicationId: 'synthetic-app', credentialId: 'synthetic-credential', environment: 'production' },
  policy: PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY, deploymentId: 'synthetic-deployment', provider: 'typesafe', keyId: 'synthetic-provider-key',
  modelReference: 'typesafe/jev@fixture-v1', upstreamModelId: 'jev-1.13.0', priceVersionId: 'synthetic-price',
  providerRateCardVersionId: 'synthetic-card', providerSourceVersion: 'synthetic-source', maxCostUsd: '0.01',
};
const route: catalogue.EdgeRoute = {
  deploymentId: permit.deploymentId, routingScore: 1, fundingPriority: 3, modelReference: permit.modelReference,
  provider: permit.provider, regions: [], availabilityScope: 'platform_internal', priceVersionId: permit.priceVersionId,
  maxContextTokens: 32768, maxOutputTokens: 8192, inputModalities: ['text'], outputModalities: ['text'], reasoning: false,
  reasoningEfforts: [], acceptedParameters: null, apiFormats: ['decisions'],
  scopedCatalogueEvidence: { modelRevisionId: 'actual-synthetic-revision', deploymentId: permit.deploymentId, priceVersionId: permit.priceVersionId,
    commercialPermission: 'standard_application_use', permissionState: 'approved', legalReviewStatus: 'approved', legalReviewEvidenceRef: 'synthetic-reviewed',
    eligibility: { availabilityScope: 'platform_internal', licenseId: 'synthetic-license', commercialUseAllowed: true, retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
      policyAdmitted: true, capabilityAdmitted: true, privacyAdmitted: true } },
};
const attestation = { snapshotId: 'synthetic-snapshot', scopedExecutionContractVersion: '3.6.0' as const,
  deployments: [{ ...permit, scopedExecution: permit, regions: [] }] };
const hold: ledger.ReservationView = { reservationId: 'exact-synthetic-hold', billingAccountId: 'synthetic-account', reservedAmount: '0.001', currency: 'USD', expiresAt: new Date('2099-01-01') };

beforeEach(() => {
  jest.spyOn(scope, 'scopedPermitForContext').mockReturnValue(permit);
  jest.spyOn(flags, 'isChargingAuthorized').mockReturnValue(true);
  jest.spyOn(policies, 'resolveEffectiveRoutingPolicy').mockResolvedValue({ status: 'unknown-application', applicationId: context.principal.applicationId });
  jest.spyOn(catalogue, 'resolveEdgeRoute').mockResolvedValue({ status: 'resolved', route, alternates: [] });
  jest.spyOn(ledger, 'publishedUnitPrice').mockResolvedValue('zero');
  jest.spyOn(ledger, 'quoteUnits').mockResolvedValue({ status: 'quoted', amount: '0.001', currency: 'USD' });
  jest.spyOn(ledger, 'reserve').mockResolvedValue({ status: 'reserved', reservation: hold, softStopsPassed: [] });
  jest.spyOn(telemetry, 'recordInferenceUsage').mockResolvedValue(undefined);
  // This qualification suite stubs the DB; durable metering is verified by
  // the real-Postgres internal-metered route and metering-service suites.
  jest.spyOn(metered, 'claimMeteredAdmission').mockResolvedValue({ status: 'claimed', meteredUsageId: 'synthetic-metered' });
  jest.spyOn(metered, 'settleMeteredUsage').mockResolvedValue({ status: 'not-admitted' });
});
afterEach(() => jest.restoreAllMocks());
const client = () => ({ attestDeployments: jest.fn().mockResolvedValue(attestation), execute: jest.fn(), stream: jest.fn() });

it('uses normal qualification then explicit attestation and one exact promotional hold', async () => {
  const kaanaClient = client();
  const result = await admitRequest({ ...context, kaanaClient });
  expect(result.status).toBe('admitted');
  if (result.status !== 'admitted') throw new Error(JSON.stringify(result));
  expect(result.admitted.hold).toBe(hold);
  expect(result.admitted.scopedExecution).toMatchObject({ requestId: context.requestId, permitId: permit.permitId, snapshotId: 'synthetic-snapshot' });
  expect(ledger.reserve).toHaveBeenCalledTimes(1);
  expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ fundingRestriction: 'promotional-only', ceilingPriceVersionId: permit.priceVersionId, maxAmount: '0.001' }));
  expect(kaanaClient.attestDeployments).toHaveBeenCalledWith([permit.deploymentId], expect.objectContaining({ scopedExecutionContractVersion: '3.6.0' }));
  expect(catalogue.resolveEdgeRoute).toHaveBeenCalledWith(expect.anything(), permit.modelReference, expect.anything(), expect.objectContaining({ requiresDeclaredApiFormat: true }), expect.anything(), expect.anything(), expect.objectContaining({ scopedExecution: permit }));
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it.each(['missing-echo', 'wrong-card', 'missing-rights', 'missing-privacy', 'over-cost', 'charging-off'] as const)('refuses %s before any reservation or executor', async (failure) => {
  const kaanaClient = client();
  if (failure === 'missing-echo') kaanaClient.attestDeployments.mockResolvedValue({ ...attestation, scopedExecutionContractVersion: undefined });
  if (failure === 'wrong-card') kaanaClient.attestDeployments.mockResolvedValue({ ...attestation, deployments: [{ ...attestation.deployments[0], providerRateCardVersionId: 'wrong-card' }] });
  if (failure === 'missing-rights') jest.mocked(catalogue.resolveEdgeRoute).mockResolvedValue({ status: 'resolved', route: { ...route, scopedCatalogueEvidence: undefined }, alternates: [] });
  if (failure === 'missing-privacy') jest.mocked(catalogue.resolveEdgeRoute).mockResolvedValue({ status: 'policy-excluded', modelReference: permit.modelReference, constraints: ['requireZeroDataRetention'] });
  if (failure === 'over-cost') jest.mocked(ledger.quoteUnits).mockResolvedValue({ status: 'quoted', amount: '0.02', currency: 'USD' });
  if (failure === 'charging-off') jest.mocked(flags.isChargingAuthorized).mockReturnValue(false);
  expect((await admitRequest({ ...context, kaanaClient })).status).toBe('refused');
  expect(ledger.reserve).not.toHaveBeenCalled();
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it('never borrows an already reserved hold', async () => {
  const kaanaClient = client();
  jest.mocked(ledger.reserve).mockResolvedValue({ status: 'already-reserved', reservation: hold });
  expect(await admitRequest({ ...context, kaanaClient })).toMatchObject({ status: 'refused', error: { code: 'idempotency_conflict' } });
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});

it('canonicalizes the actual admitted envelope, including optional undefined input fields', async () => {
  const { kaanaEnvelopeBytes } = await import('../httpKaanaClient');
  const { canonicalScopedExecutionJson } = await import('@oxy.so/contracts');
  const kaanaClient = client();
  const result = await admitRequest({ ...context, kaanaClient });
  if (result.status !== 'admitted') throw new Error('Expected a synthetic admitted request');
  const envelope = buildEnvelope({ ...context, kaanaClient }, result.admitted, false);
  expect(envelope.schemaVersion).toBe(3);
  const wire = kaanaEnvelopeBytes(envelope).toString('utf8');
  const parsed = JSON.parse(wire);
  expect(wire).toBe(canonicalScopedExecutionJson(parsed));
  expect(wire).toContain('"input":' + canonicalScopedExecutionJson(parsed.input));
  expect(scope.hashScopedInput(parsed.input)).toBe(permit.fixtureSha256);
  expect(parsed.scopedExecution.requestId).toBe(context.requestId);
  expect(parsed.scopedExecution.permitId).toBe(permit.permitId);
});
it.each(['capability-unsupported', 'capacity-unavailable', 'unknown-model'] as const)('cannot use a permit to widen %s', async (status) => {
  const kaanaClient = client();
  jest.mocked(catalogue.resolveEdgeRoute).mockResolvedValue({ status, modelReference: permit.modelReference,
    required: { input: 'text', output: 'text' }, outputLimitExceeded: true, contextLimitExceeded: true } as catalogue.EdgeRouteResolution);
  expect((await admitRequest({ ...context, kaanaClient })).status).toBe('refused');
  expect(ledger.reserve).not.toHaveBeenCalled();
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});


it('admits exact scoped decisions through the actual Alia internal pilot without a monetary hold', async () => {
  const principal = { ...context.principal, applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID };
  const audience = { ...permit, principal: { ...permit.principal, applicationId: principal.applicationId } };
  jest.mocked(scope.scopedPermitForContext).mockReturnValue(audience);
  jest.mocked(flags.isChargingAuthorized).mockReturnValue(false);
  jest.mocked(catalogue.resolveEdgeRoute).mockResolvedValue({ status: 'resolved', alternates: [], route: {
    ...route, scopedCatalogueEvidence: { ...route.scopedCatalogueEvidence!, permissionState: 'pending_review',
      admission: 'private_commissioning', deploymentStatus: 'disabled' },
  } });
  const kaanaClient = client();
  kaanaClient.attestDeployments.mockResolvedValue({ ...attestation, deployments: [{ ...audience, scopedExecution: audience, regions: [] }] });
  const result = await admitRequest({ ...context, principal, kaanaClient });
  expect(result.status).toBe('admitted');
  if (result.status !== 'admitted') throw new Error(JSON.stringify(result));
  expect(result.admitted.scopedExecution?.permitId).toBe(audience.permitId);
  expect(metered.claimMeteredAdmission).toHaveBeenCalledTimes(1);
  expect(ledger.reserve).not.toHaveBeenCalled();
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});

it('keeps the internal input ceiling before quote, reservation, metering or provider execution', async () => {
  const principal = { ...context.principal, applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID };
  const input = { format: 'decisions' as const, decisions: { state: 'x'.repeat(8193), questions: [{ kind: 'noul' as const, id: 'q', question: 'Synthetic?' }] } };
  jest.mocked(scope.scopedPermitForContext).mockReturnValue({ ...permit, fixtureSha256: scope.hashScopedInput(input),
    principal: { ...permit.principal, applicationId: principal.applicationId } });
  const kaanaClient = client();
  const result = await admitRequest({ ...context, principal, request: { ...context.request, input }, kaanaClient });
  expect(result).toMatchObject({ status: 'refused', error: { code: 'context_length_exceeded' } });
  expect(ledger.quoteUnits).not.toHaveBeenCalled();
  expect(metered.claimMeteredAdmission).not.toHaveBeenCalled();
  expect(ledger.reserve).not.toHaveBeenCalled();
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
