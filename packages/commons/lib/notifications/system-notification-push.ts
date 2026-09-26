/**
 * The push that announces a `system` notification — an Oxy service telling the
 * person about their own account (Oxy Move's "your Mastodon account moved").
 *
 *   { type: 'oxy_system_notification', notificationId: '<id>' }
 *
 * The OS shows the push's own title and body; the payload carries only the
 * notification id. Like every push, it is UNTRUSTED: a tap never opens a link
 * from the payload. It re-reads the notification from Oxy by id — marking it
 * read, scoped server-side to the signed-in recipient, so a foreign or invented
 * id resolves to nothing — and opens only the `url` stored there, which the API
 * validated when the notification was created.
 */

import { oxySystemNotificationPushDataSchema } from '@oxy.so/contracts';
import type { Notification } from '@oxy.so/core';

/**
 * The notification id a push announces, or `null` when the push is not a
 * well-formed system-notification push (which the caller treats as "not ours").
 */
export function systemNotificationIdFromPush(data: unknown): string | null {
  const parsed = oxySystemNotificationPushDataSchema.safeParse(data);
  return parsed.success ? parsed.data.notificationId : null;
}

/**
 * Ids this app session has already opened. The OS can hand the same launching
 * tap to both the cold-launch replay and a freshly attached listener; the first
 * claim wins and the other no-ops. Module-scoped, touched only from effects and
 * event handlers.
 */
const claimedSystemNotificationIds = new Set<string>();

/** @returns `true` when the caller owns this id and should open it. */
export function claimSystemNotification(notificationId: string): boolean {
  if (claimedSystemNotificationIds.has(notificationId)) {
    return false;
  }
  claimedSystemNotificationIds.add(notificationId);
  return true;
}

/** The `@oxy.so/core` surface a tap drives (satisfied by `OxyServices`). */
export interface SystemNotificationReader {
  markNotificationAsRead: (notificationId: string) => Promise<Notification>;
}

/**
 * Schemes a link must never be opened with, whatever the server stored: the
 * API admits only `https:` or the sending app's registered scheme, and this is
 * the receiver's own floor under that.
 */
const NEVER_OPENED_SCHEMES = new Set(['http:', 'javascript:', 'data:', 'file:', 'blob:', 'vbscript:']);

function isOpenableLink(url: string): boolean {
  try {
    return !NEVER_OPENED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export type SystemNotificationTapOutcome = 'opened' | 'no-link';

/**
 * Act on a tapped system-notification push: mark it read and open its stored
 * deep link, if it has one.
 *
 * @throws Whatever `markNotificationAsRead` throws (unknown id, no session);
 *   the caller logs it — the notification itself was already seen in the shade.
 */
export async function openSystemNotification(
  reader: SystemNotificationReader,
  notificationId: string,
  openUrl: (url: string) => Promise<unknown>,
): Promise<SystemNotificationTapOutcome> {
  const notification = await reader.markNotificationAsRead(notificationId);
  if (notification.type !== 'system' || !notification.url || !isOpenableLink(notification.url)) {
    return 'no-link';
  }
  await openUrl(notification.url);
  return 'opened';
}
