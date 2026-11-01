import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
import { OxyServer } from '@oxy.so/core/server';
import { OxyServices } from '@oxy.so/core';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { sessions } from '../../db/schema/sessions';
import { supervisionProfiles } from '../../db/schema/supervision';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { SessionController } from '../../controllers/session.controller';
import sessionService from '../session.service';
import userService from '../user.service';
import * as supervisionPolicy from '../supervisionPolicy.service';
import sessionCache, { type CachedSession } from '../../utils/sessionCache';
import userCache from '../../utils/userCache';

it('revalidates the live session row independently of ordinary cached validation', async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'fresh-local-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const app = express();
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServer({ baseURL, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  try {
    const request = () =>
      fetch(`${baseURL}/private`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(
      await sessionService.getSessionWithUser(session.sessionId, { useCache: true }),
    ).not.toBeNull();
    const direct = () =>
      fetch(`${baseURL}/session/validate-header/${session.sessionId}`, {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'x-oxy-session-authority': 'live-v1',
        },
      });
    const active = await direct();
    expect(active.status).toBe(200);
    expect(active.headers.get('cache-control')).toBe('no-store');
    expect(active.headers.get('vary')).toContain('x-oxy-session-authority');
    expect(await active.json()).toMatchObject({ liveSessionAuthority: 'session-row-v1' });
    expect((await request()).status).toBe(200);
    await getDb()
      .update(sessions)
      .set({ isActive: false })
      .where(eq(sessions.sessionId, session.sessionId));
    const [stored] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, session.sessionId));
    expect(stored.isActive).toBe(false);
    expect(sessionCache.get(session.sessionId)?.isActive).toBe(true);
    const revoked = await direct();
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect(await revoked.json()).toMatchObject({ error: { code: 'OXY_LIVE_SESSION_INVALID_V1' } });
    expect((await request()).status).toBe(401);
  } finally {
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closePostgres();
  }
});

it('propagates a real live-row failure as 503 without clearing Core credentials', async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'fresh-local-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const app = express();
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServer({ baseURL, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  const client = new OxyServices({ baseURL, requestTimeout: 15000 });
  client.session.setAccessToken(session.accessToken);
  const epoch = client.http.getSessionEpoch();
  const secret = process.env.ACCESS_TOKEN_SECRET;
  const select = jest.spyOn(getDb(), 'select').mockImplementation(() => {
    throw new Error('synthetic live-row outage');
  });
  try {
    const direct = await fetch(`${baseURL}/session/validate-header/${session.sessionId}`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'x-oxy-session-authority': 'live-v1',
      },
    });
    expect(direct.status).toBe(503);
    expect(direct.headers.get('cache-control')).toBe('no-store');
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    expect(client.session.accessToken).toBe(session.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
    select.mockRestore();
    delete process.env.ACCESS_TOKEN_SECRET;
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    expect(client.session.accessToken).toBe(session.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    process.env.ACCESS_TOKEN_SECRET = secret;
    select.mockRestore();
    client.dispose();
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closePostgres();
  }
}, 20000);

it('keeps credentials when user or supervision authority is unavailable', async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'fresh-local-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const app = express();
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServer({ baseURL, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  const client = new OxyServices({ baseURL, requestTimeout: 15000 });
  client.session.setAccessToken(session.accessToken);
  const epoch = client.http.getSessionEpoch();
  try {
    userCache.invalidateLocal(user.id);
    const cachedUser = jest.spyOn(userCache, 'get').mockReturnValue(undefined);
    const readUser = jest
      .spyOn(userService, 'readAccountDocument')
      .mockRejectedValue(new Error('user unavailable'));
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    readUser.mockRestore();
    cachedUser.mockRestore();
    const readSupervision = jest
      .spyOn(supervisionPolicy, 'supervisionValidAfter')
      .mockRejectedValue(new Error('supervision unavailable'));
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 503 },
    );
    readSupervision.mockRestore();
    expect(client.session.accessToken).toBe(session.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    jest.restoreAllMocks();
    client.dispose();
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closePostgres();
  }
}, 20000);

it('does not bypass or silently downgrade supervised-session policy', async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const user = await insertAccountFixture({
    username: `u-${randomUUID().slice(0, 12)}`,
    privacyIsPrivateAccount: true,
  });
  await getDb()
    .insert(supervisionProfiles)
    .values({
      childAccountId: user.id,
      status: 'orphaned',
      consentVersion: '1',
      sessionsValidAfter: new Date(Date.now() - 3_600_000),
    });
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'fresh-local-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const app = express();
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServer({ baseURL, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  app.get(
    '/reviewed',
    oxy.middleware.auth({ liveSession: true, supervisedAction: 'profile' }),
    (_req, res) => res.json({ ok: true }),
  );
  const client = new OxyServices({ baseURL, requestTimeout: 15000 });
  client.session.setAccessToken(session.accessToken);
  const epoch = client.http.getSessionEpoch();
  try {
    const direct = await fetch(`${baseURL}/session/validate-header/${session.sessionId}`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'x-oxy-session-authority': 'live-v1',
      },
    });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ error: { code: 'OXY_LIVE_SESSION_POLICY_V1' } });
    expect(direct.headers.get('cache-control')).toBe('no-store');
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      client.http.get('/reviewed', { retry: false, cache: false }),
    ).rejects.toMatchObject({ status: 503 });
    const reader = sessionService as unknown as {
      readLiveSessionRow(id: string): Promise<CachedSession | null>;
    };
    const original = reader.readLiveSessionRow.bind(sessionService);
    let reads = 0;
    const secondRead = jest.spyOn(reader, 'readLiveSessionRow').mockImplementation(async (id) => {
      if (++reads >= 2) throw new Error('second authority read unavailable');
      return original(id);
    });
    await expect(client.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject(
      {
        status: 503,
      },
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    secondRead.mockRestore();
    expect(client.session.accessToken).toBe(session.accessToken);
    expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    client.dispose();
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closePostgres();
  }
}, 20000);

it('allows a request whose live row was read before revocation to finish', async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'fresh-local-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const app = express();
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServer({ baseURL, maxRetries: 1, retryDelay: 1 });
  app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
    res.json({ ok: true }),
  );
  let release: () => void = () => {};
  let rowRead: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    rowRead = resolve;
  });
  const liveReader = sessionService as unknown as {
    readLiveSessionRow(id: string): Promise<CachedSession | null>;
  };
  const original = liveReader.readLiveSessionRow.bind(sessionService);
  const read = jest
    .spyOn(liveReader, 'readLiveSessionRow')
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      rowRead();
      await paused;
      return result;
    });
  try {
    const request = () =>
      fetch(`${baseURL}/private`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    const prior = request();
    await readStarted;
    await getDb()
      .update(sessions)
      .set({ isActive: false })
      .where(eq(sessions.sessionId, session.sessionId));
    expect((await request()).status).toBe(401);
    release();
    expect((await prior).status).toBe(200);
    expect((await request()).status).toBe(401);
  } finally {
    release();
    read.mockRestore();
    oxy.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closePostgres();
  }
}, 20000);
