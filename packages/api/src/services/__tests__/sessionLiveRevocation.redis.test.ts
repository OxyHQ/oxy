import type { Request } from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../config/redis', () => ({
  ...jest.requireActual('../../config/redis'),
  getRedisClient: () => null,
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { sessions } from '../../db/schema/sessions';
import sessionCache from '../../utils/sessionCache';
import { startServiceEvents } from '../../utils/serviceEvents';
import sessionService from '../session.service';
import { deactivateSessionRows } from '../sessionRevocation.service';

const redisUrl = process.env.TEST_QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6391';

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
});

afterAll(async () => {
  await closePostgres();
});

it('reads the live session after its revocation subscriber misses an event', async () => {
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const namespace = {
    sockets: new Map(),
    use: jest.fn(),
    on: jest.fn(),
    local: { emit: jest.fn(), disconnectSockets: jest.fn() },
  };
  const duplicate = jest.spyOn(publisher, 'duplicate');
  const feed = startServiceEvents(namespace as never, publisher);
  const subscriber = duplicate.mock.results[0].value as Redis;
  try {
    await publisher.ping();
    await subscriber.subscribe('oxy-api:session:revoked', 'oxy-api:service-events:probe');
    const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const req = { headers: { 'user-agent': 'session-live-revocation-test' } } as Request;
    const created = await sessionService.createSession(user.id, req, {
      deviceId: `dev-${randomUUID()}`,
    });
    expect(await sessionService.validateSession(created.accessToken)).not.toBeNull();
    expect(sessionCache.get(created.sessionId)).not.toBeNull();

    const closed = once(subscriber, 'close');
    subscriber.disconnect();
    await closed;
    await deactivateSessionRows(getDb(), eq(sessions.sessionId, created.sessionId));
    await publisher.publish(
      'oxy-api:session:revoked',
      JSON.stringify({ sessionId: created.sessionId, userId: user.id, at: Date.now() }),
    );

    expect(await sessionService.validateSession(created.accessToken)).toBeNull();
    expect(sessionCache.get(created.sessionId)).not.toBeNull();
    await subscriber.connect();
    await subscriber.subscribe('oxy-api:session:revoked', 'oxy-api:service-events:probe');
    expect(await sessionService.validateSession(created.accessToken)).toBeNull();
  } finally {
    await feed.stop();
    duplicate.mockRestore();
    publisher.disconnect();
    subscriber.disconnect();
  }
});
