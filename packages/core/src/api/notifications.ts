/**
 * `oxy.notifications` — the signed-in user's in-app inbox, and this
 * installation's push token.
 *
 * ## Push tokens are EXPO push tokens
 *
 * `registerPushToken` takes the token `Notifications.getExpoPushTokenAsync()`
 * returns — the `ExponentPushToken[…]` handle — because the server delivers
 * through Expo's push service, which only accepts that form. A raw APNs/FCM
 * token from `getDevicePushTokenAsync()` registers "successfully" and then
 * every push silently fails at delivery, so it is rejected here, before any
 * request. Acquiring the token (permission prompt, `expo-notifications`) is the
 * app's job — `@oxy.so/core` never imports an `expo-*` module.
 *
 * Creating a notification is a service-token call: `OxyServer`'s
 * `notifications.create` (`@oxy.so/core/server`).
 */
import type { OxyContext } from '../client/context';
import type { Notification, NotificationPage } from '../models/interfaces';
import { buildQueryParams } from '../utils/apiUtils';

/** Platform a push token was minted on; the server rejects any other value. */
export type PushTokenPlatform = 'ios' | 'android' | 'web';

/**
 * `ExponentPushToken[…]` (what `getExpoPushTokenAsync()` returns) or the
 * equivalent `ExpoPushToken[…]`. Plain ASCII: core ships to Hermes, where
 * Unicode property escapes throw at runtime.
 */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^[\]\s]+\]$/;

/** Input for {@link NotificationsApi.registerPushToken}. */
export interface RegisterPushTokenInput {
  /**
   * The **Expo push token** for this installation (`ExponentPushToken[…]`).
   * NOT the raw APNs/FCM token from `getDevicePushTokenAsync()`.
   */
  expoPushToken: string;
  platform: PushTokenPlatform;
  /**
   * The device-first `deviceId` this installation is registered under, so the
   * server can retire the token when that device session goes away.
   */
  deviceId?: string;
  /**
   * The registered OAuth client id (`oxy_dk_…`) of WHICH application this
   * installation is — what lets a "Sign in with Oxy" request reach a known
   * Commons installation instead of every token the identity owns.
   */
  clientId?: string;
}

export class NotificationsApi {
  constructor(protected readonly ctx: OxyContext) {}

  // ── Inbox ────────────────────────────────────────────────────────────────

  /** One page of the inbox, newest first, with the unread count across all pages. */
  async list(params: { page?: number; limit?: number } = {}): Promise<NotificationPage> {
    return this.ctx.request<NotificationPage>('GET', '/notifications', buildQueryParams({ page: params.page, limit: params.limit }), {
      cache: false,
    });
  }

  /** How many notifications are unread. */
  async unreadCount(): Promise<number> {
    const res = await this.ctx.request<{ unreadCount: number }>('GET', '/notifications/unread-count', undefined, { cache: false });
    return res.unreadCount;
  }

  /**
   * Mark one notification read and return it as stored. Scoped to the recipient
   * server-side, so it is also the authoritative read by id: a foreign or
   * unknown id 404s.
   */
  async markRead(notificationId: string): Promise<Notification> {
    const res = await this.ctx.request<{ notification: Notification }>(
      'PUT',
      `/notifications/${encodeURIComponent(notificationId)}/read`,
      undefined,
      { cache: false },
    );
    return res.notification;
  }

  /** Mark every notification read. */
  async markAllRead(): Promise<void> {
    await this.ctx.request('PUT', '/notifications/read-all', undefined, { cache: false });
  }

  /** Delete one notification. */
  async delete(notificationId: string): Promise<void> {
    await this.ctx.request('DELETE', `/notifications/${encodeURIComponent(notificationId)}`, undefined, { cache: false });
  }

  // ── Push tokens ──────────────────────────────────────────────────────────

  /**
   * Register this installation's Expo push token for the signed-in identity
   * (`POST /notifications/push-token`). Idempotent server-side, so it is safe to
   * call on every cold boot.
   *
   * @throws When `expoPushToken` is not an Expo push token.
   */
  async registerPushToken(input: RegisterPushTokenInput): Promise<void> {
    if (!EXPO_PUSH_TOKEN_PATTERN.test(input.expoPushToken)) {
      throw new Error(
        'registerPushToken expects an Expo push token ("ExponentPushToken[...]", from getExpoPushTokenAsync). ' +
          'A raw APNs/FCM device token from getDevicePushTokenAsync cannot be delivered to.',
      );
    }
    await this.ctx.request(
      'POST',
      '/notifications/push-token',
      {
        token: input.expoPushToken,
        platform: input.platform,
        // Omitted when absent: the server reads presence.
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
      },
      { cache: false },
    );
  }

  /**
   * Retire a push token (`DELETE /notifications/push-token`). Call it when the
   * user turns notifications off, when the identity is replaced, and on
   * sign-out — or the installation keeps receiving requests for an identity it
   * no longer holds.
   */
  async unregisterPushToken(expoPushToken: string): Promise<void> {
    await this.ctx.request('DELETE', '/notifications/push-token', { token: expoPushToken }, { cache: false });
  }
}
