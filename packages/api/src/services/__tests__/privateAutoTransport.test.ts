import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { privateAutoInferenceRequestSchema, privateAutoSourceApprovalSchema, privateAutoOperationId } from '@oxy.so/contracts';
import { privateAutoApprovalFixture, privateAutoInputFixture } from '../../../../contracts/src/__tests__/privateAutoExecution.fixture';
import { privateAutoHash } from '../privateAutoExecution.service';
import { createHttpKaanaClient, createHttpKaanaCatalogueReader, kaanaEnvelopeBytes } from '../httpKaanaClient';
import { resolveKaanaDataPlane } from '../../config/kaanaDataPlane';
import * as source from '../../config/privateAutoClassification';
import { createDeploymentPublicationCache } from '../kaanaDeploymentPublication.service';

jest.mock('../../config/kaanaDataPlane', () => ({ resolveKaanaDataPlane: jest.fn(() => ({ status: 'not-configured' })), kaanaPublicKeyBase64: jest.fn() }));
const approval = privateAutoSourceApprovalSchema.parse(privateAutoApprovalFixture);
const descriptor = { deploymentId: approval.deploymentId, modelReference: approval.modelReference,
  provider: approval.provider, regions: approval.regions, privateAutoSourceApproval: approval,
  keyId: approval.keyId, upstreamModelId: approval.upstreamModelId,
  providerRateCardVersionId: approval.providerRateCardVersionId, providerSourceVersion: approval.providerSourceVersion };
const evidence = { snapshotId: 'synthetic-snapshot', privateAutoExecutionContractVersion: '3.7.0', deployments: [descriptor] };
function setup() {
  const keys = generateKeyPairSync('ed25519');
  jest.mocked(resolveKaanaDataPlane).mockReturnValue({ status: 'configured', config: {
    baseUrl: 'https://kaana.ai', keyId: 'synthetic', privateKey: keys.privateKey } });
  const client = createHttpKaanaClient();
  if (!client) throw new Error('Synthetic client missing');
  return { client, keys };
}
function envelope(state = 'synthetic variable task', now = Date.now()) {
  const parentMeteredUsageId = '018f2118-95bc-7aca-914e-17632106cad8';
  const requestId = privateAutoOperationId(parentMeteredUsageId);
  const input = privateAutoInputFixture(state);
  const { review: _review, limits: _limits, ...wire } = approval;
  return privateAutoInferenceRequestSchema.parse({ schemaVersion: 4,
    privateAutoExecution: { ...wire, contractVersion: '3.7.0', approvalSha256: privateAutoHash(approval),
      parentMeteredUsageId, parentRequestId: 'synthetic-parent', operationId: requestId, requestId,
      inputSha256: privateAutoHash(input), runtimeExpiresAt: new Date(now + 1000).toISOString(),
      snapshotId: evidence.snapshotId, catalogueEvidenceHash: 'a'.repeat(64) },
    attribution: { requestId, principal: { billing: { accountId: approval.principal.accountId },
      applicationId: approval.principal.applicationId, credentialId: approval.principal.credentialId,
      environment: 'production', inferenceScopes: ['inference:invoke'] } },
    target: { kind: 'model', modelReference: approval.modelReference }, modality: 'text', input,
    stream: false, sampling: {}, tools: [], idempotencyKey: requestId, routingPolicy: approval.policy,
    client: { apiFormat: 'decisions', endpoint: '/internal/auto-classification', receivedAt: new Date(now).toISOString() },
    authorizedRoutes: [{ substitution: 'same_model', deploymentId: approval.deploymentId,
      modelReference: approval.modelReference, provider: approval.provider, regions: approval.regions }] });
}
afterEach(() => jest.restoreAllMocks());
it('negotiates signed 3.7 evidence explicitly and refuses it for ordinary or 3.6-only queries', async () => {
  const { client } = setup();
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(evidence), { headers: { 'Cache-Control': 'no-store' } }));
  await expect(client.attestDeployments([approval.deploymentId], { signal: new AbortController().signal,
    privateAutoExecutionContractVersion: '3.7.0' })).resolves.toEqual(evidence);
  expect(JSON.parse((fetcher.mock.calls[0][1]?.body as Buffer).toString())).toEqual({ deploymentIds: [approval.deploymentId], privateAutoExecutionContractVersion: '3.7.0' });
  await expect(client.attestDeployments([approval.deploymentId], { signal: new AbortController().signal })).rejects.toThrow('negotiation');
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...evidence, scopedExecutionContractVersion: '3.6.0' }), { headers: { 'Cache-Control': 'no-store' } }));
  await expect(client.attestDeployments([approval.deploymentId], { signal: new AbortController().signal, scopedExecutionContractVersion: '3.6.0' })).rejects.toThrow('negotiation');
});
it.each(['deploymentId', 'modelReference', 'provider', 'keyId', 'upstreamModelId', 'providerRateCardVersionId', 'providerSourceVersion'] as const)('refuses signed private descriptor drift in %s', async (field) => {
  const { client } = setup();
  const changed = field === 'modelReference' ? 'foreign/model@v1' : 'foreign';
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ...evidence, deployments: [{ ...descriptor, [field]: changed }] }), { headers: { 'Cache-Control': 'no-store' } }));
  await expect(client.attestDeployments([approval.deploymentId], { signal: new AbortController().signal, privateAutoExecutionContractVersion: '3.7.0' })).rejects.toThrow('identity mismatch');
});
it('refuses unacknowledged, unknown-version and changed-region private evidence', async () => {
  const { client } = setup();
  const fetcher = jest.spyOn(globalThis, 'fetch');
  for (const value of [ { ...evidence, privateAutoExecutionContractVersion: undefined },
    { ...evidence, privateAutoExecutionContractVersion: '3.6.0' },
    { ...evidence, deployments: [{ ...descriptor, regions: ['us-west-2'] }] } ]) {
    fetcher.mockResolvedValue(new Response(JSON.stringify(value), { headers: { 'Cache-Control': 'no-store' } }));
    await expect(client.attestDeployments([approval.deploymentId], { signal: new AbortController().signal, privateAutoExecutionContractVersion: '3.7.0' })).rejects.toThrow();
  }
});
it('nil approval leaves catalogue negotiation unchanged; private source never enters ordinary publication', async () => {
  setup();
  jest.spyOn(source, 'privateAutoClassifierSourceApproval').mockReturnValue(undefined);
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ snapshotId: 'ordinary', scopedExecutionContractVersion: '3.6.0', deployments: [] })));
  const reader = createHttpKaanaCatalogueReader();
  if (!reader) throw new Error('Missing reader');
  await reader.listPublishedDeployments(new AbortController().signal);
  expect(JSON.parse((fetcher.mock.calls[0][1]?.body as Buffer).toString())).toEqual({ scopedExecutionContractVersion: '3.6.0' });
  jest.spyOn(source, 'privateAutoClassifierSourceApproval').mockReturnValue(approval);
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...evidence, scopedExecutionContractVersion: '3.6.0' })));
  const publication = await createDeploymentPublicationCache(reader).current();
  expect(publication.status).toBe('observed');
  if (publication.status !== 'observed') throw new Error('Missing publication');
  expect(publication.deploymentIds.size).toBe(0);
});
it('signs actual variable-input canonical bytes through the decisions endpoint once', async () => {
  const { client, keys } = setup();
  const request = envelope();
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://kaana.ai/internal/v1/decisions');
    const bytes = init?.body as Buffer;
    expect(JSON.parse(bytes.toString())).toEqual(request);
    const headers = new Headers(init?.headers);
    const signed = Buffer.from(`oxy-kaana-envelope:v1\nsynthetic\n${headers.get('X-Oxy-Kaana-Timestamp')}\n${createHash('sha256').update(bytes).digest('hex')}`);
    expect(verify(null, signed, keys.publicKey, Buffer.from((headers.get('X-Oxy-Kaana-Signature') ?? '').slice(3), 'base64'))).toBe(true);
    return new Response(JSON.stringify({ schemaVersion: 1, requestId: request.attribution.requestId,
      model: approval.modelReference, data: [{ id: 'auto-power-level', kind: 'choice', reply: 'medium', confidence: 0.9, probabilities: [0.03, 0.9, 0.04, 0.03] }],
      usage: { schemaVersion: 2, requestId: request.attribution.requestId, attribution: request.attribution,
        outcome: 'completed', units: [{ unit: 'requests', quantity: 1 }], usageSource: 'provider_reported',
        resolvedModelReference: approval.modelReference, servingProvider: approval.provider, deploymentId: approval.deploymentId,
        routeSwitches: 0, startedAt: request.client.receivedAt, completedAt: new Date().toISOString() } }));
  });
  await expect(client.execute(request, { signal: new AbortController().signal, privateAutoExecutionContractVersion: '3.7.0' })).resolves.toMatchObject({ output: [], finishReason: 'stop' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses altered actual input, unnegotiated execution, stream and expired original deadline before send', async () => {
  const { client } = setup();
  const request = envelope();
  const fetcher = jest.spyOn(globalThis, 'fetch');
  expect(() => kaanaEnvelopeBytes({ ...request, input: privateAutoInputFixture('changed synthetic private text') })).toThrow('input hash');
  await expect(client.execute(request, { signal: new AbortController().signal })).rejects.toThrow('negotiated');
  await expect(client.stream(request, { signal: new AbortController().signal }).next()).rejects.toThrow('streaming');
  await expect(client.execute(envelope('synthetic', Date.now() - 1001), { signal: new AbortController().signal, privateAutoExecutionContractVersion: '3.7.0' })).rejects.toThrow('deadline');
  expect(fetcher).not.toHaveBeenCalled();
});
