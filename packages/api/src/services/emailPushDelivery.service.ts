/**
 * Scoped delivery of new-mail push notifications to Inbox installations only.
 *
 * Push tokens are registered per-application (`clientId` → `applicationId`), so
 * email delivery must target only the Inbox app's registrations — never every
 * push token the identity owns (which would leak mail alerts to Commons and any
 * other Oxy app on the same account).
 *
 * ## What the Postgres port changes
 *
 * `PushToken.find({ userId, applicationId })` CAST both values: the Mongoose
 * schema declares each as a `Schema.Types.ObjectId`, so a value that is not
 * 24-char hex raised a `CastError` rather than matching no rows. Both ids are
 * now **uuid v7** for anything minted after the cutover (`@oxyhq/db`'s
 * `generatedId()`), and `resolveApplicationIdFromClientId` hands this function
 * exactly such an id. The throw landed in `sendInboxEmailPush`'s own catch, so
 * the whole inbox push for that identity disappeared into a `logger.warn` with
 * no failed request and no bounced mail — a silent, permanent loss of new-mail
 * notifications for every post-cutover account.
 *
 * Here both are `text` comparisons: an id that names no row selects no row, in
 * either id shape.
 */

import { INBOX_EMAIL_PUSH_CHANNEL, INBOX_EMAIL_PUSH_TYPE } from '@oxyhq/contracts';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { pushTokens } from '../db/schema/pushTokens';
import { pushService } from './push.service';
import { resolveApplicationIdFromClientId } from '../utils/resolveApplicationFromClientId';
import { logger } from '../utils/logger';

/** Production Inbox `ApplicationCredential.publicKey` — overridable per env. */
const INBOX_CLIENT_ID =
  process.env.INBOX_CLIENT_ID ?? 'oxy_dk_19cf17069d097a6ebf17a622709a53d13692ee69487224e3';

export type InboxEmailPushPayload = {
  type: typeof INBOX_EMAIL_PUSH_TYPE;
  messageId: string;
  mailboxId: string;
};

/**
 * The user's Inbox installs, and nothing else.
 *
 * The `application_id` equality IS the scoping rule, and it is why an UNSCOPED
 * install (`application_id` NULL, a registration that named no `clientId`) is
 * never a target: SQL equality against a value is never true for NULL, so those
 * rows are excluded by construction rather than by a second predicate.
 */
async function resolveInboxPushTokens(userId: string): Promise<string[]> {
  const applicationId = await resolveApplicationIdFromClientId(INBOX_CLIENT_ID);
  if (!applicationId) {
    return [];
  }

  const installs = await getDb()
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.applicationId, applicationId)));

  return installs.map((install) => install.token);
}

/**
 * Push a new-mail notification to the user's Inbox installations only.
 * Fire-and-forget — never throws.
 */
export async function sendInboxEmailPush(params: {
  userId: string;
  title: string;
  body: string;
  messageId: string;
  mailboxId: string;
}): Promise<void> {
  const { userId, title, body, messageId, mailboxId } = params;

  try {
    const tokens = await resolveInboxPushTokens(userId);
    if (tokens.length === 0) {
      return;
    }

    const data: InboxEmailPushPayload = {
      type: INBOX_EMAIL_PUSH_TYPE,
      messageId,
      mailboxId,
    };

    await pushService.sendPushToTokens({
      userId,
      tokens,
      title,
      body,
      channelId: INBOX_EMAIL_PUSH_CHANNEL,
      data,
    });
  } catch (err) {
    logger.warn('[EmailPush] Inbox push delivery failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
