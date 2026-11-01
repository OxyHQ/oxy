import type { Request } from 'express';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

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

import { OxyServices } from '@oxy.so/core';
import { OxyServer } from '@oxy.so/core/server';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { SessionController } from '../../controllers/session.controller';
import { authMiddleware, simpleAuthMiddleware } from '../../middleware/auth';
import { validateSessionToken } from '../../middleware/authUtils';
import { SessionAuthorityUnavailableError } from '../../utils/error';
import sessionService from '../session.service';

let server: http.Server;
let baseURL: string;
let oxyServer: OxyServer;

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.get('/private', authMiddleware, (_req, res) => res.json({ ok: true }));
  app.get('/simple', simpleAuthMiddleware, (_req, res) => res.json({ ok: true }));
  app.get('/session/validate/:sessionId', SessionController.validateSession);
  app.get('/session/validate-header/:sessionId', SessionController.validateSessionFromHeader);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  oxyServer = new OxyServer({ baseURL });
  app.get('/core-required', oxyServer.middleware.auth(), (_req, res) => res.json({ ok: true }));
  app.get('/core-optional', oxyServer.middleware.auth({ optional: true }), (_req, res) =>
    res.json({ ok: true }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
  oxyServer.dispose();
});

it.each(['/core-required', '/core-optional'])(
  '%s preserves bearer when real Core middleware receives a 503',
  async (path) => {
    const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const created = await sessionService.createSession(
      user.id,
      { headers: { 'user-agent': 'session-authority-test' } } as Request,
      { deviceId: `dev-${randomUUID()}` },
    );
    const oxy = new OxyServices({ baseURL });
    oxy.session.setAccessToken(created.accessToken);
    const epoch = oxy.http.getSessionEpoch();
    const select = jest.spyOn(getDb(), 'select').mockImplementation(() => {
      throw new Error('synthetic database failure');
    });
    try {
      await expect(
        oxy.http.get(path, { retry: false, cache: false, timeout: 15_000 }),
      ).rejects.toMatchObject({ status: 503 });
      expect(oxy.session.accessToken).toBe(created.accessToken);
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
    } finally {
      select.mockRestore();
      oxy.dispose();
    }
  },
  20_000,
);

it('returns a transient error without clearing the real Core bearer', async () => {
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const req = { headers: { 'user-agent': 'session-authority-test' } } as Request;
  const created = await sessionService.createSession(user.id, req, {
    deviceId: `dev-${randomUUID()}`,
  });
  const oxy = new OxyServices({ baseURL });
  oxy.session.setAccessToken(created.accessToken);
  const epoch = oxy.http.getSessionEpoch();
  const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
    throw new Error('synthetic database failure');
  });
  try {
    await expect(oxy.http.get('/private', { retry: false, cache: false })).rejects.toMatchObject({
      status: 503,
    });
    expect(oxy.session.accessToken).toBe(created.accessToken);
    expect(oxy.http.getSessionEpoch()).toBe(epoch);
  } finally {
    select.mockRestore();
    oxy.dispose();
  }
});

it('propagates unavailable authority through the shared token helper', async () => {
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const created = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'session-authority-test' } } as Request,
    { deviceId: `dev-${randomUUID()}` },
  );
  const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
    throw new Error('synthetic database failure');
  });
  try {
    await expect(validateSessionToken(created.accessToken)).rejects.toBeInstanceOf(
      SessionAuthorityUnavailableError,
    );
  } finally {
    select.mockRestore();
  }
});

it.each([
  '/private',
  '/simple',
  '/session/validate-header/:sessionId',
  '/session/validate/:sessionId',
])('%s returns 503 when session authority is unavailable', async (route) => {
  const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const req = { headers: { 'user-agent': 'session-authority-test' } } as Request;
  const created = await sessionService.createSession(user.id, req, {
    deviceId: `dev-${randomUUID()}`,
  });
  const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
    throw new Error('synthetic database failure');
  });
  try {
    const url = route.replace(':sessionId', created.sessionId);
    const response = await fetch(`${baseURL}${url}`, {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(response.status).toBe(503);
  } finally {
    select.mockRestore();
  }
});

it('returns 503 for the legacy no-bearer validation endpoint when the database fails', async () => {
  const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
    throw new Error('synthetic database failure');
  });
  try {
    const response = await fetch(`${baseURL}/session/validate-header/${randomUUID()}`);
    expect(response.status).toBe(503);
  } finally {
    select.mockRestore();
  }
});
