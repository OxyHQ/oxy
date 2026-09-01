import { useEffect, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { logger } from '@oxyhq/core';
import { useTranslation } from '@/lib/i18n';
import { registerVaultPushToken } from '@/lib/notifications/push-registration';

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
 *   - PERMISSION: checked, never requested. Onboarding owns the single system
 *     prompt (`useAuthHandlers`), which registers immediately on a fresh grant;
 *     this hook covers every subsequent cold boot without re-asking.
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
   * The identity this hook has already attempted a registration for, so a
   * re-render (or a `canUsePrivateApi` flicker across a token refresh) cannot
   * turn a one-shot registration into a request loop. Reset on failure so a
   * later dependency change may retry.
   */
  const attemptedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canUsePrivateApi || !userId) return;
    if (attemptedForRef.current === userId) return;
    attemptedForRef.current = userId;

    void (async () => {
      try {
        const outcome = await registerVaultPushToken(
          oxyServices,
          { name: t('signInApproval.channel.name'), description: t('signInApproval.channel.description') },
          sessionClient?.getState()?.deviceId,
        );
        if (outcome.status === 'skipped') {
          // An expected steady state (permission declined, no EAS project id,
          // an unsupported platform) — diagnostic, not operational.
          logger.debug('[commons] push registration skipped', {
            ...LOG_CONTEXT,
            reason: outcome.reason,
          });
        }
      } catch (error) {
        // Best-effort by design: a vault that cannot be woken by push still
        // approves sign-ins by QR. Clear the marker so a later session/device
        // change can retry.
        attemptedForRef.current = null;
        logger.warn('[commons] push token registration failed', LOG_CONTEXT, error);
      }
    })();
  }, [canUsePrivateApi, userId, oxyServices, sessionClient, t]);
}
