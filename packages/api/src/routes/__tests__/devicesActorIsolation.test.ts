/**
 * Device management against real bearer validation and PostgreSQL.
 * Socket identity, rooms and transport are real; the server emitter is a
 * fixture using the production subject-room delivery shape.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq, inArray } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';

jest.unmock('socket.io');
jest.unmock('socket.io-client');
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
let mockIo: SocketServer;
const mockEmitSessionUpdate = jest.fn((userId: string, payload: unknown) =>
  mockIo.to(`user:${userId}`).emit('session_update', payload),
);
jest.mock('../../server', () => ({
  emitSessionUpdate: (...args: [string, unknown]) => mockEmitSessionUpdate(...args),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { Server } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import sessionService from '../../services/session.service';
import { resolveSocketIdentity } from '../../utils/socketAuth';
import { socketRoomsFor } from '../../utils/socket';
import * as serviceEvents from '../../utils/serviceEvents';
import devicesRouter from '../devices';
import { errorHandler } from '../../middleware/errorHandler';

let server: http.Server;
let base: string;
beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  mockIo = new Server(server);
  mockIo.use((socket, next) => {
    void resolveSocketIdentity(socket.handshake).then((identity) => {
      if (identity?.kind !== 'user') return next(new Error('unauthorized'));
      socket.data.user = identity.user;
      next();
    }, next);
  });
  mockIo.on('connection', (socket) => {
    for (const room of socketRoomsFor({ user: socket.data.user })) socket.join(room);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockIo.close(() => resolve()));
  await closePostgres();
});

it('isolates actors while preserving remote-device removal', async () => {
  const org = await insertAccountFixture({
    kind: 'organization',
    username: `o-${randomUUID().slice(0, 12)}`,
  });
  const actors = await Promise.all(
    ['a', 'b', 'c'].map(() => insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` })),
  );
  for (const actor of actors) {
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org.id, memberUserId: actor.id, role: 'admin', status: 'active' });
  }
  const request = { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never;
  const own = await Promise.all(
    actors.map((actor) =>
      sessionService.createSession(org.id, request, {
        deviceId: `fixture-${randomUUID()}`,
        operatedByUserId: actor.id,
      }),
    ),
  );
  const remote = await sessionService.createSession(org.id, request, {
    deviceId: `fixture-${randomUUID()}`,
    operatedByUserId: actors[0].id,
  });
  const shared = await sessionService.createSession(org.id, request, {
    deviceId: remote.deviceId,
    operatedByUserId: actors[1].id,
  });
  const access = await Promise.all(
    own.map((session) => sessionService.getAccessToken(session.sessionId)),
  );
  if (access.some((value) => !value)) throw new Error('expected signed access tokens');
  const [initiator, victim] = own;
  const [initiatorToken, , observerToken] = access;
  if (!initiatorToken || !observerToken) throw new Error('missing token');
  const observerSocket = connectSocket(base, {
    auth: { token: observerToken.accessToken },
    transports: ['websocket'],
  });
  const announcements = jest.spyOn(serviceEvents, 'publishSessionRevocation');
  try {
    await new Promise<void>((resolve, reject) => {
      observerSocket.once('connect', resolve);
      observerSocket.once('connect_error', reject);
    });
    const events: unknown[] = [];
    observerSocket.on('session_update', (event) => events.push(event));
    const headers = { Authorization: `Bearer ${initiatorToken.accessToken}` };
    const listed = await fetch(`${base}/devices`, { headers });
    expect(listed.status).toBe(200);
    const devices = (await listed.json()) as { deviceId: string; isCurrent: boolean }[];
    expect(devices.map((device) => device.deviceId).sort()).toEqual(
      [initiator.deviceId, remote.deviceId].sort(),
    );
    expect(devices.find((device) => device.deviceId === initiator.deviceId)?.isCurrent).toBe(true);
    const forbidden = await fetch(`${base}/devices/${victim.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    expect(forbidden.status).toBe(404);
    const current = await fetch(`${base}/devices/${initiator.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    expect(current.status).toBe(400);
    const response = await fetch(`${base}/devices/${remote.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    expect(response.status).toBe(200);
    const rows = await getDb()
      .select({ id: sessions.sessionId, active: sessions.isActive })
      .from(sessions)
      .where(inArray(sessions.sessionId, [remote.sessionId, shared.sessionId, victim.sessionId]));
    const active = new Map(rows.map((row) => [row.id, row.active]));
    expect(active.get(remote.sessionId)).toBe(false);
    expect(active.get(shared.sessionId)).toBe(true);
    expect(active.get(victim.sessionId)).toBe(true);
    expect(mockEmitSessionUpdate).not.toHaveBeenCalled();
    expect(announcements).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: remote.sessionId, userId: org.id }),
    );
    expect(announcements).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: shared.sessionId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    expect(
      (await sessionService.validateSessionById(initiator.sessionId, false, { useCache: false }))
        ?.session,
    ).toBeDefined();
  } finally {
    announcements.mockRestore();
    observerSocket.close();
  }
});

it('preserves personal remote-device removal and rejects a revoked acting session', async () => {
  const person = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const request = { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never;
  const acting = await sessionService.createSession(person.id, request, {
    deviceId: `fixture-${randomUUID()}`,
  });
  const remote = await sessionService.createSession(person.id, request, {
    deviceId: `fixture-${randomUUID()}`,
  });
  const token = await sessionService.getAccessToken(acting.sessionId);
  if (!token) throw new Error('missing access token');
  const headers = { Authorization: `Bearer ${token.accessToken}` };
  const listed = await fetch(`${base}/devices`, { headers });
  expect(
    ((await listed.json()) as { deviceId: string }[]).map((device) => device.deviceId).sort(),
  ).toEqual([acting.deviceId, remote.deviceId].sort());
  const response = await fetch(`${base}/devices/${remote.deviceId}`, { method: 'DELETE', headers });
  expect(response.status).toBe(200);

  const later = await sessionService.createSession(person.id, request, {
    deviceId: `fixture-${randomUUID()}`,
  });
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = sessionService.deactivateActorSessionsOnDevice.bind(sessionService);
  const spy = jest
    .spyOn(sessionService, 'deactivateActorSessionsOnDevice')
    .mockImplementation(async (...args) => {
      reached();
      await gate;
      return original(...args);
    });
  try {
    const pending = fetch(`${base}/devices/${later.deviceId}`, { method: 'DELETE', headers });
    await entered;
    await sessionService.deactivateSession(acting.sessionId);
    release();
    expect((await pending).status).toBe(403);
    const [row] = await getDb()
      .select({ active: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, later.sessionId));
    expect(row.active).toBe(true);
  } finally {
    release();
    spy.mockRestore();
  }
});

it.each(['GET', 'DELETE'] as const)(
  'refuses %s when the acting application binding changes before the lock',
  async (method) => {
    const person = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const [app] = await getDb()
      .insert(applications)
      .values({
        name: `fixture-${randomUUID()}`,
        type: 'third_party',
        ownerAccountId: person.id,
        redirectUris: ['https://fixture.invalid/'],
      })
      .returning({ id: applications.id });
    const request = { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never;
    const acting = await sessionService.createSession(person.id, request, {
      deviceId: `fixture-${randomUUID()}`,
    });
    const remote = await sessionService.createSession(person.id, request, {
      deviceId: `fixture-${randomUUID()}`,
    });
    const token = await sessionService.getAccessToken(acting.sessionId);
    if (!token) throw new Error('missing access token');
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRead = sessionService.withActingSession.bind(sessionService);
    const originalRemove = sessionService.deactivateActorSessionsOnDevice.bind(sessionService);
    const spy =
      method === 'GET'
        ? jest.spyOn(sessionService, 'withActingSession').mockImplementation(async (...args) => {
            reached();
            await gate;
            return originalRead(...args);
          })
        : jest
            .spyOn(sessionService, 'deactivateActorSessionsOnDevice')
            .mockImplementation(async (...args) => {
              reached();
              await gate;
              return originalRemove(...args);
            });
    try {
      const path = method === 'GET' ? '/devices' : `/devices/${remote.deviceId}`;
      const pending = fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      await entered;
      await getDb()
        .update(sessions)
        .set({ applicationId: app.id })
        .where(eq(sessions.sessionId, acting.sessionId));
      release();
      expect((await pending).status).toBe(403);
      const [row] = await getDb()
        .select({ active: sessions.isActive })
        .from(sessions)
        .where(eq(sessions.sessionId, remote.sessionId));
      expect(row.active).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
  },
);
