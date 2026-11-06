import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { ImportantBanner } from '@/components/ui/important-banner';
import { useBackupOwed } from '@/hooks/identity/useBackupOwed';
import { useTranslation } from '@/lib/i18n';

/**
 * "Your encrypted backup needs to be created again" (round-5 review R5-9).
 * Shown while `oxy.identity.backup.isOwed()` — a key rotation deleted the old
 * backup and no new one was sealed — on the ID tab and in Settings, until the
 * person creates it. Not dismissible: the keys the old backup carried are on
 * this phone only until then. Renders nothing otherwise.
 */
export function BackupOwedBanner() {
  const router = useRouter();
  const { t } = useTranslation();
  const owed = useBackupOwed();
  if (!owed) return null;
  return (
    <View style={styles.block} testID="backup-owed-banner">
      <ImportantBanner title={t('backupOwed.title')}>{t('backupOwed.body')}</ImportantBanner>
      <Button
        appearance="solid"
        tone="accent"
        onPress={() => router.push('/(tabs)/(settings)/create-backup')}
      >
        {t('backupOwed.action')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
});
