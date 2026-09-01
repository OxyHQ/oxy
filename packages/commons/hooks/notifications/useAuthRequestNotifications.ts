import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { logger } from '@oxyhq/core';
import { subscribeToNotificationResponses, takeLaunchNotificationData } from '@oxyhq/services';
import {
  authRequestCodeFromPush,
  claimAuthRequestCode,
} from '@/lib/notifications/auth-request-push';

const LOG_CONTEXT = { component: 'useAuthRequestNotifications' } as const;

/**
 * Resolve the approval code carried by the notification that COLD-LAUNCHED the
 * app, claiming it so the warm listener cannot route the same tap twice.
 *
 * Deliberately a plain async function, not a hook: the cold-launch handoff is
 * replayed by the ONE existing replay path in `app/_layout.tsx` (which also
 * owns `Linking.getInitialURL()` and the "wait until the routing gate settles"
 * logic). A push tap is just another source feeding that path — never a second
 * replay mechanism.
 *
 * Never rejects: a launch that carries no notification, an unavailable native
 * module, or an unparseable payload all resolve to `null`.
 */
export async function coldLaunchApprovalCode(): Promise<string | null> {
  const data = await takeLaunchNotificationData();
  const code = authRequestCodeFromPush(data);
  if (!code) {
    return null;
  }
  return claimAuthRequestCode(code) ? code : null;
}

/**
 * Route a tapped "Sign in with Oxy" push to the EXISTING approval screen.
 *
 * SECURITY: tapping can only OPEN `/approve` with the code. It never approves —
 * approval still requires the biometric gate plus the on-device identity
 * signature — and nothing from the payload is passed along or rendered: the
 * approval screen re-resolves the requesting application server-side from the
 * code alone. A payload that is not a valid Commons auth request is dropped
 * silently and navigates nowhere.
 *
 * @param enabled - Gate the subscription on the router being ready to accept
 *   the navigation. While the root Stack is still resolving its `(auth)` /
 *   `(tabs)` decision it bounces `/approve`, which would silently swallow the
 *   tap; the cold-launch replay in `app/_layout.tsx` owns that window instead.
 *   Passing the SAME resolved signal guarantees the cold-launch code has been
 *   claimed before this listener can act on a replayed launching tap.
 */
export function useAuthRequestNotifications(enabled: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void subscribeToNotificationResponses((data) => {
      const code = authRequestCodeFromPush(data);
      if (!code || !claimAuthRequestCode(code)) return;
      // ONLY the code travels to the route — no payload strings, ever.
      router.push({ pathname: '/approve', params: { code } });
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unsubscribe = off;
      })
      .catch((error: unknown) => {
        logger.warn('[commons] could not listen for auth-request pushes', LOG_CONTEXT, error);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, router]);
}
