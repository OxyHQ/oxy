import { z } from 'zod';

// POST /notifications
export const createNotificationSchema = z.object({
  recipientId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  type: z.string().trim().min(1),
  entityId: z.string().trim().min(1),
  entityType: z.string().trim().min(1),
  title: z.string().trim().optional(),
  message: z.string().trim().optional(),
  url: z.string().trim().optional(),
  data: z.record(z.any()).optional(),
});

// Params with :id
export const notificationIdParams = z.object({
  id: z.string().trim().min(1),
});

/**
 * POST /notifications/push-token
 *
 * `deviceId` and `clientId` SCOPE the install. `clientId` is an
 * `ApplicationCredential.publicKey` (`oxy_dk_…`) resolved SERVER-side to an
 * active `Application` — the client never asserts an application id, and an
 * unresolvable value is REJECTED rather than stored unscoped.
 */
export const registerPushTokenSchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().trim().min(1).max(128).optional(),
  clientId: z.string().trim().min(1).max(128).optional(),
});

export type RegisterPushTokenBody = z.infer<typeof registerPushTokenSchema>;

// DELETE /notifications/push-token
export const unregisterPushTokenSchema = z.object({
  token: z.string().trim().min(1).max(512),
});

export type UnregisterPushTokenBody = z.infer<typeof unregisterPushTokenSchema>;
