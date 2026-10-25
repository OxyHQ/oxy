import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useOxy } from '@oxy.so/services';
import { logger } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';
import { registerVaultPushToken, vaultChannelCopy } from '@/lib/notifications/push-registration';

const LOG_CONTEXT = { component: 'usePushRegistration' } as const;

/**
 * Keeps this installation reachable by the platform for the signed-in vault
 * identity (issue #691, Phase 4).
 *
 * Mounted ONCE, at the root, inside `OxyProvider`. It is deliberately a
 * side-effect-only hook: there is no derived state a screen could read, and
 * nothing here belongs on the render path.
 *
 * ── Preconditions (both are hard, not hints) ───────────────────────────────
 *   - A SESSION: `registerPushToken` is bearer-authed, so we wait for
 *     `canUsePrivateApi` (the SDK's own "a usable bearer is planted" verdict)
 *     rather than racing the device-first cold boot with a doomed 401.
 *   - PERMISSION: checked, never requested. Onboarding owns the system prompt
 *     (`useAuthHandlers`), which registers immediately on a fresh grant; this
 *     hook covers every subsequent cold boot without re-asking.
 *
 * ── Re-read on foreground ──────────────────────────────────────────────────
 * Until it has registered for the signed-in identity, the hook tries again
 * every time the app comes back to the foreground. A permission turned on later
 * in the system settings (or the offer on the ID tab) is picked up the moment
 * the person returns to Commons, not at the next cold start. Once registered it
 * stops: registration is idempotent server-side, but there is nothing to redo.
 *
 * ── Retirement is NOT done here, on purpose ────────────────────────────────
 * `DELETE /notifications/push-token` is scoped to the identity holding the
 * bearer, so a token can only be retired WHILE its own session is alive. By the
 * time this hook could observe a sign-out or an identity swap, that bearer is
 * already gone and the call would delete the wrong row (or nothing). Retirement
 * therefore lives at the one place Commons deliberately gives up a vault
 * identity — the account-deletion sequence, which retires as its FIRST step
 * (`runAccountDeletion`). See `retireInstallationPushToken`.
 */
export function usePushRegistration(): void {
  const { canUsePrivateApi, user, oxyServices, sessionClient } = useOxy();
  const { t } = useTranslation();
  const userId = user?.id ?? null;

  /**
   * The identity this installation is REGISTERED for (or for which this
   * platform has no push at all), so a re-render, a `canUsePrivateApi` flicker
   * across a token refresh or a foreground never turns registration into a
   * request loop. Any other outcome leaves it unset, and the next foreground
   * tries again.
   */
  const settledForRef = useRef<string | null>(null);
  /** One attempt at a time: a foreground during an attempt does not start another. */
  const inFlightRef = useRef(false);

  const attempt = useCallback(() => {
    if (!canUsePrivateApi || !userId) return;
    if (settledForRef.current === userId || inFlightRef.current) return;
    inFlightRef.current = true;

    void (async () => {
      try {
        const outcome = await registerVaultPushToken(
          oxyServices,
          vaultChannelCopy(t),
          sessionClient?.getState()?.deviceId,
        );
        if (outcome.status === 'registered' || outcome.reason === 'unsupported-platform') {
          settledForRef.current = userId;
        } else {
          // An expected steady state (permission not granted yet, no EAS project
          // id in this build): diagnostic, not operational. Retried on the next
          // foreground.
          logger.debug('[commons] push registration skipped', {
            ...LOG_CONTEXT,
            reason: outcome.reason,
          });
        }
      } catch (error) {
        // Best-effort by design: a vault that cannot be woken by push still
        // approves sign-ins by QR. Retried on the next foreground.
        logger.warn('[commons] push token registration failed', LOG_CONTEXT, error);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [canUsePrivateApi, userId, oxyServices, sessionClient, t]);

  useEffect(() => {
    attempt();
  }, [attempt]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') attempt();
    });
    return () => subscription.remove();
  }, [attempt]);
}
