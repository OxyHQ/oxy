import { parseKaanaCatalogue, planKaanaModel } from '../kaanaCatalogueSync.service';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';

const modelReference = 'typesafe/jev@fixture-v1';
const audience = (deploymentId: string, provider: string): ScopedExecutionAudience => ({
  permitId: 'permit-' + deploymentId, idempotencyKey: 'key-' + deploymentId, fixtureSha256: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  principal: { accountId: 'synthetic', applicationId: 'synthetic', credentialId: 'synthetic', environment: 'production' },
  policy: { routingPolicyId: 'synthetic', policyVersion: 1 }, deploymentId, provider, keyId: 'key-' + deploymentId,
  modelReference, upstreamModelId: 'jev-fixture', priceVersionId: 'price-' + deploymentId,
  providerRateCardVersionId: 'card-' + deploymentId, providerSourceVersion: 'source-' + deploymentId, maxCostUsd: '0.01',
});
const first = audience('private-one', 'typesafe');
const second = audience('private-two', 'openrouter');
const deployments = [
  { deploymentId: 'ordinary', provider: 'cloudflare', modelReference, regions: [] },
  ...[first, second].map((scope) => ({ deploymentId: scope.deploymentId, provider: scope.provider, modelReference, regions: [], scopedExecution: scope,
    keyId: scope.keyId, upstreamModelId: scope.upstreamModelId, providerRateCardVersionId: scope.providerRateCardVersionId, providerSourceVersion: scope.providerSourceVersion })),
];
const payload = { scopedExecutionContractVersion: '3.6.0', configuration: { snapshotId: 'synthetic-snapshot' }, deployments,
  models: [{ model: 'typesafe/jev', modelReference, contextTokens: 32768, maxOutputTokens: 8192, inputModalities: ['text'], outputModalities: ['text'],
    listPrices: deployments.map((row) => ({ deploymentId: row.deploymentId, provider: row.provider, currency: 'USD', input: '0.001', output: '0' })) }] };
const planning = (rows = deployments) => ({ blocked: new Set<string>(), knownProviders: new Set(['typesafe', 'openrouter', 'cloudflare']), attested: new Map(rows.map(row => [row.deploymentId, row])) });
it('keeps two private audiences and an ordinary route separate on one pinned model', () => {
  const parsed = parseKaanaCatalogue(payload);
  expect(parsed.models).toHaveLength(1);
  const prices = parsed.models[0].listPrices;
  expect(prices.find(row => row.deploymentId === 'ordinary')?.scopedExecution).toBeUndefined();
  expect(prices.find(row => row.deploymentId === 'private-one')?.scopedExecution).toEqual(first);
  expect(prices.find(row => row.deploymentId === 'private-two')?.scopedExecution).toEqual(second);
  const plan = planKaanaModel(parsed.models[0], planning());
  expect(plan.status).toBe('planned');
  if (plan.status !== 'planned') throw new Error('Synthetic plan unavailable');
  expect(plan.model.routes.find(row => row.deploymentId === 'ordinary')?.scopedExecution).toBeUndefined();
  expect(plan.model.routes.find(row => row.deploymentId === 'private-one')?.scopedExecution?.permitId).toBe(first.permitId);
  expect(plan.model.routes.find(row => row.deploymentId === 'private-two')?.scopedExecution?.permitId).toBe(second.permitId);
});
it('refuses a private descriptor rebound to another deployment audience', () => {
  const parsed = parseKaanaCatalogue(payload);
  const wrong = deployments.map(row => row.deploymentId === first.deploymentId ? { ...row, scopedExecution: second } : row);
  const plan = planKaanaModel(parsed.models[0], planning(wrong));
  expect(plan.status).toBe('planned');
  if (plan.status !== 'planned') throw new Error('Ordinary synthetic route should remain');
  expect(plan.model.routes.some(row => row.deploymentId === first.deploymentId)).toBe(false);
  expect(plan.model.routes.find(row => row.deploymentId === 'ordinary')?.scopedExecution).toBeUndefined();
});
it('rejects a negotiated catalogue missing deployment restrictions', () => {
  expect(() => parseKaanaCatalogue({ ...payload, deployments: undefined })).toThrow('exact deployment');
});
it('does not attach a scope from a different model revision', () => {
  const parsed = parseKaanaCatalogue({ ...payload, deployments: deployments.map(row => row.deploymentId === first.deploymentId ? { ...row, modelReference: 'typesafe/jev@other' } : row) });
  expect(parsed.models[0].listPrices.some(row => row.deploymentId === first.deploymentId)).toBe(false);
  expect(parsed.models[0].listPrices.find(row => row.deploymentId === 'ordinary')?.scopedExecution).toBeUndefined();
});

it('does not publish any private deployment in the ordinary liveness view', async () => {
  const { createDeploymentPublicationCache } = await import('../kaanaDeploymentPublication.service');
  const publication = await createDeploymentPublicationCache({ listPublishedDeployments: async () => ({
    snapshotId: 'synthetic-snapshot', scopedExecutionContractVersion: '3.6.0', deployments,
  }) }).current();
  expect(publication.status).toBe('observed');
  if (publication.status !== 'observed') throw new Error('Missing synthetic observation');
  expect([...publication.deploymentIds]).toEqual(['ordinary']);
});

it('preserves provider-reported decisions and derives capability only from the exact private contract', () => {
  const source = require('../scopedExecution.service') as typeof import('../scopedExecution.service');
  const spy = jest.spyOn(source, 'sourceReviewedScopedAudience').mockReturnValue(first);
  try {
    const body = { ...payload, deployments: [deployments[1]], models: [{ ...payload.models[0], outputModalities: ['decisions'],
      listPrices: [{ deploymentId: first.deploymentId, provider: first.provider, currency: 'USD', input: '0.001', output: '0' }] }] };
    const parsed = parseKaanaCatalogue(body).models[0];
    const plan = planKaanaModel(parsed, planning([deployments[1]]));
    expect(plan).toMatchObject({ status: 'planned', model: { outputModalities: ['decisions'], apiFormats: ['decisions'] } });
    spy.mockReturnValue(undefined);
    expect(planKaanaModel(parsed, planning([deployments[1]])).status).toBe('skipped');
    spy.mockReturnValue({ ...first, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(planKaanaModel(parsed, planning([deployments[1]])).status).toBe('skipped');
    spy.mockReturnValue(first);
    for (const outputs of [['decisions', 'text'], ['decisions', 'unknown'], ['image']]) {
      expect(planKaanaModel({ ...parsed, outputModalities: outputs }, planning([deployments[1]])).status).toBe('skipped');
    }
    const ordinaryBody = { ...body, deployments: [deployments[0]], models: [{ ...body.models[0], listPrices: [payload.models[0].listPrices[0]] }] };
    expect(planKaanaModel(parseKaanaCatalogue(ordinaryBody).models[0], planning([deployments[0]])).status).toBe('skipped');
  } finally { spy.mockRestore(); }
});
