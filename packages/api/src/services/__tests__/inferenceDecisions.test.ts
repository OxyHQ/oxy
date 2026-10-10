import { capabilityAdmits } from '../inferenceCatalogue.service';
import {
  admitRequest,
  ceilingForOperation,
  estimateInputTokens,
  requirementForRequest,
  type EdgeExecutionContext,
} from '../inferenceEdge.service';
import { decisionAvailability } from '../../config/decisionAvailability';
import type { NormalizedEdgeRequest } from '../../schemas/inferenceEdge.schemas';
import * as ledger from '../inferenceLedger.service';
import * as catalogue from '../inferenceCatalogue.service';

const request: NormalizedEdgeRequest = {
  operation: { kind: 'decisions' },
  target: { kind: 'model', modelReference: 'typesafe/jev@fixture-v1' },
  input: {
    format: 'decisions',
    decisions: {
      state: 'Synthetic 😀',
      instructions: 'Select exclusively',
      questions: [
        {
          id: 'q',
          kind: 'choice',
          question: 'Which?',
          criteria: 'Fixture',
          options: ['a', 'b'],
        },
      ],
    },
  },
  stream: false,
  sampling: {},
  tools: [],
};
it('requires affirmative decisions capabilities even when a catalogue has legacy omitted formats', () => {
  const requirement = requirementForRequest(request, 'decisions');
  expect(requirement.requiresDeclaredApiFormat).toBe(true);
  const undeclared = {
    apiFormats: null,
    realtimeTransports: null,
    realtimeSessionKinds: null,
  };
  expect(capabilityAdmits(undeclared, requirement)).toBe(false);
  expect(capabilityAdmits({ ...undeclared, apiFormats: ['responses'] }, requirement)).toBe(false);
  expect(capabilityAdmits({ ...undeclared, apiFormats: ['decisions'] }, requirement)).toBe(true);
});
it('keeps classification reservation distinct from any later generation', () => {
  const ceiling = ceilingForOperation(request.operation, estimateInputTokens(request), 9999);
  expect(ceiling).toEqual({
    requests: 1,
    input_tokens: estimateInputTokens(request),
  });
  expect(ceiling.output_tokens).toBeUndefined();
  expect(estimateInputTokens(request)).toBeGreaterThan(30);
});
it('fails closed before catalogue, reservation or provider calls without reviewed eligibility/privacy/ZDR', async () => {
  expect(decisionAvailability().available).toBe(false);
  const reserve = jest.spyOn(ledger, 'reserve');
  const resolve = jest.spyOn(catalogue, 'resolveEdgeRoute');
  const execute = jest.fn();
  const result = await admitRequest({
    requestId: 'req-synthetic-decisions',
    receivedAt: performance.now(),
    request,
    principal: {
      scopes: ['inference:invoke'],
      ownerAccountId: 'synthetic',
      applicationId: 'fixture',
    },
    apiFormat: 'decisions',
    endpoint: '/v1/decisions',
    signal: new AbortController().signal,
    kaanaClient: { execute },
  } as unknown as EdgeExecutionContext);
  expect(result).toMatchObject({
    status: 'refused',
    error: { code: 'service_unavailable' },
  });
  expect(reserve).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
