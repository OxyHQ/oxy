import type { ScopedExecutionAudience } from '@oxy.so/contracts';
import { hashScopedInput } from '../scopedExecution.service';
import { controlledInputBudget, pilotAllowsDeployment } from '../inferenceInternalPilot';
import { INTERNAL_METERED_RELATIONSHIPS } from '../../config/inferenceEconomicPolicy';
import type { NormalizedEdgeRequest } from '../../schemas/inferenceEdge.schemas';

const request = (text: string): NormalizedEdgeRequest => ({ operation: { kind: 'completion' },
  input: { format: 'text', text }, stream: false, tools: [], sampling: {} });

it('counts Unicode UTF-8 and every controlled schema or tool-call field', () => {
  const plain = controlledInputBudget(request('abc'));
  expect(controlledInputBudget(request('\u0800\u0800\u0800'))).toBe((plain ?? 0) + 6);
  expect(controlledInputBudget({ ...request('abc'), responseFormat: { type: 'json_schema',
    name: 'result', schema: { description: 'x'.repeat(9000) }, strict: true } })).toBeGreaterThan(8192);
  expect(controlledInputBudget({ ...request('abc'), tools: [{ type: 'function', name: 'lookup',
    parameters: { description: 'x'.repeat(9000) } }] })).toBeGreaterThan(8192);
  expect(controlledInputBudget({ ...request(''), input: { format: 'messages', messages: [{
    role: 'assistant', content: [], toolCalls: [{ id: 'call', name: 'lookup', arguments: 'x'.repeat(9000) }],
  }] } })).toBeGreaterThan(8192);
});

it('accounts for explicit overhead at the 8192 boundary', () => {
  const empty = controlledInputBudget(request(''));
  if (empty === undefined) throw new Error('Text budget missing');
  expect(empty).toBeGreaterThanOrEqual(288);
  expect(controlledInputBudget(request('x'.repeat(8192 - empty)))).toBe(8192);
  expect(controlledInputBudget(request('x'.repeat(8193 - empty)))).toBe(8193);
});

it('refuses modalities and operations whose pilot input is not supported', () => {
  expect(controlledInputBudget({ ...request(''), operation: { kind: 'embeddings', embeddings: 1 } })).toBeUndefined();
  expect(controlledInputBudget({ ...request(''), input: { format: 'messages', messages: [{ role: 'user',
    content: [{ type: 'image', source: { kind: 'url', url: 'https://example.test/image.png' } }] }] } })).toBeUndefined();
});

it('requires the exact deployment, model revision and provider tuple', () => {
  const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
  if (pilot === undefined) throw new Error('Production pilot missing');
  for (const route of pilot.deployments) {
    expect(pilotAllowsDeployment(pilot, route)).toBe(true);
    expect(pilotAllowsDeployment(pilot, { ...route, deploymentId: 'other' })).toBe(false);
    expect(pilotAllowsDeployment(pilot, { ...route, modelReference: 'openai/gpt-oss-120b@other' })).toBe(false);
    expect(pilotAllowsDeployment(pilot, { ...route, provider: 'other' })).toBe(false);
  }
});


describe('scoped decisions pilot budget', () => {
  const input = { format: 'decisions' as const, decisions: { effort: 'instant' as const,
    state: 'Synthetic red square', questions: [{ id: 'color', kind: 'noul' as const, question: 'Is it red?' }] } };
  const scopedRequest: NormalizedEdgeRequest = { operation: { kind: 'decisions' }, input, stream: false,
    tools: [], sampling: {}, target: { kind: 'model', modelReference: 'typesafe/jev@fixture' } };
  const permit: ScopedExecutionAudience = { permitId: 'fixture', idempotencyKey: 'fixture', fixtureSha256: hashScopedInput(input),
    expiresAt: '2099-01-01T00:00:00.000Z', principal: { accountId: 'fixture', applicationId: 'fixture', credentialId: 'fixture', environment: 'production' },
    policy: { routingPolicyId: 'fixture', policyVersion: 1 }, deploymentId: 'fixture', provider: 'openrouter', keyId: 'fixture',
    modelReference: 'typesafe/jev@fixture', upstreamModelId: 'fixture', priceVersionId: 'fixture', providerRateCardVersionId: 'fixture',
    providerSourceVersion: 'fixture', maxCostUsd: '0.01' };
  it('refuses unpermitted decisions, expired permits and input/model changes', () => {
    expect(controlledInputBudget(scopedRequest)).toBeUndefined();
    expect(controlledInputBudget(scopedRequest, { ...permit, expiresAt: '2020-01-01T00:00:00.000Z' })).toBeUndefined();
    expect(controlledInputBudget(scopedRequest, { ...permit, modelReference: 'typesafe/jev@other' })).toBeUndefined();
    expect(controlledInputBudget({ ...scopedRequest, input: { ...input, decisions: { ...input.decisions, state: 'changed' } } }, permit)).toBeUndefined();
    expect(controlledInputBudget({ ...scopedRequest, stream: true }, permit)).toBeUndefined();
  });
  it('counts the complete questions and state in UTF-8 against the existing input ceiling', () => {
    const budget = controlledInputBudget(scopedRequest, permit);
    expect(budget).toBe(Buffer.byteLength(JSON.stringify({ input, tools: [] }), 'utf8') + 256);
    const large = { ...input, decisions: { ...input.decisions, questions: [{ ...input.decisions.questions[0], question: '字'.repeat(3000) }] } };
    expect(controlledInputBudget({ ...scopedRequest, input: large }, { ...permit, fixtureSha256: hashScopedInput(large) })).toBeGreaterThan(8192);
  });
  it('matches wire JSON when normalized optional properties are undefined', () => {
    const withoutEffort = { ...input, decisions: { ...input.decisions, effort: undefined } };
    const wirePermit = { ...permit, fixtureSha256: hashScopedInput(JSON.parse(JSON.stringify(withoutEffort))) };
    expect(controlledInputBudget({ ...scopedRequest, input: withoutEffort }, wirePermit)).toBeGreaterThan(256);
  });
  it('restricts an authenticated scoped request to its exact route instead of the other pilot routes', () => {
    const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
    if (pilot === undefined) throw new Error('Missing pilot');
    const route = { deploymentId: permit.deploymentId, modelReference: permit.modelReference, provider: permit.provider };
    expect(pilotAllowsDeployment(pilot, route)).toBe(false);
    expect(pilotAllowsDeployment(pilot, route, permit)).toBe(true);
    expect(pilotAllowsDeployment(pilot, { ...route, deploymentId: 'other' }, permit)).toBe(false);
    expect(pilotAllowsDeployment(pilot, pilot.deployments[0], permit)).toBe(false);
    expect(pilotAllowsDeployment(pilot, route, { ...permit, expiresAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });
});
