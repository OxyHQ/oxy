import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';

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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { sessions } from '../../db/schema/sessions';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { devicePrincipals } from '../../db/schema/devicePrincipals';
import { ServiceUnavailableError } from '../../utils/error';
import sessionCache from '../../utils/sessionCache';
import { accountService } from '../account.service';
import * as organizationAuthority from '../organizationAuthority.service';
import * as agentKeyAuthority from '../agentKeyAuthority.service';
import deviceSessionService from '../deviceSession.service';
import sessionService from '../session.service';
import sessionDeviceRouter from '../../routes/sessionDevice';
import { errorHandler } from '../../middleware/errorHandler';

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
});

afterAll(closePostgres);

it('preserves the device during a real membership read failure and heals a confirmed revocation', async () => {
  const operator = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const deviceId = `dev-${randomUUID()}`;
  const created = await sessionService.createSession(
    account.id,
    { headers: { 'user-agent': 'authority-outage-test' } } as Request,
    { deviceId, operatedByUserId: operator.id },
  );
  await deviceSessionService.addAccount(deviceId, {
    accountId: account.id,
    sessionId: created.sessionId,
    operatedByUserId: operator.id,
  });

  const original = accountService.verifyActingAs.bind(accountService);
  let failures = 0;
  const verify = jest
    .spyOn(accountService, 'verifyActingAs')
    .mockImplementation(async (...args) => {
      const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
        failures += 1;
        throw new Error('synthetic membership database outage');
      });
      try {
        return await original(...args);
      } finally {
        select.mockRestore();
      }
    });
  try {
    await expect(deviceSessionService.getState(deviceId)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(failures).toBe(1);
  } finally {
    verify.mockRestore();
  }

  const [device] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId));
  const contexts = await getDb()
    .select()
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
  const [beforeRecovery] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, created.sessionId));
  expect(contexts).toHaveLength(1);
  expect(device.activeContextId).toBe(contexts[0].id);
  expect(beforeRecovery.isActive).toBe(true);

  // No membership exists, so a successful read confirms a revocation.
  const recovered = await deviceSessionService.getState(deviceId);
  expect(recovered.activeAccountId).toBeNull();
  expect(recovered.accounts).toHaveLength(0);
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, created.sessionId));
  expect(row.isActive).toBe(false);
});

it('does not remove a switch target when its membership read fails', async () => {
  const operator = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const deviceId = `dev-${randomUUID()}`;
  const req = { headers: { 'user-agent': 'authority-outage-test' } } as Request;
  const delegated = await sessionService.createSession(account.id, req, {
    deviceId,
    operatedByUserId: operator.id,
  });
  const personal = await sessionService.createSession(operator.id, req, { deviceId });
  await deviceSessionService.addAccount(deviceId, {
    accountId: account.id,
    sessionId: delegated.sessionId,
    operatedByUserId: operator.id,
  });
  await deviceSessionService.addAccount(deviceId, {
    accountId: operator.id,
    sessionId: personal.sessionId,
  });

  const original = accountService.verifyActingAs.bind(accountService);
  let failures = 0;
  const verify = jest
    .spyOn(accountService, 'verifyActingAs')
    .mockImplementation(async (...args) => {
      const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
        failures += 1;
        throw new Error('synthetic membership database outage');
      });
      try {
        return await original(...args);
      } finally {
        select.mockRestore();
      }
    });
  try {
    await expect(deviceSessionService.switchActive(deviceId, account.id)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(failures).toBe(1);
  } finally {
    verify.mockRestore();
  }

  const state = await deviceSessionService.getState(deviceId);
  expect(state.activeAccountId).toBe(operator.id);
  expect(state.accounts.map((entry) => entry.accountId)).toContain(account.id);
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, delegated.sessionId));
  expect(row.isActive).toBe(true);

  const outcome = await deviceSessionService.switchActive(deviceId, account.id);
  expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' });
  if (outcome.ok || outcome.reason !== 'unauthorized') throw new Error('Expected revocation');
  expect(outcome.state.accounts.map((entry) => entry.accountId)).not.toContain(account.id);
  expect(outcome.state.accounts.map((entry) => entry.accountId)).toContain(operator.id);
});

it.each(['organization', 'agent-key'] as const)(
  'preserves the context when the real %s authority query fails',
  async (authority) => {
    const operator = await insertAccountFixture({
      username: `u-${randomUUID().slice(0, 12)}`,
      ...(authority === 'agent-key' ? { kind: 'bot' as const } : {}),
    });
    const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const deviceId = `dev-${randomUUID()}`;
    const created = await sessionService.createSession(
      account.id,
      { headers: { 'user-agent': 'authority-outage-test' } } as Request,
      { deviceId, operatedByUserId: operator.id },
    );
    if (authority === 'agent-key') {
      const [key] = await getDb()
        .insert(userAuthMethods)
        .values({
          userId: operator.id,
          type: 'agent_key',
          methodPublicKey: `test-${randomUUID()}`,
          label: 'test',
          enrollmentMethod: 'governor',
        })
        .returning({ id: userAuthMethods.id });
      await getDb()
        .update(sessions)
        .set({ authMethodId: key.id, authMethodOwnerId: operator.id })
        .where(eq(sessions.sessionId, created.sessionId));
      sessionCache.invalidate(created.sessionId);
    }
    await deviceSessionService.addAccount(deviceId, {
      accountId: account.id,
      sessionId: created.sessionId,
      operatedByUserId: operator.id,
    });

    let failures = 0;
    const failSelect = () => {
      failures += 1;
      throw new Error('synthetic authority database outage');
    };
    const organizationOriginal = organizationAuthority.hasOrganizationOperatingAuthority;
    const agentKeyOriginal = agentKeyAuthority.readLiveAgentKey;
    const spy =
      authority === 'organization'
        ? jest
            .spyOn(organizationAuthority, 'hasOrganizationOperatingAuthority')
            .mockImplementation(async (...args) => {
              const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(failSelect);
              try {
                return await organizationOriginal(...args);
              } finally {
                select.mockRestore();
              }
            })
        : jest.spyOn(agentKeyAuthority, 'readLiveAgentKey').mockImplementation(async (...args) => {
            const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(failSelect);
            try {
              return await agentKeyOriginal(...args);
            } finally {
              select.mockRestore();
            }
          });
    try {
      await expect(deviceSessionService.getState(deviceId)).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      expect(failures).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const [device] = await getDb()
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, deviceId));
    const contexts = await getDb()
      .select()
      .from(deviceAccountContexts)
      .where(eq(deviceAccountContexts.deviceSessionId, device.id));
    const [row] = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, created.sessionId));
    expect(contexts).toHaveLength(1);
    expect(device.activeContextId).toBe(contexts[0].id);
    expect(row.isActive).toBe(true);
  },
);

it('does not remove a context when reading its session row fails', async () => {
  const operator = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const deviceId = `dev-${randomUUID()}`;
  const created = await sessionService.createSession(
    account.id,
    { headers: { 'user-agent': 'authority-outage-test' } } as Request,
    { deviceId, operatedByUserId: operator.id },
  );
  await deviceSessionService.addAccount(deviceId, {
    accountId: account.id,
    sessionId: created.sessionId,
    operatedByUserId: operator.id,
  });
  sessionCache.invalidate(created.sessionId);
  const original = sessionService.getSession.bind(sessionService);
  let failures = 0;
  const getSession = jest
    .spyOn(sessionService, 'getSession')
    .mockImplementation(async (...args) => {
      const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
        failures += 1;
        throw new Error('synthetic session database outage');
      });
      try {
        return await original(...args);
      } finally {
        select.mockRestore();
      }
    });
  try {
    await expect(deviceSessionService.getState(deviceId)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(failures).toBe(1);
  } finally {
    getSession.mockRestore();
  }
  const [device] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId));
  const contexts = await getDb()
    .select()
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, created.sessionId));
  expect(device.activeContextId).toBe(contexts[0].id);
  expect(contexts).toHaveLength(1);
  expect(row.isActive).toBe(true);
});

it('removes only the revoked operator context when another operator reaches the same account', async () => {
  const first = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const second = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const deviceId = `dev-${randomUUID()}`;
  const req = { headers: { 'user-agent': 'authority-outage-test' } } as Request;
  const revoked = await sessionService.createSession(account.id, req, {
    deviceId,
    operatedByUserId: first.id,
  });
  const neighbor = await sessionService.createSession(account.id, req, {
    deviceId,
    operatedByUserId: second.id,
  });
  await deviceSessionService.addAccount(deviceId, {
    accountId: account.id,
    sessionId: revoked.sessionId,
    operatedByUserId: first.id,
  });
  const [device] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId));
  const [principal] = await getDb()
    .insert(devicePrincipals)
    .values({ deviceSessionId: device.id, userId: second.id, authuser: 1 })
    .returning({ id: devicePrincipals.id });
  const [surviving] = await getDb()
    .insert(deviceAccountContexts)
    .values({
      deviceSessionId: device.id,
      principalId: principal.id,
      accountId: account.id,
      sessionId: neighbor.sessionId,
    })
    .returning({ id: deviceAccountContexts.id });

  // Neither operator has a grant: the active one's negative is authoritative.
  await deviceSessionService.getState(deviceId);
  const contexts = await getDb()
    .select()
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
  const [otherSession] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, neighbor.sessionId));
  expect(
    contexts.filter((context) => context.accountId === account.id).map((context) => context.id),
  ).toEqual([surviving.id]);
  expect(otherSession.isActive).toBe(true);
});

it('returns 503 from the real device state route while preserving the delegated context', async () => {
  const operator = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const account = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const deviceId = `dev-${randomUUID()}`;
  const req = { headers: { 'user-agent': 'authority-outage-test' } } as Request;
  const personal = await sessionService.createSession(operator.id, req, { deviceId });
  const delegated = await sessionService.createSession(account.id, req, {
    deviceId,
    operatedByUserId: operator.id,
  });
  await deviceSessionService.addAccount(deviceId, {
    accountId: operator.id,
    sessionId: personal.sessionId,
  });
  await deviceSessionService.addAccount(deviceId, {
    accountId: account.id,
    sessionId: delegated.sessionId,
    operatedByUserId: operator.id,
  });

  const original = accountService.verifyActingAs.bind(accountService);
  let failures = 0;
  const verify = jest
    .spyOn(accountService, 'verifyActingAs')
    .mockImplementation(async (...args) => {
      const select = jest.spyOn(getDb(), 'select').mockImplementationOnce(() => {
        failures += 1;
        throw new Error('synthetic membership database outage');
      });
      try {
        return await original(...args);
      } finally {
        select.mockRestore();
      }
    });
  const app = express();
  app.use('/session/device', sessionDeviceRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/session/device/state`, {
      headers: { authorization: `Bearer ${personal.accessToken}` },
    });
    expect(response.status).toBe(503);
    expect(failures).toBe(1);
  } finally {
    verify.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const [device] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId));
  const contexts = await getDb()
    .select()
    .from(deviceAccountContexts)
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
  expect(contexts).toHaveLength(2);
  expect(contexts.find((context) => context.id === device.activeContextId)?.sessionId).toBe(
    delegated.sessionId,
  );
});
