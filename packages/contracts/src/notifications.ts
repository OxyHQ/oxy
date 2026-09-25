/**
 * The closed set of Oxy in-app notification types — owned here so the API's
 * CHECK constraint (`notifications.type`), its request validation and the SDK
 * all read one tuple.
 *
 * `system` is a message from an Oxy service about the recipient's OWN account
 * (Oxy Move's "your migration finished"): the actor is the recipient, and the
 * entity is their profile or an `app` id. It is the only type an actor does not
 * cause.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

export const OXY_NOTIFICATION_TYPES = [
  'like',
  'reply',
  'mention',
  'follow',
  'repost',
  'quote',
  'welcome',
  'system',
] as const;

export type OxyNotificationType = (typeof OXY_NOTIFICATION_TYPES)[number];

/**
 * What a notification's `entityId` names.
 *
 * `app` means `entityId` is an OPAQUE id in the notifying application's own
 * namespace (Oxy Move's migration job id). Oxy never resolves it; it exists so
 * a `system` notification about something that is not a post or a profile does
 * not have to pretend to be one. Valid only with `type: 'system'`.
 */
export const OXY_NOTIFICATION_ENTITY_TYPES = ['post', 'reply', 'profile', 'app'] as const;

export type OxyNotificationEntityType = (typeof OXY_NOTIFICATION_ENTITY_TYPES)[number];

/** Length caps on the text a `system` notification carries (enforced by CHECKs too). */
export const OXY_SYSTEM_NOTIFICATION_TITLE_MAX = 120;
export const OXY_SYSTEM_NOTIFICATION_MESSAGE_MAX = 500;
export const OXY_NOTIFICATION_URL_MAX = 2048;

/**
 * `POST /notifications` (service token with `notifications:write`).
 *
 * Only a `system` notification carries text: `title` and `message` are REQUIRED
 * for it and stored, and `url` is an optional deep link (https, or a custom
 * scheme registered as a redirect URI on the calling application). For every
 * other type the client renders from `type` + entity, and `title` / `message` /
 * `data` are accepted but discarded, as they always were.
 *
 * `system` notifications share the duplicate guard (recipient, actor, type,
 * entityId): use a caller-unique `entityId` (a job id) for each distinct event.
 */
export const createOxyNotificationRequestSchema = z
  .object({
    recipientId: z.string().min(1),
    actorId: z.string().min(1),
    type: z.enum(OXY_NOTIFICATION_TYPES),
    entityId: z.string().min(1),
    entityType: z.enum(OXY_NOTIFICATION_ENTITY_TYPES),
    title: z.string().trim().min(1).max(OXY_SYSTEM_NOTIFICATION_TITLE_MAX).optional(),
    message: z.string().trim().min(1).max(OXY_SYSTEM_NOTIFICATION_MESSAGE_MAX).optional(),
    url: z.string().trim().min(1).max(OXY_NOTIFICATION_URL_MAX).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'system') {
      if (value.actorId !== value.recipientId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['actorId'], message: 'a system notification is from the recipient\'s own account' });
      if (!value.title) context.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'title is required for a system notification' });
      if (!value.message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['message'], message: 'message is required for a system notification' });
    } else {
      if (value.url !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is only stored for a system notification' });
      }
      if (value.entityType === 'app') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['entityType'], message: "entityType 'app' is only valid for a system notification" });
      }
    }
  });

export type CreateOxyNotificationRequest = z.infer<typeof createOxyNotificationRequestSchema>;
