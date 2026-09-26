import { useEffect } from 'react';
import { Linking } from 'react-native';
import { useOxy } from '@oxy.so/services';
import { logger } from '@oxy.so/core';
import { subscribeToNotificationResponses } from '@oxy.so/services/notifications';
import {
  claimSystemNotification,
  openSystemNotification,
  systemNotificationIdFromPush,
} from '@/lib/notifications/system-notification-push';

const LOG_CONTEXT = { component: 'useSystemNotificationTaps' } as const;

/**
 * Open what a tapped `system` notification points at — Oxy Move's job page for
 * "your Mastodon account moved" — and mark it read.
 *
 * Every tap needs a bearer (the notification is re-read from Oxy, scoped to the
 * signed-in recipient), so nothing happens until `enabled` AND the SDK reports a
 * usable session. The notification that COLD-LAUNCHED the app arrives as
 * `launchNotificationId`, resolved by the one cold-launch reader in
 * `app/_layout.tsx`, and is opened as soon as that holds; later taps come
 * through the listener. A per-session claim keeps the same tap from opening
 * twice.
 *
 * @param enabled - The root's "routing gate settled on an identity" signal.
 * @param launchNotificationId - The system notification whose tap launched the
 *   app, or `null`.
 */
export function useSystemNotificationTaps(enabled: boolean, launchNotificationId: string | null): void {
  const { canUsePrivateApi, oxyServices } = useOxy();
  const ready = enabled && canUsePrivateApi && Boolean(oxyServices);

  useEffect(() => {
    if (!ready || !oxyServices) return;

    const open = (notificationId: string): void => {
      if (!claimSystemNotification(notificationId)) return;
      openSystemNotification(oxyServices, notificationId, (url) => Linking.openURL(url)).catch((error: unknown) => {
        logger.warn('[commons] could not open a system notification', LOG_CONTEXT, error);
      });
    };

    if (launchNotificationId) {
      open(launchNotificationId);
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeToNotificationResponses((data) => {
      const notificationId = systemNotificationIdFromPush(data);
      if (notificationId) open(notificationId);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unsubscribe = off;
      })
      .catch((error: unknown) => {
        logger.warn('[commons] could not listen for system notification taps', LOG_CONTEXT, error);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [ready, oxyServices, launchNotificationId]);
}
