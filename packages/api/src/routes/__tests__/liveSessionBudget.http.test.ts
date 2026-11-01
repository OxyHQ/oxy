import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));

it('bounds the real live route by signed subject, address and shared budget', async () => {
  const redisUrl = process.env.TEST_QUEUE_REDIS_URL;
  if (!redisUrl) throw new Error('TEST_QUEUE_REDIS_URL is required');
  process.env.REDIS_URL = redisUrl;
  process.env.OXY_LIVE_SESSION_ENABLED = 'true';
  process.env.OXY_LIVE_SESSION_SUBJECT_PER_MINUTE = '2';
  process.env.OXY_LIVE_SESSION_IP_PER_MINUTE = '3';
  process.env.OXY_LIVE_SESSION_GLOBAL_PER_MINUTE = '10';
  process.env.ACCESS_TOKEN_SECRET = 'test-live-budget-secret';
  process.env.REFRESH_TOKEN_SECRET = 'test-live-budget-refresh';
  process.env.DEVICE_ID_SALT = 'test-live-budget-salt';
  const { SessionController } = await import('../../controllers/session.controller');
  const handler = jest.spyOn(SessionController, 'validateSessionFromHeader');
  const router = (await import('../session')).default;
  const { getRedisClient, closeRedis } = await import('../../config/redis');
  const { connectPostgres, closePostgres } = await import('../../config/postgres');
  const { insertAccountFixture } = await import('../../db/__fixtures__/accountIdentity');
  const sessionService = (await import('../../services/session.service')).default;
  const redis = getRedisClient();
  await redis.ping();
  await connectPostgres();
  const sessions = new Map<string, { sessionId: string; accessToken: string }>();
  try {
    for (const id of [
      'a',
      'b',
      'c',
      'h',
      ...Array.from({ length: 10 }, (_, i) => `parallel-${i}`),
    ]) {
      const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
      sessions.set(
        id,
        await sessionService.createSession(
          user.id,
          { headers: {} },
          { deviceId: `dev-${randomUUID()}` },
        ),
      );
    }
  } catch (error) {
    await closeRedis();
    await closePostgres();
    throw error;
  }
  const app = express();
  app.set('trust proxy', true);
  let liveRequests = 0;
  app.use((req, _res, next) => {
    if (req.header('x-oxy-session-authority') === 'live-v1') liveRequests++;
    next();
  });
  app.use('/session', router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/session/validate-header`;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { OxyServer } = await import('@oxy.so/core/server');
  const { OxyServices } = await import('@oxy.so/core');
  const oxy = new OxyServer({ baseURL: origin, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  const client = new OxyServices({ baseURL: origin });
  const request = (ip: string, userId?: string, live = true) =>
    fetch(`${base}/${userId ? sessions.get(userId)?.sessionId : 's'}`, {
      headers: {
        'x-forwarded-for': ip,
        ...(live ? { 'x-oxy-session-authority': 'live-v1' } : {}),
        ...(userId ? { authorization: `Bearer ${sessions.get(userId)?.accessToken}` } : {}),
      },
    });
  try {
    const redisCalls = jest.spyOn(redis, 'call');
    expect((await request('10.1.0.1', 'a')).status).toBe(200);
    expect(
      redisCalls.mock.calls.filter(
        (args: unknown[]) => String(args[0]).toLowerCase() === 'evalsha',
      ),
    ).toHaveLength(3);
    redisCalls.mockRestore();
    expect((await request('10.1.0.1', 'a')).status).toBe(200);
    expect((await request('10.1.0.2', 'a')).status).toBe(429);
    const globalKey = 'rl:session:live:global:all';
    expect(await redis.get(globalKey)).toBe('2');
    expect((await request('10.1.0.1', 'b')).status).toBe(200);
    expect((await request('10.1.0.1', 'c')).status).toBe(429);
    expect(await redis.get(globalKey)).toBe('3');
    expect((await request('10.1.0.2')).status).toBe(401);
    expect((await request('10.1.0.2')).status).toBe(401);
    expect((await request('10.1.0.2')).status).toBe(429);
    expect(await redis.get(globalKey)).toBe('5');
    const initialTtl = await redis.pttl(globalKey);
    const originalCall = redis.call.bind(redis);
    let budgetCommands = 0;
    const failingGlobal = jest
      .spyOn(redis, 'call')
      .mockImplementation((command: string, ...args: unknown[]) => {
        if (command.toLowerCase() === 'evalsha' && ++budgetCommands === 3)
          return Promise.reject(new Error('synthetic Redis command failure'));
        return originalCall(command, ...args);
      });
    expect((await request('10.1.0.7', 'h')).status).toBe(503);
    failingGlobal.mockRestore();
    expect(await redis.get(globalKey)).toBe('5');
    const simultaneous = await Promise.all(
      Array.from({ length: 10 }, (_, i) => request(`10.2.0.${i + 1}`, `parallel-${i}`)),
    );
    expect(simultaneous.filter((response) => response.status === 200)).toHaveLength(5);
    expect(simultaneous.filter((response) => response.status === 429)).toHaveLength(5);
    expect(await redis.get(globalKey)).toBe('15');
    expect(await redis.pttl(globalKey)).toBeLessThanOrEqual(initialTtl);
    expect((await request('10.1.0.6', 'h')).status).toBe(429);
    expect((await request('10.1.0.1', 'a', false)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(11);
    client.session.setAccessToken(sessions.get('h')?.accessToken);
    const epoch = client.http.getSessionEpoch();
    const beforeLimit = liveRequests;
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    expect(liveRequests - beforeLimit).toBe(1);
    expect(client.session.accessToken).toBe(sessions.get('h')?.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
    redis.disconnect();
    const unavailable = await request('10.1.0.7', 'h');
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    expect(handler).toHaveBeenCalledTimes(11);
    const beforeUnavailable = liveRequests;
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    expect(liveRequests - beforeUnavailable).toBe(1);
    expect(client.session.accessToken).toBe(sessions.get('h')?.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    client.dispose();
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeRedis();
    await closePostgres();
    handler.mockRestore();
  }
}, 20000);
