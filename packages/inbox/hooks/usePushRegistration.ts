/**
 * Push-notification token registration.
 *
 * Wires the `pushNotifications` inbox preference to the SDK's push registry
 * (`oxyServices.registerPushToken` / `unregisterPushToken` from `@oxyhq/core`).
 * The registry is the ONE implementation for the whole ecosystem — an app-local
 * copy is how this app ended up registering raw APNs/FCM device tokens that the
 * server, which delivers through Expo, could never push to.
 *
 * Native only: `pushTokenPlatform()` reports no platform on web, so the whole
 * flow resolves to a skip there (browser push needs a VAPID + service-worker
 * subscription that isn't wired — see `NotificationsSection`). The single effect
 * below opens the "connection" (permission + token → register) and tears it down
 * (unregister) when the pref is turned off or the user signs out, mirroring the
 * socket lifecycle pattern.
 */

import { useEffect, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { logger } from '@oxyhq/core';

import { useInboxPrefs } from '@/contexts/inbox-prefs-context';
import { registerInboxPushToken } from '@/lib/notifications/push-registration';

const LOG_CONTEXT = { component: 'usePushRegistration' } as const;

export function usePushRegistration(): void {
  const { prefs } = useInboxPrefs();
  const { canUsePrivateApi, user, oxyServices, sessionClient } = useOxy();

  const enabled = prefs.pushNotifications;
  const userId = user?.id ?? null;

  /**
   * The token currently registered with the backend, so teardown can retire
   * exactly what was registered even after the pref has already flipped.
   */
  const registeredTokenRef = useRef<string | null>(null);

  useEffect(() => {
    // `canUsePrivateApi` is the SDK's own "a usable bearer is planted" verdict.
    // Waiting for it avoids racing the device-first cold boot with a doomed 401.
    if (!enabled || !canUsePrivateApi || !userId) {
      return;
    }

    let cancelled = false;

    const retire = (expoPushToken: string): void => {
      // Retirement is scoped server-side to the identity holding the bearer, so
      // it can only succeed while that session is live. After a sign-out there
      // is nothing left to authorise it — the row is then retired with the
      // device session, or pruned when a delivery to it first fails.
      if (!oxyServices.getAccessToken()) {
        return;
      }
      void oxyServices.unregisterPushToken(expoPushToken).catch((error: unknown) => {
        logger.warn('[inbox] could not retire the push token', LOG_CONTEXT, error);
      });
    };

    void (async () => {
      try {
        const outcome = await registerInboxPushToken(
          oxyServices,
          sessionClient?.getState()?.deviceId,
        );

        if (outcome.status === 'skipped') {
          // An expected steady state (web, permission declined, no token). The
          // adapter has already logged the operational reasons at warn level.
          logger.debug('[inbox] push registration skipped', {
            ...LOG_CONTEXT,
            reason: outcome.reason,
          });
          return;
        }

        if (cancelled) {
          // The pref flipped off (or the session ended) mid-flight: retire what
          // was just registered rather than leaving an orphaned row behind.
          retire(outcome.expoPushToken);
          return;
        }

        registeredTokenRef.current = outcome.expoPushToken;
      } catch (error) {
        // Best-effort by design: mail still arrives, it just doesn't buzz.
        // Registration retries on the next mount / pref toggle / sign-in.
        logger.warn('[inbox] push token registration failed', LOG_CONTEXT, error);
      }
    })();

    return () => {
      cancelled = true;
      const expoPushToken = registeredTokenRef.current;
      registeredTokenRef.current = null;
      if (expoPushToken) {
        retire(expoPushToken);
      }
    };
  }, [enabled, canUsePrivateApi, userId, oxyServices, sessionClient]);
}
