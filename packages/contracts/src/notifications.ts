/**
 * The closed set of Oxy in-app notification types — owned here so the API's
 * CHECK constraint (`notifications.type`), its request validation and the SDK
 * all read one tuple.
 *
 * `system` is a message from an Oxy service about the recipient's OWN account
 * (Oxy Move's "your migration finished"): the actor is the recipient and the
 * entity is their profile. It is the only type an actor does not cause.
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

/** What a notification's `entityId` names. */
export const OXY_NOTIFICATION_ENTITY_TYPES = ['post', 'reply', 'profile'] as const;

export type OxyNotificationEntityType = (typeof OXY_NOTIFICATION_ENTITY_TYPES)[number];

/**
 * `POST /notifications` (service token with `notifications:write`). `title`,
 * `message` and `data` are accepted on the wire but not persisted by the API
 * today; a client renders a notification from its `type` and entity.
 */
export const createOxyNotificationRequestSchema = z.object({
  recipientId: z.string().min(1),
  actorId: z.string().min(1),
  type: z.enum(OXY_NOTIFICATION_TYPES),
  entityId: z.string().min(1),
  entityType: z.enum(OXY_NOTIFICATION_ENTITY_TYPES),
  title: z.string().optional(),
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type CreateOxyNotificationRequest = z.infer<typeof createOxyNotificationRequestSchema>;
