/**
 * Push Notification Service
 *
 * Sends push notifications via the Expo Push API.
 * Uses a simple HTTP POST — no SDK dependency required on the backend.
 *
 * The notification channel/category is ALWAYS caller-supplied: this service has
 * no notion of what a message is about, so it never picks a channel of its own.
 * Two delivery shapes sit on top of one internal dispatcher:
 *
 *  - {@link sendPushNotification} — every install registered by the user.
 *  - {@link sendPushToTokens}     — an explicitly resolved subset of installs
 *                                   (e.g. only the user's identity-approval
 *                                   apps), where the CALLER owns the targeting.
 *
 * Neither ever throws: push is an auxiliary channel and must not fail the flow
 * that triggered it. Failures are logged and reported through the returned
 * counters.
 *
 * ## Token normalization does NOT live here
 *
 * Mongoose declared `PushToken.token` with `trim: true`, which applied to the
 * WRITE and to every filter it cast — including the `deleteOne` below. Postgres
 * has no counterpart, so per `db/schema/CONVENTIONS.md` the normalization is
 * re-applied at the REGISTRATION call site (`routes/notifications.routes.ts`,
 * where `registerPushTokenSchema` trims before the value is ever stored). Every
 * token this module deletes was read back out of `push_tokens` moments earlier,
 * so it is already in stored form and trimming it again here would be a
 * no-op dressed up as a guarantee.
 */

import { and, eq } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { pushTokens } from '../db/schema/pushTokens';
import { logger } from '../utils/logger';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** What a caller wants delivered, minus the targeting. */
interface PushMessageContent {
  title: string;
  body: string;
  /**
   * Android notification channel id (and, for Expo, the logical category of the
   * message). REQUIRED and never defaulted — the service has no way to know what
   * a message is about.
   *
   * NOTE: deliberately NOT an iOS `categoryId`. A category is what binds
   * interactive ACTION BUTTONS to a notification; approval-style notifications
   * must only ever open or dismiss, never approve from the notification shade.
   */
  channelId: string;
  data?: Record<string, unknown>;
}

/** Outcome of a delivery attempt. Counts only — never device or token detail. */
export interface PushDispatchResult {
  /** Installs the attempt targeted. */
  targeted: number;
  /** Installs whose message the Expo push service accepted (`ok` ticket). */
  accepted: number;
}

/**
 * Deliver `content` to an explicit set of push tokens.
 *
 * Batches at the Expo-recommended 100 messages per request and prunes tokens the
 * push service reports as `DeviceNotRegistered`. Never throws.
 */
async function dispatch(
  userId: string,
  tokens: string[],
  content: PushMessageContent,
): Promise<PushDispatchResult> {
  const result: PushDispatchResult = { targeted: tokens.length, accepted: 0 };

  if (tokens.length === 0) {
    return result;
  }

  const messages: ExpoPushMessage[] = tokens.map((token) => ({
    to: token,
    title: content.title,
    body: content.body,
    data: content.data,
    sound: 'default' as const,
    channelId: content.channelId,
  }));

  // Expo recommends batching up to 100 notifications per request
  const chunks = chunkArray(messages, 100);

  for (const chunk of chunks) {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });

      if (!response.ok) {
        logger.warn('Expo push API returned non-OK status', {
          status: response.status,
          userId,
        });
        continue;
      }

      const payload = await response.json() as { data: ExpoPushTicket[] };

      if (payload.data) {
        for (let i = 0; i < payload.data.length; i++) {
          const ticket = payload.data[i];

          if (ticket.status === 'ok') {
            result.accepted++;
            continue;
          }

          // Clean up invalid tokens (DeviceNotRegistered)
          if (
            ticket.details &&
            (ticket.details as Record<string, unknown>).error === 'DeviceNotRegistered'
          ) {
            const invalidToken = chunk[i].to;
            logger.info('Removing invalid push token', {
              userId,
              tokenPrefix: invalidToken.slice(0, 12),
            });
            await getDb()
              .delete(pushTokens)
              .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, invalidToken)));
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to send push notification chunk', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Send a push notification to ALL registered installs for a user.
 * Fire-and-forget — callers should not await this in critical paths.
 */
async function sendPushNotification(params: {
  userId: string;
  title: string;
  body: string;
  channelId: string;
  data?: Record<string, unknown>;
}): Promise<PushDispatchResult> {
  const { userId, title, body, channelId, data } = params;

  try {
    const tokens = await getDb()
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    return await dispatch(userId, tokens.map((t) => t.token), { title, body, channelId, data });
  } catch (err) {
    logger.warn('Failed to send push notification', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { targeted: 0, accepted: 0 };
  }
}

/**
 * Send a push notification to an EXPLICIT subset of a user's installs.
 *
 * The caller owns the targeting — and therefore the authorization decision
 * behind it; this only delivers. `userId` is still required so a token the push
 * service rejects is pruned from the right owner's registry.
 */
async function sendPushToTokens(params: {
  userId: string;
  tokens: string[];
  title: string;
  body: string;
  channelId: string;
  data?: Record<string, unknown>;
}): Promise<PushDispatchResult> {
  const { userId, tokens, title, body, channelId, data } = params;

  try {
    return await dispatch(userId, tokens, { title, body, channelId, data });
  } catch (err) {
    logger.warn('Failed to send push notification', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { targeted: tokens.length, accepted: 0 };
  }
}

/**
 * Split an array into chunks of the given size.
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export const pushService = {
  sendPushNotification,
  sendPushToTokens,
};

export default pushService;
