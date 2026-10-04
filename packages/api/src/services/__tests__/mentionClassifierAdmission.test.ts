import * as approvalConfig from '../../config/mentionClassifierEconomics';
import * as mentionEconomics from '../mentionClassifierEconomics.service';
import * as availability from '../../config/decisionAvailability';
import * as publication from '../kaanaDeploymentPublication.service';
jest.mock('../../config/postgres', () => ({ getDb: jest.fn(() => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) })) }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import * as scope from '../scopedExecution.service';
import * as catalogue from '../inferenceCatalogue.service';
import * as policies from '../inferenceRoutingPolicy.service';
import * as ledger from '../inferenceLedger.service';
import * as flags from '../../config/rolloutFlags';
import * as telemetry from '../inferenceTelemetry.service';
import * as metered from '../inferenceMeteredUsage.service';
import { executeInferenceRequest, admitRequest, PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY, type EdgeExecutionContext } from '../inferenceEdge.service';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';

const context: EdgeExecutionContext = {
  requestId: 'req-synthetic-scoped', receivedAt: 1, apiFormat: 'decisions', endpoint: '/v1/decisions',
  signal: new AbortController().signal, idempotencyKey: 'synthetic-key',
  principal: { ...approvalConfig.MENTION_CLASSIFIER_IDENTITY, lane: 'service_token', environment: 'production', scopes: ['inference:invoke', 'inference:usage:read'], applicationType: 'first_party', applicationIsInternal: false },
  request: { operation: { kind: 'decisions' }, target: { kind: 'model', modelReference: 'typesafe/jev@fixture-v1' },
    input: { format: 'decisions', decisions: { state: 'SYNTHETIC', questions: [{ kind: 'noul', id: 'q', question: 'Synthetic?' }] } },
    stream: false, sampling: {}, tools: [] },
};
const permit: ScopedExecutionAudience = {
  permitId: 'synthetic-permit', idempotencyKey: context.idempotencyKey!, fixtureSha256: scope.hashScopedInput(context.request.input),
  expiresAt: '2099-01-01T00:00:00.000Z', principal: { accountId: 'synthetic-account', applicationId: 'synthetic-app', credentialId: 'synthetic-credential', environment: 'production' },
  policy: PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY, deploymentId: 'synthetic-deployment', provider: 'openrouter', keyId: 'synthetic-provider-key',
  modelReference: 'typesafe/jev@fixture-v1', upstreamModelId: 'jev-1.13.0', priceVersionId: 'synthetic-price',
  providerRateCardVersionId: 'synthetic-card', providerSourceVersion: 'synthetic-source', maxCostUsd: '0.01',
};
const route: catalogue.EdgeRoute = {
  deploymentId: permit.deploymentId, routingScore: 1, fundingPriority: 3, modelReference: permit.modelReference,
  provider: permit.provider, regions: [], availabilityScope: 'public', priceVersionId: permit.priceVersionId,
  maxContextTokens: 32768, maxOutputTokens: 8192, inputModalities: ['text'], outputModalities: ['decisions'], reasoning: false,
  reasoningEfforts: [], acceptedParameters: null, apiFormats: ['decisions'],
  scopedCatalogueEvidence: { modelRevisionId: 'actual-synthetic-revision', deploymentId: permit.deploymentId, priceVersionId: permit.priceVersionId,
    commercialPermission: 'standard_application_use', permissionState: 'approved', legalReviewStatus: 'approved', legalReviewEvidenceRef: 'synthetic-reviewed',
    eligibility: { availabilityScope: 'public', licenseId: 'synthetic-license', commercialUseAllowed: true, retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
      policyAdmitted: true, capabilityAdmitted: true, privacyAdmitted: true } },
};
const attestation = { snapshotId: 'synthetic-snapshot', scopedExecutionContractVersion: '3.6.0' as const,
  deployments: [{ ...permit, scopedExecution: permit, regions: [] }] };
const approval: approvalConfig.MentionClassifierApproval = { economicPolicyVersion: 'mention/synthetic-v1', evidenceRef: 'synthetic review',
  expiresAt: permit.expiresAt, deploymentId: permit.deploymentId, modelReference: permit.modelReference, provider: 'openrouter',
  priceVersionId: permit.priceVersionId, routingPolicyId: permit.policy.routingPolicyId, routingPolicyVersion: permit.policy.policyVersion };
const hold: ledger.ReservationView = { reservationId: 'exact-synthetic-hold', billingAccountId: 'synthetic-account', reservedAmount: '0.001', currency: 'USD', expiresAt: new Date('2099-01-01') };

beforeEach(() => {
  jest.spyOn(scope, 'scopedPermitForContext').mockReturnValue(undefined);
  jest.spyOn(availability, 'decisionAvailability').mockReturnValue({ available: true, reason: 'synthetic approval only' });
  jest.spyOn(publication, 'currentDeploymentLiveness').mockResolvedValue({ status: 'not-configured' });
  jest.spyOn(approvalConfig, 'mentionClassifierApproval').mockReturnValue(approval);
  jest.spyOn(mentionEconomics, 'mentionClassifierAuthorityActive').mockResolvedValue(true);
  jest.spyOn(metered, 'hasActiveInternalMeteredAdmission').mockResolvedValue(true);
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

it('admits only after the canonical route and USD quote, with own metering and no monetary hold', async () => {
  const kaanaClient = client();
  const result = await admitRequest({ ...context, kaanaClient });
  if (result.status !== 'admitted') throw new Error(JSON.stringify(result));
  expect(result.admitted.economics).toMatchObject({ treatment: 'internal_metered', policyVersion: approval.economicPolicyVersion });
  expect(metered.claimMeteredAdmission).toHaveBeenCalledWith(expect.objectContaining({ applicationId: context.principal.applicationId,
    applicationCredentialId: context.principal.credentialId, admittedDeploymentId: approval.deploymentId,
    economics: expect.objectContaining({ relationship: expect.objectContaining({ relationshipId: 'mention-jev-kaana' }) }) }));
  expect(ledger.reserve).not.toHaveBeenCalled();
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it.each(['route', 'price', 'policy', 'quote', 'revocation', 'expiry', 'input'] as const)('denies %s drift before claim or effects', async (kind) => {
  if (kind === 'route') jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({ ...approval, deploymentId: 'other' });
  if (kind === 'price') jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({ ...approval, priceVersionId: 'other' });
  if (kind === 'policy') jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({ ...approval, routingPolicyVersion: 2 });
  if (kind === 'quote') jest.mocked(ledger.quoteUnits).mockResolvedValue({ status: 'quoted', amount: '0.02', currency: 'USD' });
  if (kind === 'revocation') jest.mocked(mentionEconomics.mentionClassifierAuthorityActive).mockResolvedValue(false);
  if (kind === 'expiry') jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({ ...approval, expiresAt: '2000-01-01T00:00:00.000Z' });
  const request = kind === 'input' ? { ...context.request, input: { format: 'decisions' as const, decisions: {
    state: '字'.repeat(3000), questions: [{ kind: 'noul' as const, id: 'q', question: 'Synthetic?' }] } } } : context.request;
  const kaanaClient = client();
  expect((await admitRequest({ ...context, request, kaanaClient })).status).toBe('refused');
  expect(metered.claimMeteredAdmission).not.toHaveBeenCalled();
  expect(ledger.reserve).not.toHaveBeenCalled(); expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it('rechecks live authority after claim and never dispatches after revocation', async () => {
  jest.mocked(mentionEconomics.mentionClassifierAuthorityActive).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const kaanaClient = client();
  await executeInferenceRequest({ ...context, kaanaClient });
  expect(metered.claimMeteredAdmission).toHaveBeenCalledTimes(1);
  expect(mentionEconomics.mentionClassifierAuthorityActive).toHaveBeenCalledTimes(2);
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it('does not waive the decisions availability gate', async () => {
  jest.mocked(availability.decisionAvailability).mockReturnValue({ available: false, reason: 'closed' });
  const kaanaClient = client();
  expect((await admitRequest({ ...context, kaanaClient })).status).toBe('refused');
  expect(metered.claimMeteredAdmission).not.toHaveBeenCalled();
});
it('leaves a normal translation commercial while a classifier approval exists', async () => {
  const otherRoute = { ...route, modelReference: 'synthetic/translator@v1', deploymentId: 'synthetic-translation', apiFormats: ['responses'] as const };
  jest.mocked(catalogue.resolveEdgeRoute).mockResolvedValue({ status: 'resolved', route: { ...otherRoute, apiFormats: ['responses'] }, alternates: [] });
  const kaanaClient = client();
  kaanaClient.attestDeployments.mockResolvedValue({ snapshotId: 'synthetic-translation-snapshot', deployments: [otherRoute] });
  const result = await admitRequest({ ...context, apiFormat: 'responses', endpoint: '/v1/responses', kaanaClient,
    request: { operation: { kind: 'completion' }, target: { kind: 'model', modelReference: otherRoute.modelReference },
      input: { format: 'text', text: 'Translate synthetic text' }, stream: false, sampling: {}, tools: [] } });
  if (result.status !== 'admitted') throw new Error(JSON.stringify(result));
  expect(result.admitted.economics.treatment).toBe('commercial');
  expect(ledger.reserve).toHaveBeenCalledTimes(1);
  expect(mentionEconomics.mentionClassifierAuthorityActive).not.toHaveBeenCalled();
});
it('does not dispatch when the reviewed approval is withdrawn after admission', async () => {
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValueOnce(approval).mockReturnValueOnce(undefined);
  const kaanaClient = client();
  await executeInferenceRequest({ ...context, kaanaClient });
  expect(metered.claimMeteredAdmission).toHaveBeenCalledTimes(1);
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
it('checks expiry again after the dispatch-time authority read resolves', async () => {
  jest.mocked(mentionEconomics.mentionClassifierAuthorityActive).mockResolvedValueOnce(true).mockImplementationOnce(async () => {
    await Promise.resolve();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(approval.expiresAt));
    return true;
  });
  const kaanaClient = client();
  await executeInferenceRequest({ ...context, kaanaClient });
  expect(metered.claimMeteredAdmission).toHaveBeenCalledTimes(1);
  expect(kaanaClient.execute).not.toHaveBeenCalled();
});
