import express from 'express';
import request from 'supertest';
import router from '../peableEvents';
import { stopPeablePersonalRuntime } from '../../services/peablePersonalRuntime.service';
import * as runtimeService from '../../services/peablePersonalRuntime.service';

type Runtime = NonNullable<ReturnType<typeof runtimeService.getPeablePersonalRuntime>>;
function app() {
  const server = express();
  server.use('/billing/peable/events', express.raw({ type: 'application/json', limit: '1mb' }));
  server.use(express.json());
  server.use('/billing/peable/events', router);
  return server;
}
function configured(receive: jest.Mock) {
  return jest
    .spyOn(runtimeService, 'getPeablePersonalRuntime')
    .mockReturnValue({ configuration: { eventsEnabled: true }, receive } as unknown as Runtime);
}

it('refuses deliveries while the runtime is disabled', async () => {
  await stopPeablePersonalRuntime();
  const response = await request(app())
    .post('/billing/peable/events')
    .set('peable-signature', 'untrusted')
    .set('Content-Type', 'application/json')
    .send('{}');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'PEABLE_EVENTS_DISABLED' });
});

it('hands the exact signed bytes to the runtime and acknowledges only completed work', async () => {
  const receive = jest.fn(async () => ({ status: 'recorded' }));
  const getter = configured(receive);
  try {
    const raw = '{ "id":  "evt_1" }';
    const deliver = () =>
      request(app())
        .post('/billing/peable/events')
        .set('peable-signature', 't=1,v1=fixture')
        .set('Content-Type', 'application/json')
        .send(raw);
    expect((await deliver()).status).toBe(200);
    expect(receive).toHaveBeenCalledWith(raw, 't=1,v1=fixture');
    receive.mockResolvedValueOnce({ status: 'ignored' });
    expect((await deliver()).status).toBe(200);
    for (const status of ['review_required', 'checkout_pending', 'unknown'])
      receive.mockResolvedValueOnce({ status });
    for (let index = 0; index < 3; index++) expect((await deliver()).status).toBe(503);
    receive.mockRejectedValueOnce(new Error('Invalid Peable signature'));
    expect((await deliver()).status).toBe(503);
  } finally {
    getter.mockRestore();
  }
});

it.each([
  ['an unsigned delivery', '{}', undefined],
  ['an empty body', '', 't=1,v1=fixture'],
])('refuses %s before the runtime reads anything', async (_name, body, signature) => {
  const receive = jest.fn();
  const getter = configured(receive);
  try {
    const call = request(app())
      .post('/billing/peable/events')
      .set('Content-Type', 'application/json');
    if (signature) call.set('peable-signature', signature);
    expect((await call.send(body)).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  } finally {
    getter.mockRestore();
  }
});
