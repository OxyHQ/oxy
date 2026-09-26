import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { ImportantBanner } from '@/components/ui/important-banner';
import { useDeviceBackupWarning } from '@/hooks/identity/useDeviceBackupWarning';
import { useTranslation } from '@/lib/i18n';

interface DeviceBackupWarningProps {
  /**
   * `prompt`: the one-time banner on the ID tab after onboarding; any action or
   * "Not now" retires it. `settings`: the Settings banner, which stays until the
   * user confirms they saved the recovery phrase.
   */
  variant: 'prompt' | 'settings';
}

/**
 * "This identity isn't backed up on this device" (OxyHQ/oxy#1388), on Android
 * devices where the Block Store device backup cannot exist (no Google Play
 * services, or a binary without the native module). Non-blocking: a banner in
 * the page, never a modal. Renders nothing everywhere else.
 *
 * Actions: reveal the recovery phrase to write it down, and set up the
 * phrase-keyed encrypted backup (the counterpart of "Restore from encrypted
 * backup"). An identity imported from a raw key has no phrase, so it is sent to
 * key rotation instead, the only way to get one.
 */
export function DeviceBackupWarning({ variant }: DeviceBackupWarningProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { showBanner, showPrompt, hasPhrase, markPrompted, acknowledge } = useDeviceBackupWarning();

  const visible = variant === 'prompt' ? showPrompt : showBanner;

  const go = useCallback(
    (href: '/(tabs)/(settings)/recovery-phrase' | '/(tabs)/(settings)/create-backup' | '/(tabs)/(settings)/rotate-key') => {
      if (variant === 'prompt') void markPrompted();
      router.push(href);
    },
    [markPrompted, router, variant],
  );

  if (!visible) return null;

  return (
    <View style={styles.gutter} testID={`device-backup-warning-${variant}`}>
      <ImportantBanner title={t('deviceBackupWarning.title')}>
        {hasPhrase ? t('deviceBackupWarning.body') : t('deviceBackupWarning.bodyNoPhrase')}
      </ImportantBanner>
      <View style={styles.actions}>
        {hasPhrase ? (
          <>
            <Button appearance="solid" tone="accent" onPress={() => go('/(tabs)/(settings)/recovery-phrase')}>
              {t('deviceBackupWarning.revealPhrase')}
            </Button>
            <Button appearance="outline" tone="neutral" onPress={() => go('/(tabs)/(settings)/create-backup')}>
              {t('deviceBackupWarning.encryptedBackup')}
            </Button>
          </>
        ) : (
          <Button appearance="solid" tone="accent" onPress={() => go('/(tabs)/(settings)/rotate-key')}>
            {t('deviceBackupWarning.rotate')}
          </Button>
        )}
        {variant === 'prompt' ? (
          <Button appearance="subtle" onPress={() => void markPrompted()}>
            {t('deviceBackupWarning.notNow')}
          </Button>
        ) : (
          <Button appearance="subtle" onPress={() => void acknowledge()}>
            {t('deviceBackupWarning.confirm')}
          </Button>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gutter: { paddingHorizontal: 20, gap: 12 },
  actions: { gap: 8 },
});
