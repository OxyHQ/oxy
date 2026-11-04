import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq } from 'drizzle-orm';

const mockExchangeAuthCode = jest.fn();
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/oauthCode.service', () => {
  const actual = jest.requireActual<typeof import('../../services/oauthCode.service')>(
    '../../services/oauthCode.service',
  );
  return { ...actual, exchangeAuthCode: (...args: unknown[]) => mockExchangeAuthCode(...args) };
});
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import * as serviceEvents from '../../utils/serviceEvents';
import authRouter from '../auth';
import devicesRouter from '../devices';

let server: http.Server;
let base: string;
const requestFixture = { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never;

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/auth', authRouter);
  app.use('/devices', devicesRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

it('lists personal devices, revokes a remote session, and announces its invalidation', async () => {
  const person = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const current = await sessionService.createSession(person.id, requestFixture, {
    deviceId: `fixture-${randomUUID()}`,
  });
  const remote = await sessionService.createSession(person.id, requestFixture, {
    deviceId: `fixture-${randomUUID()}`,
  });
  const token = await sessionService.getAccessToken(current.sessionId);
  const remoteToken = await sessionService.getAccessToken(remote.sessionId);
  if (!token || !remoteToken) throw new Error('missing fixture token');
  const headers = { Authorization: `Bearer ${token.accessToken}` };
  const announcements = jest.spyOn(serviceEvents, 'publishSessionRevocation');
  try {
    const response = await fetch(`${base}/devices`, { headers });
    expect(response.status).toBe(200);
    const devices = (await response.json()) as { deviceId: string; isCurrent: boolean }[];
    expect(devices.map((device) => device.deviceId).sort()).toEqual(
      [current.deviceId, remote.deviceId].sort(),
    );
    expect(devices.find((device) => device.deviceId === current.deviceId)?.isCurrent).toBe(true);
    const remoteHeaders = { Authorization: `Bearer ${remoteToken.accessToken}` };
    expect((await fetch(`${base}/devices`, { headers: remoteHeaders })).status).toBe(200);
    const removed = await fetch(`${base}/devices/${remote.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    expect(removed.status).toBe(200);
    const [row] = await getDb()
      .select({ active: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, remote.sessionId));
    expect(row.active).toBe(false);
    expect(announcements).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: remote.sessionId, userId: person.id }),
    );
    const revoked = await fetch(`${base}/devices`, { headers: remoteHeaders });
    expect(revoked.status).toBe(401);
  } finally {
    announcements.mockRestore();
  }
});

it.each([
  ['first_party', 'first_party', 200],
  ['third_party', 'external', 403],
  ['first_party', 'external', 403],
] as const)(
  'preserves device management for the %s OAuth %s lane',
  async (type, authority, expectedStatus) => {
    const person = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const redirectUri = 'https://fixture.invalid/oauth/callback';
    const [application] = await getDb()
      .insert(applications)
      .values({
        name: `fixture-${randomUUID()}`,
        type,
        ownerAccountId: person.id,
        redirectUris: [redirectUri],
      })
      .returning({ id: applications.id });
    const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
    await getDb().insert(applicationCredentials).values({
      applicationId: application.id,
      name: 'fixture',
      type: 'public',
      environment: 'production',
      publicKey: clientId,
    });
    const remote = await sessionService.createSession(person.id, requestFixture, {
      deviceId: `fixture-${randomUUID()}`,
    });
    const ownDevice = `fixture-${randomUUID()}`;
    mockExchangeAuthCode.mockResolvedValueOnce({
      ok: true,
      code: {
        userId: person.id,
        deviceId: ownDevice,
        operatedByUserId: null,
        scopes: [],
        authority,
      },
    });
    const exchange = await fetch(`${base}/auth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: `fixture-${randomUUID()}`,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: 'a'.repeat(64),
      }),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${body.access_token}` };
    const listed = await fetch(`${base}/devices`, { headers });
    expect(listed.status).toBe(200);
    const devices = (await listed.json()) as { deviceId: string; isCurrent: boolean }[];
    expect(devices.some((device) => device.isCurrent)).toBe(true);
    expect(devices.some((device) => device.deviceId === remote.deviceId)).toBe(
      authority === 'first_party',
    );
    const removed = await fetch(`${base}/devices/${remote.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    expect(removed.status).toBe(expectedStatus);
    const [row] = await getDb()
      .select({ active: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, remote.sessionId));
    expect(row.active).toBe(expectedStatus !== 200);
  },
);
