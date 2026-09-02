/**
 * Notification Routes
 * 
 * RESTful API routes for notification operations.
 * Uses asyncHandler for consistent error handling.
 */

import express from 'express';
import {
  getNotifications,
  createNotification,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount
} from '../controllers/notification.controller';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import {
  createNotificationSchema,
  notificationIdParams,
  registerPushTokenSchema,
  unregisterPushTokenSchema,
  type RegisterPushTokenBody,
  type UnregisterPushTokenBody,
} from '../schemas/notifications.schemas';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { pushTokens } from '../db/schema/pushTokens';
import { resolveApplicationIdFromClientId } from '../utils/resolveApplicationFromClientId';
import { logger } from '../utils/logger';
import type { NextFunction, Response } from 'express';

const router = express.Router();

const NOTIFICATIONS_WRITE_SCOPE = 'notifications:write';

/**
 * Gate notification creation behind the privileged `notifications:write` scope.
 * Creating a notification lets the caller deliver realtime activity to ANY
 * recipient and choose the actor/entity metadata, so it must be restricted to
 * trusted services that staff explicitly granted the scope — never any
 * session-authenticated end user.
 */
const requireNotificationsWriteScope = (req: ServiceAuthRequest, res: Response, next: NextFunction) => {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(NOTIFICATIONS_WRITE_SCOPE)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `Missing required scope: ${NOTIFICATIONS_WRITE_SCOPE}`,
    });
  }

  return next();
};

// Create a new notification — service-token + privileged scope only. Registered
// BEFORE the user `authMiddleware` so a session token never reaches this route.
router.post(
  '/',
  serviceAuthMiddleware,
  requireNotificationsWriteScope,
  validate({ body: createNotificationSchema }),
  asyncHandler(createNotification)
);

// Apply user authentication middleware to all remaining routes
router.use(authMiddleware);

// Get all notifications for the authenticated user
router.get('/', asyncHandler(getNotifications));

// Get unread notification count
router.get('/unread-count', asyncHandler(getUnreadCount));

// ─── Push Token Management ──────────────────────────────────────────

/**
 * Explicit write whitelist for a push-token upsert — never `req.body`.
 *
 * `token` arrives already TRIMMED: `registerPushTokenSchema` declares
 * `z.string().trim()` and `validate` replaces `req.body` with the parsed value.
 * That is the port of Mongoose's `trim: true` on `PushToken.token`, which had no
 * Postgres counterpart and would otherwise have let `"tok "` and `"tok"` become
 * two rows under the `(user_id, token)` unique index (`CONVENTIONS.md`,
 * "Mongoose behaviour that has no schema counterpart"). The unregister schema
 * trims identically, so a token registered from a padded string is still
 * deletable by the same padded string.
 */
interface PushTokenWrite {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId?: string;
  /** Resolved server-side from the caller's `clientId`; a `text` id, either shape. */
  applicationId?: string;
}

// Register a push token
router.post(
  '/push-token',
  validate({ body: registerPushTokenSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const { token, platform, deviceId, clientId } = req.body as RegisterPushTokenBody;

    const write: PushTokenWrite = { userId, token, platform };

    if (deviceId !== undefined) {
      write.deviceId = deviceId;
    }

    if (clientId !== undefined) {
      const applicationId = await resolveApplicationIdFromClientId(clientId);
      if (!applicationId) {
        // One generic message for every rejection path so the response never
        // enumerates which credentials exist or what state they are in.
        return res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'clientId does not resolve to an active application',
        });
      }
      write.applicationId = applicationId;
    }

    // Only the fields the caller actually sent are updated on conflict, so
    // re-registering an existing install never silently drops a scope it
    // already carries — the same guarantee Mongo's explicit `$set` of the
    // whitelist gave. `updated_at` is bumped by drizzle's `$onUpdate`, which
    // applies to the `do update` branch too.
    const onConflict: Partial<PushTokenWrite> = { platform: write.platform };
    if (write.deviceId !== undefined) {
      onConflict.deviceId = write.deviceId;
    }
    if (write.applicationId !== undefined) {
      onConflict.applicationId = write.applicationId;
    }

    try {
      // ONE statement, so the concurrent-registration race Mongo answered with
      // an `E11000` retry is now unrepresentable: `push_tokens_user_id_token_key`
      // is the conflict target, and a duplicate takes the `do update` branch
      // rather than raising.
      await getDb()
        .insert(pushTokens)
        .values(write)
        .onConflictDoUpdate({
          target: [pushTokens.userId, pushTokens.token],
          set: onConflict,
        });

      return res.status(200).json({ data: { registered: true } });
    } catch (err: unknown) {
      logger.error('Failed to register push token', err instanceof Error ? err : new Error(String(err)));
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Failed to register push token' });
    }
  }),
);

// Unregister a push token
router.delete(
  '/push-token',
  validate({ body: unregisterPushTokenSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const { token } = req.body as UnregisterPushTokenBody;

    await getDb()
      .delete(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));

    return res.status(200).json({ data: { unregistered: true } });
  }),
);

// Mark a notification as read
router.put('/:id/read', validate({ params: notificationIdParams }), asyncHandler(markAsRead));

// Mark all notifications as read
router.put('/read-all', asyncHandler(markAllAsRead));

// Delete a notification
router.delete('/:id', validate({ params: notificationIdParams }), asyncHandler(deleteNotification));

export default router;
