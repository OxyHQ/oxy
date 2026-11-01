import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/socket', () => ({ broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn(), logSignOut: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { accountMembers } from '../../db/schema/accountMembers';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import sessionRouter from '../session';
import { HttpService } from '../../../../core/src/HttpService';
import { activeSessionIdOf } from '../../../../core/src/session/projectSessionState';

jest.setTimeout(60_000);
let server: http.Server;
const legacyWindow = process.env.ACCESS_TOKEN_V1_WINDOW;

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await insertAccountFixtures(
    { username: `u${randomUUID().replace(/-/g, '').slice(0, 14)}`, ...over },
    { id: users.id },
  );
  return row.id;
}

async function makeSession(userId: string, deviceId: string, operatedByUserId?: string) {
  return sessionService.createSession(userId, { headers: { 'user-agent': 'jest' } } as never, {
    deviceId,
    ...(operatedByUserId ? { operatedByUserId } : {}),
  });
}

async function call(method: string, path: string, bearer: string, body?: unknown) {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/session${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  delete process.env.ACCESS_TOKEN_V1_WINDOW;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/session', sessionRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
  if (legacyWindow === undefined) delete process.env.ACCESS_TOKEN_V1_WINDOW;
  else process.env.ACCESS_TOKEN_V1_WINDOW = legacyWindow;
});

it('requires the bearer session as the acting session while preserving explicit targets', async () => {
  const alice = await account();
  const bob = await account();
  const bystander = await account();
  const org = await account({ kind: 'organization', parentAccountId: alice, rootAccountId: alice });
  await getDb().execute(
    sql`insert into user_ancestors (user_id, depth, ancestor_id) values (${org}, 0, ${alice})`,
  );
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: org, memberUserId: alice, role: 'owner', status: 'active' },
      { accountId: org, memberUserId: bob, role: 'editor', status: 'active' },
    ]);

  const deviceA = `dev-a-${randomUUID()}`;
  const deviceB = `dev-b-${randomUUID()}`;
  const deviceC = `dev-c-${randomUUID()}`;
  const a = await makeSession(org, deviceA, alice);
  const b = await makeSession(org, deviceB, bob);
  const sameDeviceBob = await makeSession(org, deviceA, bob);
  const personal = await makeSession(alice, deviceA);
  const other = await makeSession(bystander, deviceB);
  const sameDevice = await makeSession(bystander, deviceA);
  const anotherAlice = await makeSession(org, deviceC, alice);
  const [before] = await getDb()
    .select({ deviceName: sessions.deviceName, isActive: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, b.sessionId));

  expect((await call('GET', `/device/sessions/${a.sessionId}`, a.accessToken)).status).toBe(200);
  expect((await call('GET', `/device/sessions/${a.sessionId}`, '')).status).toBe(401);
  const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
  const legacy = jwt.sign(
    { userId: org, sessionId: a.sessionId, deviceId: deviceA, type: 'access' },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '15m' },
  );
  expect((await call('GET', `/device/sessions/${a.sessionId}`, legacy)).status).toBe(200);
  expect((await call('GET', `/device/sessions/${b.sessionId}`, legacy)).status).toBe(403);
  expect((await call('GET', `/device/sessions/sess-${randomUUID()}`, a.accessToken)).body).toEqual(
    expect.objectContaining({ code: 'ACTING_SESSION_MISMATCH' }),
  );
  expect(
    (await call('PUT', `/device/name/${a.sessionId}`, a.accessToken, { deviceName: 'My device' }))
      .status,
  ).toBe(200);
  expect(
    (await call('POST', `/logout/${a.sessionId}/${other.sessionId}`, a.accessToken)).status,
  ).toBe(404);
  expect((await call('GET', `/device/sessions/${b.sessionId}`, b.accessToken)).status).toBe(200);

  // Identity-pinned clients can project their own account while the shared
  // device's active subject is different. A unique session remains usable.
  const state = {
    deviceId: deviceA,
    revision: 1,
    updatedAt: Date.now(),
    activeAccountId: bystander,
    accounts: [
      { accountId: alice, sessionId: personal.sessionId, authuser: 0 },
      { accountId: bystander, sessionId: sameDevice.sessionId, authuser: 1 },
    ],
  };
  expect(activeSessionIdOf(state, alice)).toBe(personal.sessionId);
  expect(
    (await call('GET', `/device/sessions/${activeSessionIdOf(state, alice)}`, personal.accessToken))
      .status,
  ).toBe(200);

  // A legacy projection cannot disambiguate two actors for one subject.
  // The actual client receives 403 and must keep the current bearer rather
  // than attempting a 401 refresh or treating the account as signed out.
  const ambiguous = {
    ...state,
    activeAccountId: org,
    accounts: [
      { accountId: org, sessionId: sameDeviceBob.sessionId, authuser: 2, operatedByUserId: bob },
      { accountId: org, sessionId: a.sessionId, authuser: 3, operatedByUserId: alice },
      ...state.accounts,
    ],
  };
  expect(activeSessionIdOf(ambiguous)).toBe(sameDeviceBob.sessionId);
  const address = server.address() as AddressInfo;
  const client = new HttpService({
    baseURL: `http://127.0.0.1:${address.port}/session`,
    enableCache: false,
  });
  client.setTokens(a.accessToken);
  const refresh = jest.fn(async () => null);
  client.setAuthRefreshHandler(refresh);
  const beforeEpoch = client.getSessionEpoch();
  const clientError = await client
    .request({
      method: 'GET',
      url: `/device/sessions/${activeSessionIdOf(ambiguous)}`,
      retry: false,
    })
    .catch((error: unknown) => error);
  expect(clientError).toMatchObject({ status: 403, code: 'ACTING_SESSION_MISMATCH' });
  expect(refresh).not.toHaveBeenCalled();
  expect(client.getAccessToken()).toBe(a.accessToken);
  expect(client.getSessionEpoch()).toBe(beforeEpoch);
  client.dispose();
  const mismatchedRequests = [
    await call('GET', `/device/sessions/${b.sessionId}`, a.accessToken),
    await call('PUT', `/device/name/${b.sessionId}`, a.accessToken, { deviceName: 'New name' }),
    await call('POST', `/device/logout-all/${b.sessionId}`, a.accessToken),
    await call('POST', `/logout/${b.sessionId}`, a.accessToken),
    await call('POST', `/logout/${b.sessionId}/${other.sessionId}`, a.accessToken),
    await call('POST', `/logout-all/${b.sessionId}`, a.accessToken),
  ];
  expect(mismatchedRequests.map((response) => response.status)).toEqual([
    403, 403, 403, 403, 403, 403,
  ]);
  expect(mismatchedRequests.map((response) => response.body)).toEqual(
    Array.from({ length: 6 }, () => expect.objectContaining({ code: 'ACTING_SESSION_MISMATCH' })),
  );
  const [row] = await getDb()
    .select({ isActive: sessions.isActive })
    .from(sessions)
    .where(and(eq(sessions.sessionId, other.sessionId), eq(sessions.userId, bystander)));
  expect(row.isActive).toBe(true);
  const [after] = await getDb()
    .select({ deviceName: sessions.deviceName, isActive: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, b.sessionId));
  expect(after).toEqual(before);

  // A valid acting session can still revoke its own other session and a
  // session on its device through explicit targets.
  expect(
    (await call('POST', `/logout/${a.sessionId}/${anotherAlice.sessionId}`, a.accessToken)).status,
  ).toBe(200);
  expect(
    (await call('POST', `/logout/${a.sessionId}/${sameDevice.sessionId}`, a.accessToken)).status,
  ).toBe(200);
  expect((await call('POST', `/logout/${b.sessionId}`, b.accessToken)).status).toBe(200);
  expect(
    (await call('POST', `/logout/${sameDeviceBob.sessionId}`, sameDeviceBob.accessToken)).status,
  ).toBe(200);
  expect((await call('POST', `/logout-all/${a.sessionId}`, a.accessToken)).status).toBe(200);
  const [stillActive] = await getDb()
    .select({ isActive: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, a.sessionId));
  expect(stillActive.isActive).toBe(true);
  expect((await call('POST', `/device/logout-all/${a.sessionId}`, a.accessToken)).status).toBe(200);
});
