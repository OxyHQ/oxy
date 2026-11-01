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
import { isInvalidSessionError } from '../../../../services/src/ui/utils/errorHandlers';
import { permissionsForAccountRole } from '../../utils/accountRoles';
import * as serviceEvents from '../../utils/serviceEvents';
import * as revocation from '../../services/sessionRevocation.service';

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

it.each(['editor', 'admin'] as const)(
  'keeps session management scoped for a delegated %s',
  async (role) => {
    const alice = await account();
    const bob = await account();
    const bystander = await account();
    const org = await account({ kind: 'organization', parentAccountId: bob, rootAccountId: bob });
    await getDb().execute(
      sql`insert into user_ancestors (user_id, depth, ancestor_id) values (${org}, 0, ${bob})`,
    );
    await getDb()
      .insert(accountMembers)
      .values([
        { accountId: org, memberUserId: alice, role, status: 'active' },
        { accountId: org, memberUserId: bob, role: 'owner', status: 'active' },
      ]);
    expect(permissionsForAccountRole('editor')).toContain('account:act_as');
    expect(permissionsForAccountRole('editor')).not.toContain('members:remove');
    expect(permissionsForAccountRole('editor')).not.toContain('account:update');

    const deviceA = `dev-a-${randomUUID()}`;
    const deviceB = `dev-b-${randomUUID()}`;
    const deviceC = `dev-c-${randomUUID()}`;
    const deviceD = `dev-d-${randomUUID()}`;
    const deviceE = `dev-e-${randomUUID()}`;
    const deviceF = `dev-f-${randomUUID()}`;
    const a = await makeSession(org, deviceA, alice);
    const b = await makeSession(org, deviceB, bob);
    const bobPersonal = await makeSession(bob, deviceB);
    const sameDeviceBob = await makeSession(org, deviceA, bob);
    const sameDeviceBob2 = await makeSession(org, deviceA, bob);
    const otherBob = await makeSession(org, deviceD, bob);
    const personal = await makeSession(alice, deviceA);
    const other = await makeSession(bystander, deviceB);
    const sameDevice = await makeSession(bystander, deviceA);
    const anotherAlice = await makeSession(org, deviceC, alice);
    const aliceForBulk = await makeSession(org, deviceE, alice);
    const moving = await makeSession(org, deviceF, alice);

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
    expect(
      (await call('GET', `/device/sessions/sess-${randomUUID()}`, a.accessToken)).body,
    ).toEqual(expect.objectContaining({ code: 'ACTING_SESSION_MISMATCH' }));
    expect(
      (await call('PUT', `/device/name/${a.sessionId}`, a.accessToken, { deviceName: 'My device' }))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', `/logout/${a.sessionId}/${other.sessionId}`, a.accessToken)).status,
    ).toBe(404);
    expect((await call('GET', `/device/sessions/${b.sessionId}`, b.accessToken)).status).toBe(200);
    const list = await call('GET', `/sessions/${a.sessionId}`, a.accessToken);
    expect(list.status).toBe(200);
    expect((await call('GET', `/sessions/${b.sessionId}`, a.accessToken)).status).toBe(403);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: a.sessionId }),
        expect.objectContaining({ sessionId: anotherAlice.sessionId }),
        expect.objectContaining({ sessionId: sameDeviceBob.sessionId }),
      ]),
    );
    for (const otherSession of [b.sessionId, otherBob.sessionId]) {
      expect(list.body).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: otherSession })]),
      );
    }

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
      (
        await call(
          'GET',
          `/device/sessions/${activeSessionIdOf(state, alice)}`,
          personal.accessToken,
        )
      ).status,
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
    expect(isInvalidSessionError(clientError)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(client.getAccessToken()).toBe(a.accessToken);
    expect(client.getSessionEpoch()).toBe(beforeEpoch);
    client.dispose();
    const pivotAttempts = [
      await call('GET', `/device/sessions/${b.sessionId}`, a.accessToken),
      await call('PUT', `/device/name/${b.sessionId}`, a.accessToken, { deviceName: 'hijacked' }),
      await call('POST', `/device/logout-all/${b.sessionId}`, a.accessToken),
      await call('POST', `/logout/${b.sessionId}`, a.accessToken),
      await call('POST', `/logout/${b.sessionId}/${other.sessionId}`, a.accessToken),
      await call('POST', `/logout-all/${b.sessionId}`, a.accessToken),
    ];
    expect(pivotAttempts.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    expect(pivotAttempts.map((response) => response.body)).toEqual(
      Array.from({ length: 6 }, () => expect.objectContaining({ code: 'ACTING_SESSION_MISMATCH' })),
    );
    const [row] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(and(eq(sessions.sessionId, other.sessionId), eq(sessions.userId, bystander)));
    expect(row.isActive).toBe(true);

    // The row can move after its first read; the write must still enforce scope.
    let release!: () => void;
    let reached!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const realDeactivate = sessionService.deactivateSession.bind(sessionService);
    const intercepted = jest
      .spyOn(sessionService, 'deactivateSession')
      .mockImplementationOnce(async (...args) => {
        reached();
        await delayed;
        return realDeactivate(...args);
      });
    const race = call('POST', `/logout/${a.sessionId}/${moving.sessionId}`, a.accessToken);
    await atWrite;
    await getDb()
      .update(sessions)
      .set({ operatedByUserId: bob, deviceId: deviceB })
      .where(eq(sessions.sessionId, moving.sessionId));
    release();
    expect((await race).status).toBe(404);
    intercepted.mockRestore();
    const [moved] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, moving.sessionId));
    expect(moved.isActive).toBe(true);

    // A migration of the acting session while a request waits must also close it.
    const migrating = await makeSession(org, `dev-g-${randomUUID()}`, alice);
    const migrationTarget = await makeSession(org, `dev-h-${randomUUID()}`, alice);
    let releaseMigration!: () => void;
    let migrationReached!: () => void;
    const migrationDelay = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const beforeMigration = new Promise<void>((resolve) => {
      migrationReached = resolve;
    });
    const migrationSpy = jest
      .spyOn(sessionService, 'deactivateSession')
      .mockImplementationOnce(async (...args) => {
        migrationReached();
        await migrationDelay;
        return realDeactivate(...args);
      });
    const migrationRequest = call(
      'POST',
      `/logout/${migrating.sessionId}/${migrationTarget.sessionId}`,
      migrating.accessToken,
    );
    await beforeMigration;
    await getDb()
      .update(sessions)
      .set({ deviceId: `dev-moved-${randomUUID()}` })
      .where(eq(sessions.sessionId, migrating.sessionId));
    releaseMigration();
    expect((await migrationRequest).status).toBe(403);
    migrationSpy.mockRestore();
    const [afterMigration] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, migrationTarget.sessionId));
    expect(afterMigration.isActive).toBe(true);
    await sessionService.deactivateSession(migrating.sessionId);
    await sessionService.deactivateSession(migrationTarget.sessionId);

    const bulkCaller = await makeSession(org, `dev-bulk-${randomUUID()}`, alice);
    const bulkTarget = await makeSession(org, `dev-bulk-target-${randomUUID()}`, alice);
    let releaseBulk!: () => void;
    let reachedBulk!: () => void;
    const bulkDelay = new Promise<void>((resolve) => {
      releaseBulk = resolve;
    });
    const beforeBulk = new Promise<void>((resolve) => {
      reachedBulk = resolve;
    });
    const realBulk = sessionService.deactivateActorSessions.bind(sessionService);
    const bulkSpy = jest
      .spyOn(sessionService, 'deactivateActorSessions')
      .mockImplementationOnce(async (...args) => {
        reachedBulk();
        await bulkDelay;
        return realBulk(...args);
      });
    const bulkRequest = call('POST', `/logout-all/${bulkCaller.sessionId}`, bulkCaller.accessToken);
    await beforeBulk;
    await getDb()
      .update(sessions)
      .set({ deviceId: `dev-moved-${randomUUID()}` })
      .where(eq(sessions.sessionId, bulkCaller.sessionId));
    releaseBulk();
    expect((await bulkRequest).status).toBe(403);
    bulkSpy.mockRestore();
    const [afterBulk] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, bulkTarget.sessionId));
    expect(afterBulk.isActive).toBe(true);
    await sessionService.deactivateSession(bulkCaller.sessionId);
    await sessionService.deactivateSession(bulkTarget.sessionId);

    // A valid acting session may revoke its actor's other sessions and sessions
    // on its own device, while a different actor's remote session stays active.
    expect(
      (await call('POST', `/logout/${a.sessionId}/${anotherAlice.sessionId}`, a.accessToken))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', `/logout/${a.sessionId}/${sameDevice.sessionId}`, a.accessToken)).status,
    ).toBe(200);
    expect(
      (await call('POST', `/logout/${a.sessionId}/${b.sessionId}`, a.accessToken)).status,
    ).toBe(404);
    expect(
      (await call('POST', `/logout/${a.sessionId}/${sameDeviceBob2.sessionId}`, a.accessToken))
        .status,
    ).toBe(200);
    const published = jest.spyOn(serviceEvents, 'publishSessionRevocation');
    published.mockClear();
    expect((await call('POST', `/logout-all/${a.sessionId}`, a.accessToken)).status).toBe(200);
    expect(published.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ userId: org, sessionId: aliceForBulk.sessionId }),
    ]);
    published.mockRestore();
    const [stillActive] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, a.sessionId));
    expect(stillActive.isActive).toBe(true);
    const [otherOperator] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, otherBob.sessionId));
    expect(otherOperator.isActive).toBe(true);
    const [otherPersonal] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, bobPersonal.sessionId));
    expect(otherPersonal.isActive).toBe(true);
    expect((await call('POST', `/device/logout-all/${a.sessionId}`, a.accessToken)).status).toBe(
      200,
    );
  },
);

it('deadlock while two sessions cross-revoke rolls back one transaction', async () => {
  const owner = await account();
  const first = await makeSession(owner, `first-${randomUUID()}`);
  const second = await makeSession(owner, `second-${randomUUID()}`);
  const realWrite = revocation.deactivateSessionRows;
  let calls = 0;
  let release!: () => void;
  const bothLocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writeSpy = jest
    .spyOn(revocation, 'deactivateSessionRows')
    .mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) release();
      await bothLocked;
      return realWrite(...args);
    });
  const published = jest.spyOn(serviceEvents, 'publishSessionRevocation');
  published.mockClear();
  const results = await Promise.all([
    call('POST', `/logout/${first.sessionId}/${second.sessionId}`, first.accessToken),
    call('POST', `/logout/${second.sessionId}/${first.sessionId}`, second.accessToken),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 500]);
  expect(published).toHaveBeenCalledTimes(1);
  const states = await getDb()
    .select({ isActive: sessions.isActive })
    .from(sessions)
    .where(sql`${sessions.sessionId} IN (${first.sessionId}, ${second.sessionId})`);
  expect(states.map((row) => row.isActive).sort()).toEqual([false, true]);
  writeSpy.mockRestore();
  published.mockRestore();
});

it.each(['bulk', 'single'] as const)(
  'deadlock between device logout and %s aborts without partial announcements',
  async (otherKind) => {
    const owner = await account();
    const device = `shared-${randomUUID()}`;
    const first = await makeSession(owner, device);
    // A second principal supplies an independent acting row on the same device.
    const second = await makeSession(await account(), device);
    const realWrite = revocation.deactivateSessionRows;
    let calls = 0;
    let release!: () => void;
    const bothLocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeSpy = jest
      .spyOn(revocation, 'deactivateSessionRows')
      .mockImplementation(async (...args) => {
        calls++;
        if (calls === 2) release();
        await bothLocked;
        return realWrite(...args);
      });
    const published = jest.spyOn(serviceEvents, 'publishSessionRevocation');
    published.mockClear();
    const results = await Promise.all([
      call('POST', `/device/logout-all/${first.sessionId}`, first.accessToken),
      otherKind === 'bulk'
        ? call('POST', `/device/logout-all/${second.sessionId}`, second.accessToken)
        : call('POST', `/logout/${second.sessionId}/${first.sessionId}`, second.accessToken),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 500]);
    const states = await getDb()
      .select({ sessionId: sessions.sessionId, isActive: sessions.isActive })
      .from(sessions)
      .where(sql`${sessions.sessionId} IN (${first.sessionId}, ${second.sessionId})`);
    const ended = states
      .filter((row) => !row.isActive)
      .map((row) => row.sessionId)
      .sort();
    const announced = published.mock.calls.map(([event]) => event.sessionId).sort();
    expect(announced).toEqual(ended);
    expect(new Set(announced).size).toBe(announced.length);
    writeSpy.mockRestore();
    published.mockRestore();
  },
);

it.each(['list', 'logout', 'rename'] as const)(
  'a pending device %s refuses a migrated acting session',
  async (operation) => {
    const user = await account();
    const other = await account();
    const oldDevice = `old-${randomUUID()}`;
    const acting = await makeSession(user, oldDevice);
    const otherSession = await makeSession(other, oldDevice);
    const [before] = await getDb()
      .select({ deviceName: sessions.deviceName })
      .from(sessions)
      .where(eq(sessions.sessionId, acting.sessionId));
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const real = sessionService.validateSessionById.bind(sessionService);
    const spy = jest
      .spyOn(sessionService, 'validateSessionById')
      .mockImplementationOnce(async (...args) => {
        const value = await real(...args);
        reached();
        await gate;
        return value;
      });
    const request =
      operation === 'list'
        ? call('GET', `/device/sessions/${acting.sessionId}`, acting.accessToken)
        : operation === 'logout'
          ? call('POST', `/device/logout-all/${acting.sessionId}`, acting.accessToken)
          : call('PUT', `/device/name/${acting.sessionId}`, acting.accessToken, {
              deviceName: 'Renamed',
            });
    await read;
    await getDb()
      .update(sessions)
      .set({ deviceId: `new-${randomUUID()}` })
      .where(eq(sessions.sessionId, acting.sessionId));
    release();
    const response = await request;
    spy.mockRestore();
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'ACTING_SESSION_MISMATCH' });
    if (operation === 'list') {
      expect(response.body).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: otherSession.sessionId })]),
      );
    } else if (operation === 'logout') {
      const [row] = await getDb()
        .select({ isActive: sessions.isActive })
        .from(sessions)
        .where(eq(sessions.sessionId, otherSession.sessionId));
      expect(row.isActive).toBe(true);
    } else {
      const [row] = await getDb()
        .select({ deviceName: sessions.deviceName })
        .from(sessions)
        .where(eq(sessions.sessionId, acting.sessionId));
      expect(row.deviceName).toBe(before.deviceName);
    }
  },
);

it('a pending account-session list refuses a migrated acting session', async () => {
  const owner = await account();
  const editor = await account();
  const org = await account({ kind: 'organization', parentAccountId: owner, rootAccountId: owner });
  await getDb().execute(
    sql`insert into user_ancestors (user_id, depth, ancestor_id) values (${org}, 0, ${owner})`,
  );
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: org, memberUserId: owner, role: 'owner', status: 'active' },
      { accountId: org, memberUserId: editor, role: 'editor', status: 'active' },
    ]);
  const oldDevice = `old-${randomUUID()}`;
  const acting = await makeSession(org, oldDevice, editor);
  const other = await makeSession(org, oldDevice, owner);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const real = sessionService.validateSessionById.bind(sessionService);
  const spy = jest
    .spyOn(sessionService, 'validateSessionById')
    .mockImplementationOnce(async (...args) => {
      const value = await real(...args);
      reached();
      await gate;
      return value;
    });
  const request = call('GET', `/sessions/${acting.sessionId}`, acting.accessToken);
  await read;
  await getDb()
    .update(sessions)
    .set({ deviceId: `new-${randomUUID()}` })
    .where(eq(sessions.sessionId, acting.sessionId));
  release();
  const response = await request;
  spy.mockRestore();
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: 'ACTING_SESSION_MISMATCH' });
  expect(response.body).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ sessionId: other.sessionId })]),
  );
});
