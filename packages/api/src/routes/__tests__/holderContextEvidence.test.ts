import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// CI supplies a disposable Redis and provisions a migrated Postgres per worker.
// A developer opts in by setting TEST_QUEUE_REDIS_URL to an isolated test Redis.
const describeWithTestRedis = process.env.TEST_QUEUE_REDIS_URL ? describe : describe.skip;
describeWithTestRedis('holder context evidence HTTP', () => {
  let server: http.Server;
  let closePostgres: () => Promise<void>;
  let closeRedis: () => Promise<void>;
  let bearer: string;
  let deviceId: string;
  let deviceSecret: string;
  let originalRedisUrl: string | undefined;

  beforeAll(async () => {
    if (!process.env.TEST_QUEUE_REDIS_URL) throw new Error('Isolated test Redis is required');
    originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = process.env.TEST_QUEUE_REDIS_URL;
    process.env.OXY_HOLDER_EVIDENCE_ENABLED = 'true';
    process.env.OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE = '60';
    process.env.OXY_HOLDER_EVIDENCE_IP_PER_MINUTE = '300';
    process.env.OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE = '600';
    process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
    process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
    process.env.DEVICE_ID_SALT = 'x'.repeat(48);

    const postgres = await import('../../config/postgres');
    const redisModule = await import('../../config/redis');
    closePostgres = postgres.closePostgres;
    closeRedis = redisModule.closeRedis;
    await postgres.connectPostgres();
    const redis = redisModule.getRedisClient();
    if (!redis) throw new Error('Redis unavailable');
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('error', reject);
      });
    }
    const { insertAccountFixture } = await import('../../db/__fixtures__/accountIdentity');
    const { default: sessions } = await import('../../services/session.service');
    const { default: devices } = await import('../../services/deviceSession.service');
    const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    deviceId = `dev-${randomUUID()}`;
    const req = {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120', 'accept-language': 'en-US' },
    } as unknown as Request;
    const session = await sessions.createSession(account.id, req, { deviceId });
    await devices.addAccount(deviceId, { accountId: account.id, sessionId: session.sessionId });
    expect(await devices.bindSessionToContext(deviceId, session.sessionId)).toBe(true);
    const holder = await devices.issueDeviceSecret(deviceId);
    if (!holder) throw new Error('Missing holder');
    deviceSecret = holder;
    const token = await devices.resolveHolderContextToken(deviceId, holder);
    if (!token) throw new Error('Missing bound bearer');
    bearer = token.accessToken;

    const { default: router } = await import('../sessionDevice');
    const { errorHandler } = await import('../../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use('/session/device', router);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    // An asynchronous activity update can otherwise reopen the shared client
    // during teardown, leaving a live Redis socket after this suite finishes.
    delete process.env.REDIS_URL;
    try {
      if (closeRedis) await closeRedis();
      if (closePostgres) await closePostgres();
    } finally {
      if (originalRedisUrl !== undefined) process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('requires a signed bearer and the holder and returns no credentials', async () => {
    const address = server.address() as AddressInfo;
    const post = (token: string | undefined, secret = deviceSecret) =>
      fetch(`http://127.0.0.1:${address.port}/session/device/context-evidence-v1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ deviceId, deviceSecret: secret }),
      });
    const missing = await post(undefined);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'invalid_bearer' });
    const forged = await post(`${bearer.slice(0, -8)}forgedxx`);
    expect(forged.status).toBe(401);
    const wrongHolder = await post(bearer, `${deviceSecret}-wrong`);
    expect(wrongHolder.status).toBe(409);
    const success = await post(bearer);
    expect(success.status).toBe(200);
    expect(success.headers.get('cache-control')).toBe('no-store');
    const body = await success.json();
    expect(body).toMatchObject({ data: { version: 1, deviceId } });
    expect(JSON.stringify(body)).not.toContain(bearer);
    expect(JSON.stringify(body)).not.toContain(deviceSecret);
  });
});
