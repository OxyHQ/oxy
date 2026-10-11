import { EventEmitter } from 'node:events';
import type { Request, Response, RequestHandler } from 'express';
import { createInferenceEdgeRouter, inferenceEdgeLimiter } from '../inferenceEdge';
import {
  machineApplicationLimiter,
  machineCredentialLimiter,
} from '../../middleware/machineCredential';
import * as ledger from '../../services/inferenceLedger.service';

interface RouteLayer {
  route?: { path: string; stack: { handle: RequestHandler }[] };
}
const body = {
  model: 'typesafe/jev@fixture-v1',
  state: 'Synthetic fixture',
  questions: [{ id: 'q', kind: 'noul', question: 'Synthetic?' }],
};
function route() {
  const router = createInferenceEdgeRouter();
  const found = (router.stack as RouteLayer[]).find(
    (layer) => layer.route?.path === '/decisions',
  )?.route;
  if (!found) throw new Error('Missing decisions route');
  return found.stack.map((layer) => layer.handle);
}
it('mounts authentication before all three existing limiters', () => {
  const handlers = route();
  expect(handlers).toHaveLength(5);
  expect(handlers.slice(1, 4)).toEqual([
    machineCredentialLimiter,
    machineApplicationLimiter,
    inferenceEdgeLimiter,
  ]);
});
it.each([
  [body, 'service_unavailable', 503],
  [{ ...body, state: '\ud800' }, 'invalid_request', 400],
  [{ ...body, questions: [{ ...body.questions[0], id: '\udfff' }] }, 'invalid_request', 400],
  [{ ...body, stream: true }, 'invalid_request', 400],
  [{ ...body, effort: 'ultra' }, 'invalid_request', 400],
])(
  'validates the public body and keeps the production gate closed',
  async (input, code, status) => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
    });
    res.status.mockReturnValue(res);
    const handlers = route();
    const handler = handlers[handlers.length - 1];
    const req = {
      headers: {},
      body: input,
      edge: {
        requestId: 'req-synthetic',
        receivedAt: performance.now(),
        principal: {
          scopes: ['inference:invoke'],
          ownerAccountId: 'fixture',
          applicationId: 'fixture',
        },
      },
    };
    await handler(req as unknown as Request, res as unknown as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(res.setHeader).toHaveBeenCalledWith('X-Oxy-Inference-Contract-Version', '3.5.0');
    expect(reserve).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  },
);
