/**
 * In-app notification endpoints.
 *
 * ## The wire shape is a serializer now, and it is deliberate
 *
 * Every handler used to hand a Mongoose document (or a `.lean()` result)
 * straight to `res.json()`, so the response shape was whatever the driver
 * happened to produce. It is written out here instead, following the same split
 * `utils/billingResponse.ts` settled on for the Stripe tables:
 *
 *   - **`_id` IS contract.** It is the row key every consumer addresses a
 *     notification by (`PUT /notifications/:id/read`), so it is emitted from the
 *     drizzle `id`.
 *   - **`__v` is NOT contract.** Mongoose's version counter has no Postgres
 *     counterpart and no consumer reads it. It does not travel.
 *   - **The populated actor keeps its shape**: `{_id, username, name, avatar}`,
 *     the exact projection `populate('actorId', 'username name avatar _id')`
 *     selected. Absent optionals are OMITTED rather than emitted as `null`,
 *     because that is what Mongo did and what the SDK's zod parses expect.
 *
 * ## `title` / `message` / `url` are stored for `system` only
 *
 * A `system` notification (an Oxy service telling a user about their own
 * account) has no actor action for a client to render from, so its `title`
 * and `message` are required and stored, with an optional validated deep link
 * `url`; they appear in the 201 body, the list and the socket payload. For
 * every other type `title` / `message` / `data` are accepted and DISCARDED as
 * they always were (the Mongoose model declared none of them), and the table's
 * CHECKs keep those columns null.
 *
 * ## Two behaviours the port could not preserve, both flagged
 *
 *   1. `markAsRead` and `deleteNotification` read `req.params.notificationId`,
 *      but the routes that reach them are `/:id/read` and `/:id` — so the value
 *      was ALWAYS `undefined`, Mongoose dropped the undefined key from the
 *      filter, and both endpoints operated on an ARBITRARY notification of the
 *      caller. Postgres cannot express "ignore this predicate", and reproducing
 *      the bug would mean deliberately targeting the wrong row, so both now read
 *      `req.params.id` — the parameter `notificationIdParams` validates.
 *   2. An out-of-enum `type` / `entityType` used to reach Mongoose and fail
 *      validation, surfacing as a 500 from the generic catch. The values are a
 *      CHECK-constrained closed set here, so the schema below names them and the
 *      request is rejected as a 400 through the SAME
 *      `BadRequestError('Invalid notification data', { errors })` envelope every
 *      other malformed field already used.
 */

import type { Response, Request } from 'express';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../config/postgres';
import type { AuthRequest, ServiceAuthRequest } from '../middleware/auth';
import { notifications } from '../db/schema/notifications';
import { users } from '../db/schema/users';
import { isForeignKeyViolation } from '@oxy.so/db';
import { logger } from '../utils/logger';
import { sendSuccess } from '../utils/asyncHandler';
import { UnauthorizedError, BadRequestError, NotFoundError, ConflictError, InternalServerError } from '../utils/error';
import { PAGINATION } from '../utils/constants';
import { createOxyNotificationRequestSchema } from '@oxy.so/contracts';
import { applications } from '../db/schema/applications';

// =============================================================================
// WIRE SERIALIZERS
// =============================================================================

type NotificationRow = typeof notifications.$inferSelect;

/**
 * The actor as `populate('actorId', 'username name avatar _id')` rendered it.
 *
 * `name` is the RAW stored sub-document, not a composed DTO: a `.lean()`
 * populate ran no virtuals, so `name.full` and `name.displayName` were never on
 * this path and are not added by the port.
 */
interface NotificationActorResponse {
  _id: string;
  username?: string;
  name?: { first: string; last: string };
  avatar?: string;
}

/** One notification exactly as `GET /notifications` has always emitted it. */
interface NotificationResponse {
  _id: string;
  recipientId: string;
  actorId: string | NotificationActorResponse;
  type: NotificationRow['type'];
  entityId: string;
  entityType: NotificationRow['entityType'];
  /** `system` notifications only. */
  title?: string;
  message?: string;
  url?: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The columns of the joined actor.
 *
 * A `leftJoin` hands the whole group back as `null` when nothing matched, which
 * the actor foreign key makes unreachable — but the type says so honestly rather
 * than being narrowed away.
 */
interface ActorColumns {
  id: string;
  username: string | null;
  nameFirst: string | null;
  nameLast: string | null;
  avatar: string | null;
}

/**
 * Mongoose omitted an unset optional entirely rather than emitting `null`, and
 * the SDK's parses treat a `null` where a string is optional as a failure. A
 * drizzle nullable column reads back as `null`, so the two are reconciled here.
 */
function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

function toActorResponse(actor: ActorColumns): NotificationActorResponse {
  const response: NotificationActorResponse = { _id: actor.id };
  const username = optional(actor.username);
  if (username !== undefined) {
    response.username = username;
  }
  // Mongoose's `NameSchema` defaulted both parts to `''`, so a user carrying a
  // name sub-document always had two strings — never a missing half.
  if (actor.nameFirst !== null || actor.nameLast !== null) {
    response.name = { first: actor.nameFirst ?? '', last: actor.nameLast ?? '' };
  }
  const avatar = optional(actor.avatar);
  if (avatar !== undefined) {
    response.avatar = avatar;
  }
  return response;
}

function toNotificationResponse(
  row: NotificationRow,
  actor?: ActorColumns | null
): NotificationResponse {
  return {
    _id: row.id,
    recipientId: row.recipientId,
    // `populate` left the raw id in place when the referenced document was
    // missing; the actor foreign key makes that unreachable, and the fallback
    // keeps the field's type honest rather than pretending otherwise.
    actorId: actor ? toActorResponse(actor) : row.actorId,
    type: row.type,
    entityId: row.entityId,
    entityType: row.entityType,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    read: row.read,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A `system` notification's deep link must be somewhere the notifying app is
 * allowed to send people: an `https:` URL, or a CUSTOM SCHEME that the calling
 * application registered as one of its redirect URIs (`oxymove://…` for Oxy
 * Move). Anything else — `javascript:`, `http:`, credentials in the URL,
 * another app's scheme — is refused, because every client that renders the
 * notification would otherwise open it on a tap.
 */
async function assertAllowedNotificationUrl(url: string, appId: string | undefined): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError('Invalid notification data', { errors: [{ path: ['url'], message: 'url must be an absolute URL' }] });
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestError('Invalid notification data', { errors: [{ path: ['url'], message: 'url cannot carry credentials' }] });
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:' && appId) {
    const [app] = await getDb()
      .select({ redirectUris: applications.redirectUris })
      .from(applications)
      .where(eq(applications.id, appId))
      .limit(1);
    const registeredSchemes = new Set(
      (app?.redirectUris ?? []).flatMap((uri) => {
        try {
          const scheme = new URL(uri).protocol;
          return scheme === 'https:' || scheme === 'http:' ? [] : [scheme];
        } catch {
          return [];
        }
      }),
    );
    if (registeredSchemes.has(parsed.protocol)) return;
  }
  throw new BadRequestError('Invalid notification data', {
    errors: [{ path: ['url'], message: 'url must be https or a scheme registered by the calling application' }],
  });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Validates pagination parameters
 */
function validatePaginationParams(page: number, limit: number): boolean {
  return page >= 1 && limit >= 1 && limit <= PAGINATION.MAX_PAGE_SIZE;
}

/**
 * Emits a real-time notification via Socket.IO to the recipient's room.
 */
async function emitNotification(req: Request, notification: NotificationResponse): Promise<void> {
  try {
    const io = req.app.get('io');
    if (io && notification.recipientId) {
      const room = `user:${notification.recipientId}`;
      io.to(room).emit('notification', {
        id: notification._id,
        type: notification.type,
        actorId: notification.actorId,
        entityId: notification.entityId,
        entityType: notification.entityType,
        ...(notification.title !== undefined ? { title: notification.title } : {}),
        ...(notification.message !== undefined ? { message: notification.message } : {}),
        ...(notification.url !== undefined ? { url: notification.url } : {}),
        createdAt: notification.createdAt,
      });
    }
    logger.debug('Notification emitted', { type: notification.type, recipientId: notification.recipientId });
  } catch (error) {
    logger.error('Error emitting notification:', error);
  }
}

// =============================================================================
// CONTROLLER FUNCTIONS
// =============================================================================

/**
 * Retrieves notifications for a user
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Unauthorized: User ID not found');
    }

    const page = Number.parseInt(req.query.page as string) || PAGINATION.DEFAULT_PAGE;
    const limit = Number.parseInt(req.query.limit as string) || PAGINATION.DEFAULT_PAGE_SIZE;

    if (!validatePaginationParams(page, limit)) {
      throw new BadRequestError('Invalid pagination parameters');
    }

    const db = getDb();

    // Fetch notifications and unread count in parallel. The actor join replaces
    // `populate` — the same four columns that projection selected, resolved in
    // ONE statement instead of a second round trip.
    const [rows, [unread]] = await Promise.all([
      db
        .select({
          notification: notifications,
          actor: {
            id: users.id,
            username: users.username,
            nameFirst: users.nameFirst,
            nameLast: users.nameLast,
            avatar: users.avatar,
          },
        })
        .from(notifications)
        .leftJoin(users, eq(notifications.actorId, users.id))
        .where(eq(notifications.recipientId, userId))
        .orderBy(desc(notifications.createdAt))
        .offset((page - 1) * limit)
        .limit(limit),
      db
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false))),
    ]);

    sendSuccess(res, {
      notifications: rows.map((row) => toNotificationResponse(row.notification, row.actor)),
      unreadCount: unread?.value ?? 0,
      hasMore: rows.length === limit,
      page,
      limit,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
      throw error;
    }
    logger.error('Error fetching notifications', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error fetching notifications');
  }
};

/**
 * Creates a new notification
 * @param req - Express request
 * @param res - Express response
 */
export const createNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = createOxyNotificationRequestSchema.parse(req.body);
    const { recipientId, actorId, type, entityId, entityType } = validatedData;
    // Text is stored for `system` only; for every other type it is accepted and
    // discarded exactly as before (the contract refuses `url` elsewhere).
    const isSystem = type === 'system';
    if (isSystem && validatedData.url !== undefined) {
      await assertAllowedNotificationUrl(validatedData.url, (req as ServiceAuthRequest).serviceApp?.appId);
    }
    const text = isSystem
      ? { title: validatedData.title ?? null, message: validatedData.message ?? null, url: validatedData.url ?? null }
      : {};

    // The duplicate check and the insert are ONE statement: the unique index
    // `notifications_recipient_id_actor_id_type_entity_id_key` decides, so two
    // concurrent creates can no longer both pass a check and then collide.
    const [created] = await getDb()
      .insert(notifications)
      .values({ recipientId, actorId, type, entityId, entityType, ...text })
      .onConflictDoNothing({
        target: [
          notifications.recipientId,
          notifications.actorId,
          notifications.type,
          notifications.entityId,
        ],
      })
      .returning();

    if (!created) {
      throw new ConflictError('Duplicate notification');
    }

    const notification = toNotificationResponse(created);

    // Emit real-time notification
    await emitNotification(req, notification);

    sendSuccess(res, { notification }, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BadRequestError('Invalid notification data', { errors: error.errors });
    }
    if (error instanceof ConflictError || error instanceof BadRequestError) {
      throw error;
    }
    // `recipient_id` and `actor_id` are real foreign keys now. Mongo let a
    // notification name an account that does not exist; here the row is
    // refused, and that is a bad REQUEST — the caller supplied both ids.
    if (isForeignKeyViolation(error)) {
      throw new BadRequestError('Invalid notification data', {
        errors: [{ message: 'recipientId and actorId must name existing accounts' }],
      });
    }

    logger.error('Error creating notification', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error creating notification');
  }
};

/**
 * Marks a notification as read
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const markAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    // `id`, not `notificationId` — see the module header. The old name matched
    // no route parameter, so the update hit an arbitrary row of the caller's.
    const { id } = req.params;

    if (!userId) {
      throw new UnauthorizedError('Unauthorized: User ID not found');
    }

    // Scoped to the recipient, so one account can never mark another's
    // notification read: a foreign id simply matches no row and 404s.
    const [notification] = await getDb()
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, id), eq(notifications.recipientId, userId)))
      .returning();

    if (!notification) {
      throw new NotFoundError('Notification not found');
    }

    sendSuccess(res, { notification: toNotificationResponse(notification) });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
      throw error;
    }
    logger.error('Error marking notification as read', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error marking notification as read');
  }
};

/**
 * Marks all notifications as read for a user
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const markAllAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw new UnauthorizedError('Unauthorized: User ID not found');
    }

    const updated = await getDb()
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false)))
      .returning({ id: notifications.id });

    sendSuccess(res, {
      message: `Marked ${updated.length} notifications as read`,
      modifiedCount: updated.length,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    logger.error('Error marking all notifications as read', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error marking all notifications as read');
  }
};

/**
 * Deletes a notification
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const deleteNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    // `id`, not `notificationId` — see the module header.
    const { id } = req.params;

    if (!userId) {
      throw new UnauthorizedError('Unauthorized: User ID not found');
    }

    const [notification] = await getDb()
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.recipientId, userId)))
      .returning({ id: notifications.id });

    if (!notification) {
      throw new NotFoundError('Notification not found');
    }

    sendSuccess(res, {
      message: 'Notification deleted successfully',
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
      throw error;
    }
    logger.error('Error deleting notification', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error deleting notification');
  }
};

/**
 * Gets unread notification count for a user
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const getUnreadCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw new UnauthorizedError('Unauthorized: User ID not found');
    }

    const [unread] = await getDb()
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false)));

    sendSuccess(res, { unreadCount: unread?.value ?? 0 });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    logger.error('Error fetching unread count', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Error fetching unread count');
  }
};
