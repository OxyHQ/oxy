/**
 * A limiter whose Redis store cannot count admits the request uncounted.
 *
 * Every limiter used to rethrow the store's error, so a Valkey outage answered
 * 500 on nearly every route. Only a budget that rations a scarce authority
 * (`failClosedOnStoreError`) still hands the error to its caller.
 */

import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

const fakeRedis = {
  status: 'ready',
  call: jest.fn(async () => {
    throw new Error('Connection is closed.');
  }),
};

jest.mock('../../config/redis', () => ({ getRedisClient: () => fakeRedis }));

import { rateLimit } from '../rateLimiter';

async function statusOf(limiter: RequestHandler): Promise<number> {
  const app = express();
  app.use(limiter);
  app.get('/{*path}', (_req, res) => res.json({ ok: true }));
  const failed: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(503).json({ failedClosed: true });
  };
  app.use(failed);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return (await fetch(`http://127.0.0.1:${port}/anything`)).status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeAll(() => {
  // express-rate-limit reports the store's errors on the console.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('a limiter whose store cannot count', () => {
  it('admits the request, without waiting on a connection that is not ready', async () => {
    const limiter = rateLimit({ prefix: 'test:outage:', windowMs: 60_000, max: 1 });

    fakeRedis.status = 'ready';
    expect(await statusOf(limiter)).toBe(200);

    fakeRedis.status = 'reconnecting';
    fakeRedis.call.mockClear();
    expect(await statusOf(limiter)).toBe(200);
    expect(fakeRedis.call).not.toHaveBeenCalled();
  });

  it('hands the error to the caller of a budget that fails closed', async () => {
    fakeRedis.status = 'ready';
    const limiter = rateLimit({
      prefix: 'test:outage:closed:',
      windowMs: 60_000,
      max: 1,
      failClosedOnStoreError: true,
    });

    expect(await statusOf(limiter)).toBe(503);
  });
});
