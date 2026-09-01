/**
 * Notification creation helpers — one factory per activity type on top of a
 * single guarded insert.
 *
 * Two rules survive the port unchanged, and one mechanism replaces two:
 *
 *  - **Nobody is notified about their own action.** `recipientId === actorId`
 *    returns null before anything is written.
 *  - **The same actor doing the same thing to the same entity notifies once.**
 *    Under Mongo that was a `findOne` followed by a `save`, with the unique
 *    index `{recipientId, actorId, type, entityId}` as an unreachable backstop —
 *    two concurrent emissions could both see "no duplicate" and one would then
 *    throw a `E11000` out of a method whose contract is to return null. Here it
 *    is ONE statement: `insert … on conflict (recipient_id, actor_id, type,
 *    entity_id) do nothing`, which returns no row when the notification already
 *    exists. The check and the write can no longer disagree.
 *
 * ## `entity_id` deliberately carries no foreign key
 *
 * `entityType` discriminates it, and two of the three values (`post`, `reply`)
 * name rows in MENTION's database rather than this one — see the header of
 * `db/schema/notifications.ts`. So an entity id is validated by nothing, exactly
 * as before.
 *
 * ## `createWelcomeNotification` needs a real system account
 *
 * `actor_id` DOES carry a foreign key (`users`, `ON DELETE CASCADE`), and the
 * Mongo code used a hardcoded all-zero ObjectId as its "system" actor. That id
 * names no row, so the insert is now REJECTED rather than silently creating a
 * notification attributed to an account that does not exist. The sentinel is
 * therefore gone and the system actor is a PARAMETER: the caller supplies the
 * account the welcome is attributed to, and the foreign key checks it. Nothing
 * in this package calls it today.
 */

import { eq } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { notifications } from '../db/schema/notifications';
import { logger } from '../utils/logger';

/** One stored `notifications` row, exactly as written. */
export type NotificationRecord = typeof notifications.$inferSelect;

/**
 * What every factory below funnels into
 * {@link NotificationService.createNotification}.
 *
 * `type` and `entityType` are DERIVED from the columns rather than restated, so
 * adding a value to either closed set cannot leave this interface behind.
 */
export interface NotificationData {
  recipientId: string;
  actorId: string;
  type: (typeof notifications.$inferInsert)['type'];
  entityId: string;
  entityType: (typeof notifications.$inferInsert)['entityType'];
}

/**
 * Service to handle notification operations
 */
export class NotificationService {

  /**
   * Create a new notification.
   *
   * @returns The created notification, or null when it would duplicate an
   *   existing one or would notify the actor about their own action.
   */
  static async createNotification(data: NotificationData): Promise<NotificationRecord | null> {
    try {
      // Don't notify yourself
      if (data.recipientId === data.actorId) {
        return null;
      }

      // The duplicate guard and the write are the SAME statement: the unique
      // index `notifications_recipient_id_actor_id_type_entity_id_key` decides,
      // so a concurrent emission cannot slip between a check and an insert.
      const [notification] = await getDb()
        .insert(notifications)
        .values({
          recipientId: data.recipientId,
          actorId: data.actorId,
          type: data.type,
          entityId: data.entityId,
          entityType: data.entityType,
        })
        .onConflictDoNothing({
          target: [
            notifications.recipientId,
            notifications.actorId,
            notifications.type,
            notifications.entityId,
          ],
        })
        .returning();

      return notification ?? null;
    } catch (error) {
      logger.error('Error creating notification', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Create a like notification
   */
  static async createLikeNotification(
    recipientId: string,
    actorId: string,
    postId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'like',
      entityId: postId,
      entityType: 'post'
    });
  }

  /**
   * Create a follow notification
   */
  static async createFollowNotification(
    recipientId: string,
    actorId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'follow',
      entityId: recipientId,
      entityType: 'profile'
    });
  }

  /**
   * Create a reply notification
   */
  static async createReplyNotification(
    recipientId: string,
    actorId: string,
    replyId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'reply',
      entityId: replyId,
      entityType: 'reply'
    });
  }

  /**
   * Create a mention notification
   */
  static async createMentionNotification(
    recipientId: string,
    actorId: string,
    postId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'mention',
      entityId: postId,
      entityType: 'post'
    });
  }

  /**
   * Create a repost notification
   */
  static async createRepostNotification(
    recipientId: string,
    actorId: string,
    postId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'repost',
      entityId: postId,
      entityType: 'post'
    });
  }

  /**
   * Create a quote post notification
   */
  static async createQuoteNotification(
    recipientId: string,
    actorId: string,
    postId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId,
      type: 'quote',
      entityId: postId,
      entityType: 'post'
    });
  }

  /**
   * Create a welcome notification for new users.
   *
   * `systemActorId` must name a real account: `notifications.actor_id` is a
   * foreign key, so the all-zero ObjectId the Mongo version used would now be
   * rejected. See the module header.
   */
  static async createWelcomeNotification(
    recipientId: string,
    systemActorId: string
  ) {
    return this.createNotification({
      recipientId,
      actorId: systemActorId,
      type: 'welcome',
      entityId: recipientId,
      entityType: 'profile'
    });
  }

  /**
   * Delete notifications related to a specific entity (e.g., when a post is deleted)
   */
  static async deleteNotificationsByEntity(entityId: string) {
    try {
      await getDb().delete(notifications).where(eq(notifications.entityId, entityId));
    } catch (error) {
      logger.error('Error deleting notifications for entity', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
