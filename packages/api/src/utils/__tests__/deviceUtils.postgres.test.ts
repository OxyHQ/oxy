/**
 * `deviceUtils` database paths against a REAL Postgres.
 *
 * The three functions here are the ones that touch `sessions`:
 * `findExistingDeviceId` (device-id reuse), `getDeviceActiveSessions` (the
 * device account list) and `logoutAllDeviceSessions`. Each mints its own device
 * id and its own `users` rows, so nothing depends on a table being empty — the
 * suite shares one database with the rest of the run.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import {
  findExistingDeviceId,
  getDeviceActiveSessions,
  logoutAllDeviceSessions,
} from '../deviceUtils';

const HOUR_MS = 60 * 60 * 1000;

async function account(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}`, ...overrides })
    .returning({ id: users.id });
  return row.id;
}

/** A `sessions` row with sane defaults; every column the callers read is set. */
async function session(input: {
  userId: string;
  deviceId: string;
  sessionId?: string;
  isActive?: boolean;
  expiresAt?: Date;
  lastActiveAt?: Date;
  deviceFingerprint?: string;
}): Promise<string> {
  const sessionId = input.sessionId ?? `s-${randomUUID()}`;
  await getDb()
    .insert(sessions)
    .values({
      sessionId,
      userId: input.userId,
      deviceId: input.deviceId,
      deviceType: 'desktop',
      platform: 'web',
      // Unique per row: both columns are UNIQUE and NOT NULL.
      accessToken: `at-${randomUUID()}`,
      refreshToken: `rt-${randomUUID()}`,
      isActive: input.isActive ?? true,
      expiresAt: input.expiresAt ?? new Date(Date.now() + HOUR_MS),
      lastActiveAt: input.lastActiveAt ?? new Date(),
      ...(input.deviceFingerprint ? { deviceFingerprint: input.deviceFingerprint } : {}),
    });
  return sessionId;
}

const deviceId = () => `dev-${randomUUID()}`;
const fingerprint = () => `fp-${randomUUID()}`;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('findExistingDeviceId', () => {
  it('returns the device of the most recently active matching session', async () => {
    const fp = fingerprint();
    const user = await account();
    const older = deviceId();
    const newer = deviceId();
    await session({
      userId: user,
      deviceId: older,
      deviceFingerprint: fp,
      lastActiveAt: new Date(Date.now() - HOUR_MS),
    });
    await session({
      userId: user,
      deviceId: newer,
      deviceFingerprint: fp,
      lastActiveAt: new Date(),
    });

    expect(await findExistingDeviceId(fp, user)).toBe(newer);
  });

  it('scopes to the user when one is supplied — never another account\'s device', async () => {
    const fp = fingerprint();
    const mine = await account();
    const theirs = await account();
    const myDevice = deviceId();
    const theirDevice = deviceId();
    // Their session is MORE recent, so an unscoped query would return it.
    await session({ userId: mine, deviceId: myDevice, deviceFingerprint: fp, lastActiveAt: new Date(Date.now() - HOUR_MS) });
    await session({ userId: theirs, deviceId: theirDevice, deviceFingerprint: fp, lastActiveAt: new Date() });

    expect(await findExistingDeviceId(fp, mine)).toBe(myDevice);
  });

  it('ignores inactive and expired sessions — the read filters expiry itself', async () => {
    const inactiveFp = fingerprint();
    const expiredFp = fingerprint();
    const user = await account();
    await session({ userId: user, deviceId: deviceId(), deviceFingerprint: inactiveFp, isActive: false });
    await session({
      userId: user,
      deviceId: deviceId(),
      deviceFingerprint: expiredFp,
      expiresAt: new Date(Date.now() - 1000),
    });

    // Correctness must not depend on the expiry sweep having run.
    expect(await findExistingDeviceId(inactiveFp, user)).toBeNull();
    expect(await findExistingDeviceId(expiredFp, user)).toBeNull();
  });

  it('returns null for an unknown fingerprint and for an empty one', async () => {
    expect(await findExistingDeviceId(fingerprint())).toBeNull();
    expect(await findExistingDeviceId('')).toBeNull();
  });
});

describe('getDeviceActiveSessions', () => {
  it('returns one entry per user with a composed name.displayName', async () => {
    const device = deviceId();
    const user = await account({ nameFirst: 'Nate', nameLast: 'Isern' });
    const sid = await session({ userId: user, deviceId: device });

    const entries = await getDeviceActiveSessions(device);

    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(sid);
    expect(entries[0].user?.id).toBe(user);
    // The canonical contract: composed server-side, never rebuilt by a client.
    expect(entries[0].user?.name?.displayName).toBe('Nate Isern');
  });

  it('deduplicates by user, keeping the most recently active session', async () => {
    const device = deviceId();
    const user = await account();
    await session({
      userId: user,
      deviceId: device,
      sessionId: 's-old',
      lastActiveAt: new Date(Date.now() - HOUR_MS),
    });
    await session({ userId: user, deviceId: device, sessionId: 's-new', lastActiveAt: new Date() });

    const entries = await getDeviceActiveSessions(device);

    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('s-new');
  });

  it('marks the current session and only that one', async () => {
    const device = deviceId();
    const a = await account();
    const b = await account();
    const sidA = await session({ userId: a, deviceId: device });
    await session({ userId: b, deviceId: device });

    const entries = await getDeviceActiveSessions(device, sidA);

    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.isCurrent).map((e) => e.sessionId)).toEqual([sidA]);
  });

  it('excludes inactive and expired sessions', async () => {
    const device = deviceId();
    const live = await account();
    const dead = await account();
    const expired = await account();
    await session({ userId: live, deviceId: device });
    await session({ userId: dead, deviceId: device, isActive: false });
    await session({ userId: expired, deviceId: device, expiresAt: new Date(Date.now() - 1000) });

    const entries = await getDeviceActiveSessions(device);

    expect(entries.map((e) => e.user?.id)).toEqual([live]);
  });

  it('NEVER returns a session bearer token on the device DTO', async () => {
    /*
     * `sessions.access_token` / `refresh_token` / `previous_refresh_token` are in
     * `protectedColumns.ts`. This DTO is handed to a client, so the whole
     * serialized entry is searched for the stored token values — a leak through
     * any nested field, not just a top-level one, fails here.
     */
    const device = deviceId();
    const user = await account();
    const sid = await session({ userId: user, deviceId: device });
    const [stored] = await getDb()
      .select({ accessToken: sessions.accessToken, refreshToken: sessions.refreshToken })
      .from(sessions)
      .where(eq(sessions.sessionId, sid))
      .limit(1);

    const serialized = JSON.stringify(await getDeviceActiveSessions(device));

    expect(serialized).not.toContain(stored.accessToken);
    expect(serialized).not.toContain(stored.refreshToken);
  });

  it('returns an empty list for a device with nothing on it', async () => {
    expect(await getDeviceActiveSessions(deviceId())).toEqual([]);
  });
});

describe('logoutAllDeviceSessions', () => {
  it('deactivates every active session on the device and reports the count', async () => {
    const device = deviceId();
    const user = await account();
    await session({ userId: user, deviceId: device, sessionId: 's1' });
    await session({ userId: await account(), deviceId: device, sessionId: 's2' });

    expect(await logoutAllDeviceSessions(device)).toBe(2);

    const rows = await getDb()
      .select({ sessionId: sessions.sessionId, isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.deviceId, device));
    expect(rows.every((r) => r.isActive === false)).toBe(true);
  });

  it('honours excludeSessionId — the caller stays signed in', async () => {
    const device = deviceId();
    const user = await account();
    const keep = await session({ userId: user, deviceId: device });
    const drop = await session({ userId: await account(), deviceId: device });

    expect(await logoutAllDeviceSessions(device, keep)).toBe(1);

    const rows = await getDb()
      .select({ sessionId: sessions.sessionId, isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.deviceId, device));
    expect(rows.find((r) => r.sessionId === keep)?.isActive).toBe(true);
    expect(rows.find((r) => r.sessionId === drop)?.isActive).toBe(false);
  });

  it('never touches another device, and counts only rows it actually changed', async () => {
    const device = deviceId();
    const other = deviceId();
    const user = await account();
    await session({ userId: user, deviceId: device });
    // Already inactive — not a row this call deactivates, so not counted.
    await session({ userId: user, deviceId: device, isActive: false });
    const untouched = await session({ userId: user, deviceId: other });

    expect(await logoutAllDeviceSessions(device)).toBe(1);

    const [row] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, untouched))
      .limit(1);
    expect(row.isActive).toBe(true);
  });

  it('returns 0 for a device with no active sessions', async () => {
    expect(await logoutAllDeviceSessions(deviceId())).toBe(0);
  });
});
