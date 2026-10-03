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
