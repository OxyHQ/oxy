import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { logger } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { ImportantBanner } from '@/components/ui/important-banner';
import { useDeviceBackupWarning } from '@/hooks/identity/useDeviceBackupWarning';
import { useNotificationOffer } from '@/hooks/notifications/useNotificationOffer';
import { useTranslation } from '@/lib/i18n';
import { registerVaultPushToken, vaultChannelCopy } from '@/lib/notifications/push-registration';

/**
 * The one-time "turn on notifications" offer on the ID tab, for an identity
 * that was never asked (it finished onboarding before the notifications step
 * existed). See `useNotificationOffer` for when it shows. It waits while the
 * device-backup prompt is on screen, so the ID tab never stacks two prompts.
 */
export function NotificationOffer() {
  const { t } = useTranslation();
  const { oxyServices, sessionClient } = useOxy();
  const { showOffer, turnOn, dismiss } = useNotificationOffer();
  const { showPrompt: backupPromptShowing } = useDeviceBackupWarning();
  const [busy, setBusy] = useState(false);

  const handleTurnOn = useCallback(async () => {
    setBusy(true);
    try {
      if ((await turnOn()) && oxyServices) {
        await registerVaultPushToken(
          oxyServices,
          vaultChannelCopy(t),
          sessionClient?.getState()?.deviceId,
        ).catch((error: unknown) => {
          logger.warn(
            '[commons] push token registration failed',
            { component: 'NotificationOffer' },
            error,
          );
        });
      }
    } finally {
      setBusy(false);
    }
  }, [oxyServices, sessionClient, t, turnOn]);

  if (!showOffer || backupPromptShowing) return null;

  return (
    <View testID="notification-offer">
      <ImportantBanner type="info" title={t('notificationOffer.title')}>
        {t('notificationOffer.body')}
      </ImportantBanner>
      <View style={styles.actions}>
        <Button
          appearance="solid"
          tone="accent"
          onPress={() => void handleTurnOn()}
          loading={busy}
          disabled={busy}
        >
          {t('notificationOffer.turnOn')}
        </Button>
        <Button appearance="subtle" onPress={() => void dismiss()} disabled={busy}>
          {t('notificationOffer.notNow')}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gutter: { gap: 12 },
  actions: { gap: 8 },
});
