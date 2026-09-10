/**
 * Push Notification Registration Mixin
 *
 * Registers this installation's push token with Oxy so the platform can reach
 * the signed-in identity — most importantly to deliver a "Sign in with Oxy"
 * approval request to a known Commons installation (issue #691, Phase 4)
 * instead of forcing the user onto a QR.
 *
 * This lives in `@oxy.so/core` because push registration is cross-cutting: every
 * Oxy app that wants to receive platform notifications performs the exact same
 * bearer-authenticated register/unregister pair. App-local copies drift (see the
 * token-kind hazard below), so there is ONE implementation here.
 *
 * ## The token is an EXPO PUSH TOKEN
 *
 * `registerPushToken` takes the token returned by
 * `Notifications.getExpoPushTokenAsync()` — the `ExponentPushToken[…]` handle —
 * because the server delivers through Expo's push service, which only accepts
 * that form.
 *
 * It does NOT take `getDevicePushTokenAsync()`'s raw APNs/FCM device token.
 * Registering one of those looks completely successful (the row is stored, the
 * endpoint returns 200) and then every push silently fails at delivery time,
 * which is exactly the failure mode this surface is written to make impossible:
 * the token is validated here, at the call site, so a raw device token is
 * rejected immediately with an explicit error rather than becoming a dead
 * registration nobody notices.
 *
 * Acquiring the token (permission prompt, `expo-notifications`) is the app's
 * job — `@oxy.so/core` never imports an `expo-*` module.
 */
import type { OxyServicesBase } from '../OxyServices.base';

/**
 * Platform the push token was minted on. Mirrors the enum the server accepts;
 * a value outside it is rejected server-side.
 */
export type PushTokenPlatform = 'ios' | 'android' | 'web';

/**
 * Shape of an Expo push token: `ExponentPushToken[…]` (what
 * `getExpoPushTokenAsync()` returns today) or the equivalent `ExpoPushToken[…]`
 * spelling. Deliberately plain ASCII — `@oxy.so/core` ships to Hermes, where
 * Unicode property escapes throw at runtime.
 */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^[\]\s]+\]$/;

/** Registration input for {@link OxyServicesNotificationsMixin.registerPushToken}. */
export interface RegisterPushTokenInput {
  /**
   * The **Expo push token** for this installation — `ExponentPushToken[…]`,
   * from `Notifications.getExpoPushTokenAsync()`.
   *
   * NOT the raw APNs/FCM token from `getDevicePushTokenAsync()`; that form is
   * rejected before any request is sent.
   */
  expoPushToken: string;
  /** Platform this token was minted on. */
  platform: PushTokenPlatform;
  /**
   * Optional device-first `deviceId` this installation is registered under, so
   * the server can retire the token when that device session goes away instead
   * of pushing to an installation that has signed out.
   */
  deviceId?: string;
  /**
   * Optional registered OAuth client id (the caller's credential `publicKey`,
   * `oxy_dk_…`) identifying WHICH application this installation is. The server
   * resolves it to the registering `Application` and rejects an unusable one.
   *
   * This is what makes "deliver the approval request to a known Commons
   * installation" possible: delivery targets the Commons application's
   * registrations, never every push token the identity owns.
   */
  clientId?: string;
}

export function OxyServicesNotificationsMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    /**
     * Register this installation's **Expo** push token for the authenticated
     * identity (`POST /notifications/push-token`, bearer required).
     *
     * Idempotent server-side: re-registering the same token for the same
     * identity refreshes the existing row rather than creating a duplicate, so
     * callers can safely re-register on every cold boot.
     *
     * @throws When `expoPushToken` is not an Expo push token — a raw APNs/FCM
     *   device token fails here rather than becoming a silently undeliverable
     *   registration.
     */
    async registerPushToken(input: RegisterPushTokenInput): Promise<void> {
      try {
        if (!EXPO_PUSH_TOKEN_PATTERN.test(input.expoPushToken)) {
          throw new Error(
            'registerPushToken expects an Expo push token ("ExponentPushToken[...]", from getExpoPushTokenAsync). ' +
              'A raw APNs/FCM device token from getDevicePushTokenAsync cannot be delivered to.',
          );
        }

        await this.makeRequest<unknown>(
          'POST',
          '/notifications/push-token',
          {
            token: input.expoPushToken,
            platform: input.platform,
            // Omitted entirely when absent so the body stays exactly what the
            // endpoint has always received (the server reads presence).
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            ...(input.clientId ? { clientId: input.clientId } : {}),
          },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Retire an **Expo** push token for the authenticated identity
     * (`DELETE /notifications/push-token`, bearer required).
     *
     * Call it when the user turns notifications off, when the vault identity is
     * replaced, and on sign-out — otherwise the installation keeps receiving
     * approval requests for an identity it no longer holds.
     *
     * @param expoPushToken - The exact token previously registered.
     */
    async unregisterPushToken(expoPushToken: string): Promise<void> {
      try {
        await this.makeRequest<unknown>(
          'DELETE',
          '/notifications/push-token',
          { token: expoPushToken },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
