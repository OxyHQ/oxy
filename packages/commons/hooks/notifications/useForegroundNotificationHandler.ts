import { useEffect } from 'react';
import { installForegroundNotificationHandler, type ForegroundPresentation } from '@oxyhq/services';
import { authRequestCodeFromPush } from '@/lib/notifications/auth-request-push';

/**
 * Make a "Sign in with Oxy" approval request VISIBLE while Commons is open
 * (issue #691, Phase 4).
 *
 * `expo-notifications` shows NOTHING while the app is foregrounded unless an
 * app-global handler says otherwise, so without this the one moment the user is
 * demonstrably holding their phone — looking at Commons — is the one moment a
 * "sign in on your laptop" request produces no visible signal at all.
 *
 * ── The rule, stated explicitly ────────────────────────────────────────────
 *   - SHOW an actionable Commons auth request. "Actionable" is deliberately the
 *     same verdict the tap path uses ({@link authRequestCodeFromPush}): a
 *     payload that is not ours, is malformed, or carries an already-stale link
 *     yields no code, so tapping it could not open anything — a banner for it
 *     would be a dead end.
 *   - SUPPRESS everything else, which is `expo-notifications`' own default for
 *     a foregrounded app. Commons has essentially one notification type today;
 *     stating the default this way means installing the handler changes the
 *     behaviour of exactly one payload shape, and any type added later stays
 *     silent-in-foreground until someone deliberately opts it in here.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * Presentation only. Nothing is approved, nothing is navigated, and nothing
 * from the (untrusted) payload is read for display or carried into the app —
 * the handler's entire output is a visibility verdict. Acting on the request
 * still requires a TAP (`useAuthRequestNotifications`), which only ever OPENS
 * the approval route with the authorize code; the approval screen then
 * re-resolves the requesting application server-side, and approving still
 * requires the biometric gate plus the on-device identity signature.
 *
 * What lives here is the POLICY — which payload earns a banner. The install
 * itself is the shared `@oxyhq/services` adapter, which owns the one-shot,
 * process-wide latch (`setNotificationHandler` is global, last-writer-wins
 * state) and the native-only guard. So this effect can stay a plain mount hook:
 * a remount hands the adapter the same decision again and the adapter no-ops,
 * and there is deliberately nothing to tear down on unmount.
 */
export function useForegroundNotificationHandler(): void {
  useEffect(() => {
    void installForegroundNotificationHandler((data): ForegroundPresentation =>
      authRequestCodeFromPush(data) === null ? 'suppress' : 'show',
    );
  }, []);
}
