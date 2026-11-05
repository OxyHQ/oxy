import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));

it('keeps the live lane disabled until explicitly provisioned and preserves legacy validation', async () => {
  delete process.env.OXY_LIVE_SESSION_ENABLED;
  delete process.env.REDIS_URL;
  const { SessionController } = await import('../../controllers/session.controller');
  const handler = jest
    .spyOn(SessionController, 'validateSessionFromHeader')
    .mockImplementation((_req: unknown, res: express.Response) => res.json({ ok: true }));
  const router = (await import('../session')).default;
  const app = express();
  app.use('/session', router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/session/validate-header/s`;
  try {
    const denied = await fetch(base, { headers: { 'x-oxy-session-authority': 'live-v1' } });
    expect(denied.status).toBe(503);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(handler).not.toHaveBeenCalled();
    expect((await fetch(base)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    handler.mockRestore();
  }
});

it('does not enable live validation with Redis but without all budgets', async () => {
  jest.resetModules();
  process.env.OXY_LIVE_SESSION_ENABLED = 'true';
  process.env.REDIS_URL = process.env.TEST_QUEUE_REDIS_URL;
  process.env.OXY_LIVE_SESSION_SUBJECT_PER_MINUTE = '2';
  process.env.OXY_LIVE_SESSION_IP_PER_MINUTE = '3';
  delete process.env.OXY_LIVE_SESSION_GLOBAL_PER_MINUTE;
  const { SessionController } = await import('../../controllers/session.controller');
  const handler = jest.spyOn(SessionController, 'validateSessionFromHeader');
  const router = (await import('../session')).default;
  const { getRedisClient, closeRedis } = await import('../../config/redis');
  await getRedisClient().ping();
  const app = express();
  app.use('/session', router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/session/validate-header/s`;
    const denied = await fetch(url, { headers: { 'x-oxy-session-authority': 'live-v1' } });
    expect(denied.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeRedis();
    handler.mockRestore();
  }
});
