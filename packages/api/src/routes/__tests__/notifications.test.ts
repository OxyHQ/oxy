/**
 * `/notifications` — the in-app activity feed, end to end against a REAL
 * Postgres.
 *
 * There was no coverage of these endpoints at all before the port, which is how
 * the bug in the second block below survived: the handlers read
 * `req.params.notificationId` while the routes that reach them are `/:id/read`
 * and `/:id`, so the id was ALWAYS `undefined`, Mongoose dropped the undefined
 * key from the filter, and both endpoints acted on an ARBITRARY notification of
 * the caller's. Postgres cannot express "ignore this predicate", so the port had
 * to choose; it reads `req.params.id` — the parameter `notificationIdParams`
 * validates — and these cases hold it there by seeding TWO notifications and
 * naming one.
 *
 * The rest of the file is the WIRE FORMAT, which every ecosystem app consumes
 * and none will be rebuilt for. Full bodies are asserted, not status codes:
 *
 *  - `_id` (not `id`) is the row key, and the populated actor keeps the exact
 *    `{_id, username, name, avatar}` projection `populate` selected.
 *  - An absent optional is OMITTED, never emitted as `null`.
 *  - `__v` does not travel: it was Mongoose's version counter, it has no
 *    Postgres counterpart and no consumer reads it.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';

/** Identity the mocked bearer middleware resolves. */
const mockBearerUser = { current: '' };
/** Scopes the mocked service-token middleware grants `POST /notifications`. */
const mockServiceScopes: { current: string[] } = { current: ['notifications:write'] };

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: mockBearerUser.current };
    next();
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = { scopes: mockServiceScopes.current };
    next();
  },
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { notifications } from '../../db/schema/notifications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import notificationsRouter from '../notifications.routes';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers: Record<string, string | number> = {};
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server: http.Server;
let RECIPIENT_ID: string;
let ACTOR_ID: string;
let OTHER_USER_ID: string;

/** Every room/event pair the route emitted, in order. */
const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
const fakeIo = {
  to(room: string) {
    return {
      emit(event: string, payload: unknown) {
        emitted.push({ room, event, payload });
      },
    };
  },
};

async function insertUser(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function insertNotification(
  fields: Partial<typeof notifications.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(notifications)
    .values({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: randomUUID(),
      entityType: 'post',
      ...fields,
    })
    .returning({ id: notifications.id });
  return row.id;
}

/** Every stored notification of `userId`, oldest first — the write's evidence. */
async function storedFor(userId: string) {
  return getDb()
    .select({
      id: notifications.id,
      entityId: notifications.entityId,
      read: notifications.read,
    })
    .from(notifications)
    .where(eq(notifications.recipientId, userId))
    .orderBy(asc(notifications.createdAt), asc(notifications.entityId));
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.set('io', fakeIo);
  app.use('/notifications', notificationsRouter);
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
  emitted.length = 0;
  mockServiceScopes.current = ['notifications:write'];
  RECIPIENT_ID = await insertUser();
  ACTOR_ID = await insertUser({
    username: `ada${randomUUID().slice(0, 8)}`,
    nameFirst: 'Ada',
    nameLast: 'Lovelace',
    avatar: 'file-avatar-1',
  });
  OTHER_USER_ID = await insertUser();
  mockBearerUser.current = RECIPIENT_ID;
});

describe('GET /notifications — wire format', () => {
  it('emits the full documented body, actor included', async () => {
    const id = await insertNotification({ entityId: 'post-1' });

    const res = await request('GET', '/notifications');

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    const list = data.notifications as Array<Record<string, unknown>>;

    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      _id: id,
      recipientId: RECIPIENT_ID,
      actorId: {
        _id: ACTOR_ID,
        username: expect.stringMatching(/^ada/),
        name: { first: 'Ada', last: 'Lovelace' },
        avatar: 'file-avatar-1',
      },
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
      read: false,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(data.unreadCount).toBe(1);
    expect(data.hasMore).toBe(false);
    expect(data.page).toBe(1);
    expect(data.limit).toBe(20);

    // `__v` was Mongoose's version counter and does not travel.
    expect(Object.keys(list[0])).not.toContain('__v');
  });

  it('OMITS an actor field that is unset rather than emitting null', async () => {
    // Mongo left an unset optional out of the document entirely, and the SDK's
    // zod parses reject a null where a string is optional. Drizzle hands back
    // `null`, so the serializer has to reconcile the two.
    const bare = await insertUser();
    await insertNotification({ actorId: bare });

    const res = await request('GET', '/notifications');

    const list = (res.body.data as { notifications: Array<Record<string, unknown>> }).notifications;
    expect(list[0].actorId).toEqual({ _id: bare });
    expect(Object.keys(list[0].actorId as object)).toEqual(['_id']);
  });

  it('returns the recipient\'s notifications newest first, and nobody else\'s', async () => {
    const older = await insertNotification({
      entityId: 'post-old',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await insertNotification({
      entityId: 'post-new',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'post-theirs' });

    const res = await request('GET', '/notifications');

    const list = (res.body.data as { notifications: Array<{ _id: string }> }).notifications;
    expect(list.map((n) => n._id)).toEqual([newer, older]);
  });

  it('pages with skip/limit and reports hasMore', async () => {
    await insertNotification({ entityId: 'a', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    await insertNotification({ entityId: 'b', createdAt: new Date('2026-02-01T00:00:00.000Z') });
    await insertNotification({ entityId: 'c', createdAt: new Date('2026-03-01T00:00:00.000Z') });

    const first = await request('GET', '/notifications?page=1&limit=2');
    const second = await request('GET', '/notifications?page=2&limit=2');

    const firstData = first.body.data as {
      notifications: Array<{ entityId: string }>;
      hasMore: boolean;
    };
    const secondData = second.body.data as {
      notifications: Array<{ entityId: string }>;
      hasMore: boolean;
    };
    expect(firstData.notifications.map((n) => n.entityId)).toEqual(['c', 'b']);
    expect(firstData.hasMore).toBe(true);
    expect(secondData.notifications.map((n) => n.entityId)).toEqual(['a']);
    expect(secondData.hasMore).toBe(false);
  });

  it('counts only the UNREAD ones, and only the caller\'s', async () => {
    await insertNotification({ entityId: 'unread-1' });
    await insertNotification({ entityId: 'read-1', read: true });
    await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'theirs' });

    const res = await request('GET', '/notifications');

    expect((res.body.data as { unreadCount: number }).unreadCount).toBe(1);
  });

  it('400s a limit above the page-size ceiling', async () => {
    const res = await request('GET', '/notifications?limit=1000');

    expect(res.status).toBe(400);
  });
});

describe('GET /notifications/unread-count', () => {
  it('answers with the caller\'s unread total', async () => {
    await insertNotification({ entityId: 'a' });
    await insertNotification({ entityId: 'b' });
    await insertNotification({ entityId: 'c', read: true });
    await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'theirs' });

    const res = await request('GET', '/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { unreadCount: 2 } });
  });

  it('answers 0 for an account with none', async () => {
    const res = await request('GET', '/notifications/unread-count');

    expect(res.body).toEqual({ data: { unreadCount: 0 } });
  });
});

describe('PUT /notifications/:id/read — the NAMED notification, and only it', () => {
  it('marks the notification the URL names', async () => {
    // The regression this file exists for: the handler used to read
    // `req.params.notificationId`, which no route supplies, so Mongoose dropped
    // the undefined key and an ARBITRARY row of the caller's was marked read.
    const target = await insertNotification({
      entityId: 'target',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await insertNotification({
      entityId: 'bystander',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request('PUT', `/notifications/${target}/read`);

    expect(res.status).toBe(200);
    const rows = await storedFor(RECIPIENT_ID);
    expect(rows.find((row) => row.id === target)?.read).toBe(true);
    expect(rows.find((row) => row.entityId === 'bystander')?.read).toBe(false);
  });

  it('returns the updated notification in the documented shape', async () => {
    const id = await insertNotification({ entityId: 'post-1' });

    const res = await request('PUT', `/notifications/${id}/read`);

    expect(res.body).toEqual({
      data: {
        notification: {
          _id: id,
          recipientId: RECIPIENT_ID,
          // Not populated on this path — `findOneAndUpdate` never populated
          // either, so the raw actor id is what the wire has always carried.
          actorId: ACTOR_ID,
          type: 'like',
          entityId: 'post-1',
          entityType: 'post',
          read: true,
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      },
    });
  });

  it("404s another account's notification, leaving it unread", async () => {
    const theirs = await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'theirs' });

    const res = await request('PUT', `/notifications/${theirs}/read`);

    expect(res.status).toBe(404);
    expect((await storedFor(OTHER_USER_ID))[0].read).toBe(false);
  });

  it('404s an id that matches no row, without throwing', async () => {
    const res = await request('PUT', `/notifications/${randomUUID()}/read`);

    expect(res.status).toBe(404);
  });

  it('404s a MALFORMED id rather than 500ing — no id-shape guard is left', async () => {
    const res = await request('PUT', '/notifications/not-an-object-id/read');

    expect(res.status).toBe(404);
  });
});

describe('PUT /notifications/read-all', () => {
  it('marks every unread notification of the caller and reports the count', async () => {
    await insertNotification({ entityId: 'a' });
    await insertNotification({ entityId: 'b' });
    await insertNotification({ entityId: 'c', read: true });
    await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'theirs' });

    const res = await request('PUT', '/notifications/read-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { message: 'Marked 2 notifications as read', modifiedCount: 2 },
    });
    expect((await storedFor(RECIPIENT_ID)).every((row) => row.read)).toBe(true);
    // Another account's notification is untouched.
    expect((await storedFor(OTHER_USER_ID))[0].read).toBe(false);
  });

  it('reports 0 when there is nothing unread', async () => {
    const res = await request('PUT', '/notifications/read-all');

    expect(res.body).toEqual({
      data: { message: 'Marked 0 notifications as read', modifiedCount: 0 },
    });
  });
});

describe('DELETE /notifications/:id — the NAMED notification, and only it', () => {
  it('deletes the notification the URL names', async () => {
    const target = await insertNotification({
      entityId: 'target',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await insertNotification({
      entityId: 'bystander',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request('DELETE', `/notifications/${target}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { message: 'Notification deleted successfully' } });
    expect((await storedFor(RECIPIENT_ID)).map((row) => row.entityId)).toEqual(['bystander']);
  });

  it("404s another account's notification, leaving it stored", async () => {
    const theirs = await insertNotification({ recipientId: OTHER_USER_ID, entityId: 'theirs' });

    const res = await request('DELETE', `/notifications/${theirs}`);

    expect(res.status).toBe(404);
    expect(await storedFor(OTHER_USER_ID)).toHaveLength(1);
  });

  it('404s an id that matches no row', async () => {
    const res = await request('DELETE', `/notifications/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /notifications — privileged service scope only', () => {
  it('creates the notification and answers 201 with the documented body', async () => {
    const res = await request('POST', '/notifications', {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: RECIPIENT_ID,
      entityType: 'profile',
    });

    expect(res.status).toBe(201);
    const notification = (res.body.data as { notification: Record<string, unknown> }).notification;
    expect(notification).toEqual({
      _id: expect.any(String),
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: RECIPIENT_ID,
      entityType: 'profile',
      read: false,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
  });

  it('emits the realtime notification to the RECIPIENT\'s room only', async () => {
    await request('POST', '/notifications', {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: RECIPIENT_ID,
      entityType: 'profile',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`user:${RECIPIENT_ID}`);
    expect(emitted[0].event).toBe('notification');
    // `title` / `message` / `data` were never columns on this model — Mongoose
    // `strict: true` stripped them on save, so they have never reached the
    // socket and are not added by the port.
    expect(emitted[0].payload).toEqual({
      id: expect.any(String),
      type: 'follow',
      actorId: ACTOR_ID,
      entityId: RECIPIENT_ID,
      entityType: 'profile',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('accepts and DISCARDS title/message/data, exactly as the model always did', async () => {
    const res = await request('POST', '/notifications', {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: RECIPIENT_ID,
      entityType: 'profile',
      title: 'Hello',
      message: 'Somebody followed you',
      data: { extra: true },
    });

    expect(res.status).toBe(201);
    const notification = (res.body.data as { notification: Record<string, unknown> }).notification;
    expect(Object.keys(notification).sort()).toEqual([
      '_id', 'actorId', 'createdAt', 'entityId', 'entityType', 'read', 'recipientId', 'type',
      'updatedAt',
    ]);
  });

  it('409s a duplicate — same actor, same action, same entity', async () => {
    const payload = {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    };
    await request('POST', '/notifications', payload);

    const res = await request('POST', '/notifications', payload);

    expect(res.status).toBe(409);
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
    // No socket noise for a duplicate.
    expect(emitted).toHaveLength(1);
  });

  it('403s a caller without the notifications:write scope, storing nothing', async () => {
    mockServiceScopes.current = ['user:read'];

    const res = await request('POST', '/notifications', {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: RECIPIENT_ID,
      entityType: 'profile',
    });

    expect(res.status).toBe(403);
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });

  it('400s an out-of-vocabulary type', async () => {
    const res = await request('POST', '/notifications', {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'thermonuclear',
      entityId: 'post-1',
      entityType: 'post',
    });

    expect(res.status).toBe(400);
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });

  it('400s a recipient that names no account, rather than 500ing', async () => {
    // `recipient_id` and `actor_id` are real foreign keys now; Mongo let a
    // notification name an account that does not exist.
    const res = await request('POST', '/notifications', {
      recipientId: randomUUID(),
      actorId: ACTOR_ID,
      type: 'follow',
      entityId: 'x',
      entityType: 'profile',
    });

    expect(res.status).toBe(400);
  });
});
