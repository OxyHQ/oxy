/**
 * Canonical contract for Inbox new-mail push notifications.
 *
 * The Android channel id and payload `type` are wire contracts: Android 8+
 * drops a notification whose channel the app has not created, and the client
 * only routes taps it recognises. Two hand-typed copies of either string fail as
 * "the notification never arrived" or "tapping does nothing" — the hardest push
 * symptoms to diagnose.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

/** Android notification channel id the new-mail push is sent on. */
export const INBOX_EMAIL_PUSH_CHANNEL = 'email';

/** Runtime type discriminator of the new-mail push payload. */
export const INBOX_EMAIL_PUSH_TYPE = 'oxy_inbox_new_message';

export const inboxEmailPushDataSchema = z.object({
  type: z.literal(INBOX_EMAIL_PUSH_TYPE),
  messageId: z.string().min(1),
  mailboxId: z.string().min(1),
});

export type InboxEmailPushData = z.infer<typeof inboxEmailPushDataSchema>;
