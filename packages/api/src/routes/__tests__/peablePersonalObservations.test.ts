import express, { type Request, type Response } from 'express';
import request from 'supertest';
import router, { receivePeablePersonalObservation } from '../peablePersonalObservations';
import { stopPeablePersonalRuntime } from '../../services/peablePersonalRuntime.service';
import * as runtimeService from '../../services/peablePersonalRuntime.service';

it('mounts a raw signed delivery route but refuses requests while runtime is disabled', async () => {
  await stopPeablePersonalRuntime();
  const app = express();
  app.use('/billing/peable/observations', express.raw({ type: 'application/json', limit: '1mb' }), router);
  const response = await request(app).post('/billing/peable/observations/00000000-0000-4000-8000-000000000001')
    .set('peable-signature', 'untrusted').set('Content-Type', 'application/json').send('{}');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'PEABLE_OBSERVATIONS_DISABLED' });
});
it('preserves exact signed bytes through JSON middleware and defers failed reconciliation', async () => {
  const observe = jest.fn(async () => ({ status: 'replayed' }));
  const configured = { configuration: { observationsEnabled: true }, observe } as unknown as NonNullable<ReturnType<typeof runtimeService.getPeablePersonalRuntime>>;
  const getter = jest.spyOn(runtimeService, 'getPeablePersonalRuntime').mockReturnValue(configured);
  try {
    const app = express();
    app.use('/billing/peable/observations', express.raw({ type: 'application/json', limit: '1mb' }));
    app.use(express.json());
    app.use('/billing/peable/observations', router);
    const sourceId = '00000000-0000-4000-8000-000000000001';
    const raw = '{ "fixture":  1 }';
    const deliver = () => request(app).post(`/billing/peable/observations/${sourceId}`)
      .set('peable-signature', 'fixture-signature').set('Content-Type', 'application/json').send(raw);
    expect((await deliver()).status).toBe(200);
    expect(observe).toHaveBeenCalledWith(sourceId, raw, 'fixture-signature');
    observe.mockRejectedValue(new Error('Indeterminate provider read'));
    expect((await deliver()).status).toBe(503);
    expect((await request(app).post('/billing/peable/observations/foreign-invalid-source')
      .set('Content-Type', 'application/json').send(raw)).status).toBe(400);
  } finally { getter.mockRestore(); }
});

it.each([[["00000000-0000-4000-8000-000000000001"]], [{}], [undefined]])('rejects a non-string source parameter before observing', async sourceId => {
  const observe = jest.fn();
  const configured = { configuration: { observationsEnabled: true }, observe } as unknown as NonNullable<ReturnType<typeof runtimeService.getPeablePersonalRuntime>>;
  const getter = jest.spyOn(runtimeService, 'getPeablePersonalRuntime').mockReturnValue(configured);
  const status = jest.fn(); const json = jest.fn();
  const response = { status, json } as unknown as Response;
  status.mockReturnValue(response);
  try {
    await receivePeablePersonalObservation({ params: { sourceId }, body: Buffer.from('{}'), get: () => 'fixture' } as unknown as Request, response);
    expect(status).toHaveBeenCalledWith(400);
    expect(observe).not.toHaveBeenCalled();
  } finally { getter.mockRestore(); }
});
