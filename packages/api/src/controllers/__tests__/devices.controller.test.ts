/**
 * `/devices`, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **A request can only ever see, or sign out, the AUTHENTICATED account's
 * sessions.** `device_id` is deliberately SHARED across accounts — one laptop,
 * several people — so "everything on this device" and "everything of MINE on
 * this device" are two different queries and only one of them is safe. Here two
 * accounts really are signed in on the same `device_id`, and the assertions are
 * about which rows come back and which get deactivated.
 *
 * The second guarantee is expiry: `expires_at > now()` is filtered on the READ.
 * The sweep (`db/expiry.ts`) lags by an interval, so a dropped filter would keep
 * listing a device the user believes is gone — a stale credential rendered as a
 * live one.
 *
 * ## Grouping is now the ORDER BY, not a second pass
 *
 * `last_active_at` is `NOT NULL`, so `order by last_active_at desc` is a total
 * order and the first row per `device_id` is the most recently active one. The
 * Mongo version re-compared each session against the map because that column was
 * optional there. These cases pin the collapsed row's CONTENT, so a port that
 * kept the wrong session of a device fails.
 *
 * The auth middleware, the session service's deactivation, the token decoder and
 * the socket emitter are mocked; the session rows are real.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

/** The account each request authenticates as, and the session its token names. */
let currentUserId = '';
let currentSessionId: string | null = null;

const mockEmitSessionUpdate = jest.fn();
const mockDeactivateSession = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { id: string; _id: string; email?: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { id: currentUserId, _id: currentUserId, email: 'owner@example.test' };
    next();
  },
}));
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => (currentSessionId === null ? null : 'token'),
  decodeToken: () => (currentSessionId === null ? null : { sessionId: currentSessionId }),
}));
jest.mock('../../server', () => ({
  emitSessionUpdate: (...args: unknown[]) => mockEmitSessionUpdate(...args),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import { DevicesController } from '../devices.controller';

interface DeviceEntry {
  id: string;
  deviceId: string;
  name: string;
  deviceName: string;
  type: string;
  deviceType: string;
  lastActive: string;
  createdAt: string;
  isCurrent: boolean;
}

interface JsonResponse {
  status: number;
  body: DeviceEntry[] | Record<string, unknown>;
}

let server: http.Server;

const HOUR_MS = 60 * 60 * 1000;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

interface SessionFixture {
  userId: string;
  deviceId: string;
  deviceName?: string | null;
  deviceType?: string;
  lastActiveAt?: Date;
  createdAt?: Date;
  isActive?: boolean;
  expiresAt?: Date;
}

async function insertSession(fixture: SessionFixture): Promise<string> {
  const sessionId = randomUUID();
  await getDb()
    .insert(sessions)
    .values({
      sessionId,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      deviceName: 'deviceName' in fixture ? fixture.deviceName : 'Nate’s Laptop',
      deviceType: fixture.deviceType ?? 'desktop',
      platform: 'web',
      lastActiveAt: fixture.lastActiveAt ?? new Date(),
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      isActive: fixture.isActive ?? true,
      expiresAt: fixture.expiresAt ?? new Date(Date.now() + HOUR_MS),
      ...(fixture.createdAt === undefined ? {} : { createdAt: fixture.createdAt }),
    });
  return sessionId;
}

async function request(method: string, path: string): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

beforeAll(async () => {
  await connectPostgres();
  jest
    .spyOn(sessionService, 'deactivateSession')
    .mockImplementation(async (...args: Parameters<typeof sessionService.deactivateSession>) => {
      mockDeactivateSession(...args);
      return true;
    });
  jest
    .spyOn(sessionService, 'validateSessionById')
    .mockImplementation(async (sessionId: string) => {
      const [row] = await getDb()
        .select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId));
      if (!row) return null;
      return { session: { deviceId: row.deviceId } } as Awaited<
        ReturnType<typeof sessionService.validateSessionById>
      >;
    });

  const app = express();
  app.use(express.json());
  const { authMiddleware } = jest.requireMock('../../middleware/auth') as {
    authMiddleware: express.RequestHandler;
  };
  app.get('/devices', authMiddleware, DevicesController.getUserDevices);
  app.delete('/devices/:deviceId', authMiddleware, DevicesController.removeDevice);
  app.get('/devices/security', authMiddleware, DevicesController.getSecurityInfo);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  currentSessionId = null;
  currentUserId = await insertUser();
});

// Deliberately NO cleanup. Every assertion is scoped to ids this file just
// minted, so deleting them buys nothing — and it would cost something: the
// throwaway database is shared with the whole run, `platform-stats` counts
// `is_active` sessions globally, and a concurrent DELETE moves that count
// DOWN between the two reads its strict inequality compares. The rows go away
// with the database at the end of the run.

describe('GET /devices', () => {
  it('collapses a device to its most recently active session', async () => {
    const deviceId = randomUUID();
    await insertSession({
      userId: currentUserId,
      deviceId,
      deviceName: 'Stale name',
      deviceType: 'mobile',
      lastActiveAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    await insertSession({
      userId: currentUserId,
      deviceId,
      deviceName: 'Current name',
      deviceType: 'desktop',
      lastActiveAt: new Date(Date.now() - HOUR_MS),
    });

    const res = await request('GET', '/devices');
    const devices = res.body as DeviceEntry[];

    expect(devices).toHaveLength(1);
    // The row kept is the LATER one, field for field.
    expect(devices[0]).toMatchObject({
      id: deviceId,
      deviceId,
      name: 'Current name',
      deviceName: 'Current name',
      type: 'desktop',
      deviceType: 'desktop',
      isCurrent: false,
    });
  });

  it('never lists another account\'s session on a SHARED device id', async () => {
    const deviceId = randomUUID();
    const stranger = await insertUser();
    await insertSession({ userId: stranger, deviceId, deviceName: 'Stranger laptop' });

    const res = await request('GET', '/devices');
    expect(res.body).toEqual([]);
  });

  it('excludes inactive and EXPIRED sessions — the read filters expiry itself', async () => {
    await insertSession({
      userId: currentUserId,
      deviceId: randomUUID(),
      isActive: false,
      deviceName: 'Signed out',
    });
    await insertSession({
      userId: currentUserId,
      deviceId: randomUUID(),
      expiresAt: new Date(Date.now() - HOUR_MS),
      deviceName: 'Expired but not yet swept',
    });
    const live = randomUUID();
    await insertSession({ userId: currentUserId, deviceId: live, deviceName: 'Live' });

    const res = await request('GET', '/devices');
    const devices = res.body as DeviceEntry[];
    expect(devices.map((device) => device.deviceId)).toEqual([live]);
  });

  it('flags the CURRENT device from the requesting token\'s session', async () => {
    const currentDevice = randomUUID();
    const otherDevice = randomUUID();
    currentSessionId = await insertSession({ userId: currentUserId, deviceId: currentDevice });
    await insertSession({ userId: currentUserId, deviceId: otherDevice });

    const res = await request('GET', '/devices');
    const devices = res.body as DeviceEntry[];
    const byDevice = new Map(devices.map((device) => [device.deviceId, device.isCurrent]));
    expect(byDevice.get(currentDevice)).toBe(true);
    expect(byDevice.get(otherDevice)).toBe(false);
  });

  it.each([
    ['NULL', null],
    // `''` is representable — Mongoose stored these as free strings — and has
    // always rendered as the placeholder. This case is what makes the `||` in
    // the controller deliberate rather than a `??` someone will "tidy up".
    ['empty-string', ''],
  ])('renders the placeholder for a %s device name', async (_label, deviceName) => {
    const deviceId = randomUUID();
    await insertSession({ userId: currentUserId, deviceId, deviceName });

    const res = await request('GET', '/devices');
    const devices = res.body as DeviceEntry[];
    expect(devices[0]).toMatchObject({ name: 'Unknown Device', deviceName: 'Unknown Device' });
  });

  it('serializes both timestamps as ISO-8601 strings', async () => {
    const createdAt = new Date('2026-02-03T04:05:06.000Z');
    const lastActiveAt = new Date('2026-02-04T04:05:06.000Z');
    await insertSession({ userId: currentUserId, deviceId: randomUUID(), createdAt, lastActiveAt });

    const res = await request('GET', '/devices');
    const devices = res.body as DeviceEntry[];
    expect(devices[0].createdAt).toBe(createdAt.toISOString());
    expect(devices[0].lastActive).toBe(lastActiveAt.toISOString());
  });

  it('returns an empty list when nothing is signed in', async () => {
    const res = await request('GET', '/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /devices/:deviceId', () => {
  it('deactivates ONLY the caller\'s sessions on that device', async () => {
    const deviceId = randomUUID();
    const stranger = await insertUser();
    const mine = await insertSession({ userId: currentUserId, deviceId });
    const alsoMine = await insertSession({ userId: currentUserId, deviceId });
    await insertSession({ userId: stranger, deviceId });

    const res = await request('DELETE', `/devices/${deviceId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Device removed successfully' });
    const deactivated = mockDeactivateSession.mock.calls.map(([sessionId]) => sessionId).sort();
    expect(deactivated).toEqual([mine, alsoMine].sort());
  });

  it('emits the socket notification for the requesting account only', async () => {
    const deviceId = randomUUID();
    const sessionId = await insertSession({ userId: currentUserId, deviceId });

    await request('DELETE', `/devices/${deviceId}`);

    expect(mockEmitSessionUpdate).toHaveBeenCalledWith(currentUserId, {
      type: 'device_removed',
      deviceId,
      sessionIds: [sessionId],
    });
  });

  it('404s when the device holds no session of the caller\'s, even if someone else is on it', async () => {
    const deviceId = randomUUID();
    const stranger = await insertUser();
    await insertSession({ userId: stranger, deviceId });

    const res = await request('DELETE', `/devices/${deviceId}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Device not found' });
    expect(mockDeactivateSession).not.toHaveBeenCalled();
    expect(mockEmitSessionUpdate).not.toHaveBeenCalled();
  });

  it('refuses to remove the device the request itself is signed in on', async () => {
    const deviceId = randomUUID();
    currentSessionId = await insertSession({ userId: currentUserId, deviceId });

    const res = await request('DELETE', `/devices/${deviceId}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Cannot remove current device' });
    expect(mockDeactivateSession).not.toHaveBeenCalled();
  });

  it('ignores an already-expired session when deciding whether the device exists', async () => {
    const deviceId = randomUUID();
    await insertSession({
      userId: currentUserId,
      deviceId,
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    const res = await request('DELETE', `/devices/${deviceId}`);

    expect(res.status).toBe(404);
    expect(mockDeactivateSession).not.toHaveBeenCalled();
  });
});

describe('GET /devices/security', () => {
  it('returns the recovery email off the authenticated account', async () => {
    const res = await request('GET', '/devices/security');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recoveryEmail: 'owner@example.test' });
  });
});
