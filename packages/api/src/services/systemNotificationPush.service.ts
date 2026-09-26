/**
 * Push delivery of a `system` notification — an Oxy service telling a person
 * about their own account (Oxy Move's "your Mastodon account moved").
 *
 * The notification row is the record; this is how the person actually learns
 * of it. It goes to the account's VAULT installs (Commons — the installs whose
 * application carries the `identity:approval` capability, resolved by the same
 * registry join the sign-in approval push uses) and nowhere else: a message
 * about the Oxy account belongs in the app that holds the Oxy account, not in
 * Inbox or any other app that happens to share the identity.
 *
 * The push carries the notification's own title and message as its title and
 * body, and exactly one datum: the notification id. The deep link is NOT in
 * the payload — a push is untrusted at the receiver — so the vault re-reads the
 * notification by id, scoped to the signed-in recipient, and opens the `url`
 * stored there.
 *
 * Honours the recipient's `pushEnabled` preference. Never throws: push is an
 * auxiliary channel and must not fail the create that triggered it.
 */

import {
  OXY_ACCOUNT_PUSH_CHANNEL,
  OXY_SYSTEM_NOTIFICATION_PUSH_TYPE,
  type OxySystemNotificationPushData,
} from '@oxy.so/contracts';
import { eq } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import { resolveIdentityApprovalTokens } from './authSessionDelivery.service';
import { pushService, type PushDispatchResult } from './push.service';

export interface SystemNotificationPushInput {
  notificationId: string;
  recipientId: string;
  title: string;
  message: string;
}

const NOTHING_SENT: PushDispatchResult = { targeted: 0, accepted: 0 };

export async function pushSystemNotification(
  input: SystemNotificationPushInput,
): Promise<PushDispatchResult> {
  const { notificationId, recipientId, title, message } = input;
  try {
    const [recipient] = await getDb()
      .select({ pushEnabled: users.notificationPushEnabled })
      .from(users)
      .where(eq(users.id, recipientId))
      .limit(1);
    if (!recipient?.pushEnabled) {
      return NOTHING_SENT;
    }

    const tokens = await resolveIdentityApprovalTokens(recipientId);
    if (tokens.length === 0) {
      return NOTHING_SENT;
    }

    const data: OxySystemNotificationPushData = {
      type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE,
      notificationId,
    };
    return await pushService.sendPushToTokens({
      userId: recipientId,
      tokens,
      title,
      body: message,
      channelId: OXY_ACCOUNT_PUSH_CHANNEL,
      data,
    });
  } catch (err) {
    logger.warn('[SystemNotification] push delivery failed', {
      notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING_SENT;
  }
}
