/**
 * `NotificationService` — the factory layer, against a REAL Postgres.
 *
 * There was no suite for this file at all, which mattered because two of its
 * three guarantees are the kind that a mocked model cannot show:
 *
 *  - **Nobody is notified about their own action.** Under Mongo the test was
 *    `recipientId.toString() === actorId.toString()`, which compared an
 *    `ObjectId` to a string correctly only because of the `toString`. Ids are
 *    `text` now, so it is a plain comparison — and the case below proves it by
 *    checking the TABLE is still empty, not that a branch was taken.
 *  - **The duplicate guard is the unique index, not a preceding read.** Mongo
 *    did `findOne` then `save`, so two concurrent emissions could both find
 *    nothing and one would throw `E11000` out of a method whose contract is to
 *    return null. Here it is one `insert … on conflict do nothing`, so the
 *    concurrent case is exercisable: the two calls below run without awaiting in
 *    between and exactly one row exists afterwards, with neither call throwing.
 *
 * Nothing is mocked but the logger.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { notifications } from '../../db/schema/notifications';
import { users } from '../../db/schema/users';
import { NotificationService } from '../notification.service';

let RECIPIENT_ID: string;
let ACTOR_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function storedFor(recipientId: string) {
  return getDb()
    .select({
      id: notifications.id,
      actorId: notifications.actorId,
      type: notifications.type,
      entityId: notifications.entityId,
      entityType: notifications.entityType,
      read: notifications.read,
    })
    .from(notifications)
    .where(eq(notifications.recipientId, recipientId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  RECIPIENT_ID = await insertUser();
  ACTOR_ID = await insertUser();
});

describe('createNotification', () => {
  it('stores the row and hands it back', async () => {
    const created = await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    expect(created).toMatchObject({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
      read: false,
    });
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
  });

  it('refuses to notify somebody about their own action, writing nothing', async () => {
    const created = await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: RECIPIENT_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    expect(created).toBeNull();
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });

  it('returns null for a duplicate and leaves ONE row', async () => {
    const input = {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };
    await NotificationService.createNotification(input);

    expect(await NotificationService.createNotification(input)).toBeNull();
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
  });

  it('survives two CONCURRENT emissions: one row, no throw', async () => {
    // The race Mongo's read-then-write could not close. Both calls are started
    // before either resolves, so at least one takes the `do nothing` branch.
    const input = {
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    const [a, b] = await Promise.all([
      NotificationService.createNotification(input),
      NotificationService.createNotification(input),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
  });

  it('treats a different entity as a different notification', async () => {
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-2',
      entityType: 'post',
    });

    expect(await storedFor(RECIPIENT_ID)).toHaveLength(2);
  });

  it('rejects an actor that names no account', async () => {
    // `actor_id` is a real foreign key; Mongo happily stored a dangling id.
    await expect(
      NotificationService.createNotification({
        recipientId: RECIPIENT_ID,
        actorId: randomUUID(),
        type: 'like',
        entityId: 'post-1',
        entityType: 'post',
      }),
    ).rejects.toThrow();
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });
});

describe('the typed factories', () => {
  it('createLikeNotification targets the post', async () => {
    await NotificationService.createLikeNotification(RECIPIENT_ID, ACTOR_ID, 'post-1');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ type: 'like', entityId: 'post-1', entityType: 'post' }),
    ]);
  });

  it('createFollowNotification points at the recipient\'s own profile', async () => {
    await NotificationService.createFollowNotification(RECIPIENT_ID, ACTOR_ID);

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({
        type: 'follow',
        entityId: RECIPIENT_ID,
        entityType: 'profile',
      }),
    ]);
  });

  it('createReplyNotification targets the reply', async () => {
    await NotificationService.createReplyNotification(RECIPIENT_ID, ACTOR_ID, 'reply-1');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ type: 'reply', entityId: 'reply-1', entityType: 'reply' }),
    ]);
  });

  it('createMentionNotification targets the post', async () => {
    await NotificationService.createMentionNotification(RECIPIENT_ID, ACTOR_ID, 'post-1');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ type: 'mention', entityId: 'post-1', entityType: 'post' }),
    ]);
  });

  it('createRepostNotification targets the post', async () => {
    await NotificationService.createRepostNotification(RECIPIENT_ID, ACTOR_ID, 'post-1');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ type: 'repost', entityId: 'post-1', entityType: 'post' }),
    ]);
  });

  it('createQuoteNotification targets the post', async () => {
    await NotificationService.createQuoteNotification(RECIPIENT_ID, ACTOR_ID, 'post-1');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ type: 'quote', entityId: 'post-1', entityType: 'post' }),
    ]);
  });

  it('createWelcomeNotification attributes the welcome to a REAL system account', async () => {
    // The Mongo version hardcoded the all-zero ObjectId as its system actor.
    // `actor_id` is a foreign key now, so that sentinel names no row and the
    // insert would be refused — the account is a parameter instead.
    const systemAccount = await insertUser();

    await NotificationService.createWelcomeNotification(RECIPIENT_ID, systemAccount);

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({
        actorId: systemAccount,
        type: 'welcome',
        entityId: RECIPIENT_ID,
        entityType: 'profile',
      }),
    ]);
  });

  it('refuses the all-zero ObjectId sentinel the Mongo version used', async () => {
    // Stated as a case rather than a comment: the sentinel is not merely unused,
    // it is now unusable, and anybody reinstating it gets a red test rather than
    // a 500 in production.
    await expect(
      NotificationService.createWelcomeNotification(RECIPIENT_ID, '000000000000000000000000'),
    ).rejects.toThrow();
    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });
});

describe('deleteNotificationsByEntity', () => {
  it('removes every notification about the entity, across recipients', async () => {
    const otherRecipient = await insertUser();
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-doomed',
      entityType: 'post',
    });
    await NotificationService.createNotification({
      recipientId: otherRecipient,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-doomed',
      entityType: 'post',
    });
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-kept',
      entityType: 'post',
    });

    await NotificationService.deleteNotificationsByEntity('post-doomed');

    expect(await storedFor(RECIPIENT_ID)).toEqual([
      expect.objectContaining({ entityId: 'post-kept' }),
    ]);
    expect(await storedFor(otherRecipient)).toHaveLength(0);
  });

  it('is a no-op for an entity nothing references', async () => {
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    await NotificationService.deleteNotificationsByEntity('post-never');

    expect(await storedFor(RECIPIENT_ID)).toHaveLength(1);
  });
});

describe('a deleted participant takes the notification with it', () => {
  it('cascades on the recipient', async () => {
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    await getDb().delete(users).where(eq(users.id, RECIPIENT_ID));

    expect(await storedFor(RECIPIENT_ID)).toHaveLength(0);
  });

  it('cascades on the actor', async () => {
    // A notification attributed to a deleted account says nothing, and Mongo
    // needed a cleanup job to say so.
    await NotificationService.createNotification({
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    await getDb().delete(users).where(eq(users.id, ACTOR_ID));

    const rows = await getDb()
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.recipientId, RECIPIENT_ID), eq(notifications.actorId, ACTOR_ID)));
    expect(rows).toHaveLength(0);
  });
});
