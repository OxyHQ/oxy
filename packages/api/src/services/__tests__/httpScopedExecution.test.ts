import { createHash, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { privateAutoSourceApprovalSchema } from '@oxy.so/contracts';
import { privateAutoApprovalFixture } from '../../../../contracts/src/__tests__/privateAutoExecution.fixture';
import { scopedAudienceFixture } from '../../../../contracts/src/__tests__/scopedExecution.fixture';
import { attestPricedDeployments, parseKaanaCatalogue } from '../kaanaCatalogueSync.service';
import { createHttpKaanaClient, createHttpKaanaCatalogueReader, mergeNegotiatedCatalogueReads } from '../httpKaanaClient';
import { resolveKaanaDataPlane } from '../../config/kaanaDataPlane';
import * as privateAutoSource from '../../config/privateAutoClassification';
jest.mock('../../config/kaanaDataPlane', () => ({ resolveKaanaDataPlane: jest.fn(), kaanaPublicKeyBase64: jest.fn() }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
let publicKey: KeyObject;
beforeEach(() => {
  const keys = generateKeyPairSync('ed25519'); publicKey = keys.publicKey;
  jest.mocked(resolveKaanaDataPlane).mockReturnValue({ status: 'configured', config: { baseUrl: 'https://kaana.ai', keyId: 'synthetic', privateKey: keys.privateKey } });
});
afterEach(() => jest.restoreAllMocks());
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
it('sends explicit signed-body negotiation and requires the positive exact echo', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://kaana.ai/internal/v1/deployments/query');
    expect(JSON.parse((init?.body as Buffer).toString())).toEqual({ deploymentIds: ['synthetic'], scopedExecutionContractVersion: '3.6.0' });
    expect((init?.headers as Record<string, string>)['X-Oxy-Kaana-Signature']).toMatch(/^v1=/);
    return response({ snapshotId: 'synthetic', deployments: [], scopedExecutionContractVersion: '3.6.0' });
  });
  const client = createHttpKaanaClient()!;
  await expect(client.attestDeployments(['synthetic'], { signal: new AbortController().signal, scopedExecutionContractVersion: '3.6.0' })).resolves.toMatchObject({ scopedExecutionContractVersion: '3.6.0' });
  fetcher.mockResolvedValue(response({ snapshotId: 'synthetic', deployments: [] }));
  await expect(client.attestDeployments(['synthetic'], { signal: new AbortController().signal, scopedExecutionContractVersion: '3.6.0' })).rejects.toThrow('acknowledge');
});
it('keeps the ordinary exact query legacy bytes unchanged', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
    expect((init?.body as Buffer).toString()).toBe('{"deploymentIds":["synthetic"]}');
    return response({ snapshotId: 'synthetic', deployments: [] });
  });
  await expect(createHttpKaanaClient()!.attestDeployments(['synthetic'], { signal: new AbortController().signal })).resolves.toMatchObject({ snapshotId: 'synthetic' });
});
it('reads the full catalogue through the existing signer and rejects missing support', async () => {
  jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(undefined);
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://kaana.ai/internal/v1/models/query');
    expect(init?.method).toBe('POST');
    expect((init?.body as Buffer).toString()).toBe('{"scopedExecutionContractVersion":"3.6.0"}');
    return response({ models: [], scopedExecutionContractVersion: '3.6.0' });
  });
  const reader = createHttpKaanaCatalogueReader()!;
  await expect(reader.listModels(new AbortController().signal)).resolves.toMatchObject({ scopedExecutionContractVersion: '3.6.0' });
  fetcher.mockResolvedValue(response({ models: [] }));
  await expect(reader.listModels(new AbortController().signal)).rejects.toThrow();
});


function independentFixtures() {
  const approval = privateAutoSourceApprovalSchema.parse({ ...privateAutoApprovalFixture,
    modelReference: scopedAudienceFixture.modelReference, deploymentId: 'synthetic-auto' });
  const ordinary = { deploymentId: 'ordinary', modelReference: 'synthetic/ordinary@v1', provider: 'openrouter', regions: [] as string[] };
  const scoped = { deploymentId: scopedAudienceFixture.deploymentId, modelReference: scopedAudienceFixture.modelReference,
    provider: 'openrouter', regions: [], scopedExecution: scopedAudienceFixture };
  const auto = { deploymentId: approval.deploymentId, modelReference: approval.modelReference,
    provider: approval.provider, regions: approval.regions, privateAutoSourceApproval: approval,
    keyId: approval.keyId, upstreamModelId: approval.upstreamModelId,
    providerRateCardVersionId: approval.providerRateCardVersionId, providerSourceVersion: approval.providerSourceVersion };
  const model = (descriptor: typeof ordinary, decisions = false) => ({ model: descriptor.modelReference.split('@')[0],
    modelReference: descriptor.modelReference, inputModalities: ['text'], outputModalities: decisions ? ['decisions'] : ['text'],
    listPrices: [{ deploymentId: descriptor.deploymentId, provider: descriptor.provider, currency: 'USD', input: '0.042', output: '0' }] });
  const scopedBody = { configuration: { snapshotId: 'one-snapshot' }, scopedExecutionContractVersion: '3.6.0',
    deployments: [ordinary, scoped], models: [model(ordinary), model(scoped, true)] };
  const autoBody = { configuration: { snapshotId: 'one-snapshot' }, privateAutoExecutionContractVersion: '3.7.0',
    deployments: [{ ...ordinary, regions: [...ordinary.regions] }, auto], models: [model(ordinary), model(auto, true)] };
  return { approval, ordinary, scoped, auto, scopedBody, autoBody };
}

it('reads and attests private lanes independently with the shipping signer and preserves all three lanes', async () => {
  const f = independentFixtures();
  jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
  const captured: { path: string; body: string }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const bytes = init?.body as Buffer, headers = new Headers(init?.headers);
    const signed = Buffer.from(`oxy-kaana-envelope:v1\nsynthetic\n${headers.get('X-Oxy-Kaana-Timestamp')}\n${createHash('sha256').update(bytes).digest('hex')}`);
    expect(verify(null, signed, publicKey, Buffer.from(headers.get('X-Oxy-Kaana-Signature')!.slice(3), 'base64'))).toBe(true);
    const query = JSON.parse(bytes.toString()); captured.push({ path: String(url), body: bytes.toString() });
    if (process.env.OXY_NEGOTIATION_CAPTURE_FILE) writeFileSync(process.env.OXY_NEGOTIATION_CAPTURE_FILE, JSON.stringify(captured));
    if (query.scopedExecutionContractVersion !== undefined && query.privateAutoExecutionContractVersion !== undefined) {
      return new Response('{"code":"invalid_request"}', { status: 400 });
    }
    const projection = query.privateAutoExecutionContractVersion === '3.7.0' ? f.autoBody : f.scopedBody;
    if (String(url).endsWith('/models/query')) return response(projection);
    return response({ snapshotId: projection.configuration.snapshotId,
      ...('privateAutoExecutionContractVersion' in projection ? { privateAutoExecutionContractVersion: '3.7.0' } : { scopedExecutionContractVersion: '3.6.0' }),
      deployments: projection.deployments.filter(row => query.deploymentIds === undefined || query.deploymentIds.includes(row.deploymentId)) });
  });
  const reader = createHttpKaanaCatalogueReader()!;
  const catalogue = parseKaanaCatalogue(await reader.listModels(new AbortController().signal));
  expect(catalogue.models).toHaveLength(2);
  expect(catalogue.models.flatMap(row => row.listPrices.map(price => price.deploymentId)).sort()).toEqual(['dep_synthetic', 'ordinary', 'synthetic-auto']);
  const attested = await attestPricedDeployments(reader, catalogue);
  expect([...attested.keys()].sort()).toEqual(['dep_synthetic', 'ordinary', 'synthetic-auto']);
  expect(attested.get('dep_synthetic')?.scopedExecution).toEqual(f.scoped.scopedExecution);
  expect(attested.get('synthetic-auto')?.privateAutoSourceApproval).toEqual(f.approval);
  const published = await reader.listPublishedDeployments(new AbortController().signal);
  expect(published.deployments.map(row => row.deploymentId)).toEqual(['dep_synthetic', 'ordinary', 'synthetic-auto']);
  expect(captured).toHaveLength(6);
  if (process.env.OXY_NEGOTIATION_CAPTURE_FILE) writeFileSync(process.env.OXY_NEGOTIATION_CAPTURE_FILE, JSON.stringify(captured));
});

it.each(['snapshot', 'model-facts', 'revision', 'price', 'descriptor', 'duplicate', 'foreign-authority', 'missing-descriptor', 'missing-ordinary', 'missing-ordinary-model', 'missing-ordinary-price', 'foreign-lane-price', 'configuration', 'ack'])
  ('refuses %s across projections', mutation => {
    const f = independentFixtures();
    if (mutation === 'snapshot') f.autoBody.configuration.snapshotId = 'other';
    if (mutation === 'model-facts') f.autoBody.models[1]!.outputModalities = ['text'];
    if (mutation === 'revision') f.autoBody.models[0]!.modelReference = 'synthetic/ordinary@other';
    if (mutation === 'price') f.autoBody.models[0]!.listPrices[0]!.input = '99';
    if (mutation === 'descriptor') f.autoBody.deployments[0]!.regions = ['us'];
    if (mutation === 'duplicate') f.autoBody.deployments.push(f.autoBody.deployments[0]!);
    if (mutation === 'foreign-authority') Object.assign(f.autoBody.deployments[0]!, { scopedExecution: f.scoped.scopedExecution });
    if (mutation === 'missing-descriptor') f.autoBody.deployments.splice(1, 1);
    if (mutation === 'missing-ordinary') { f.autoBody.deployments.splice(0, 1); f.autoBody.models.splice(0, 1); }
    if (mutation === 'missing-ordinary-model') f.autoBody.models.splice(0, 1);
    if (mutation === 'missing-ordinary-price') f.autoBody.models[0]!.listPrices = [];
    if (mutation === 'foreign-lane-price') f.autoBody.models[1]!.listPrices[0]!.deploymentId = f.scoped.deploymentId;
    if (mutation === 'configuration') Object.assign(f.autoBody.configuration, { issuedAt: 'changed' });
    if (mutation === 'ack') Object.assign(f.autoBody, { scopedExecutionContractVersion: '3.6.0' });
    expect(() => mergeNegotiatedCatalogueReads(f.scopedBody, f.autoBody)).toThrow();
  });
