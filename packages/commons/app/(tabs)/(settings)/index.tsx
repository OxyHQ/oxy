import React, { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Icons } from '@/constants/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useOxy } from '@oxy.so/services';
import {
  Screen,
  StackHeader,
} from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { DeviceBackupWarning } from '@/components/identity/DeviceBackupWarning';

/**
 * Settings tab — identity & vault management.
 *
 * Owns the key-management and account actions that used to live on the vault
 * home: backup & recovery, key rotation, trust & verification, manage account
 * (the SDK's in-app account surface), and delete account. Identity info (public
 * key, DID, self-custody details) lives on the ID tab, not here. The detail
 * screens are pushed within this tab's stack. Uses Bloom's grouped settings list.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { showBottomSheet } = useOxy();

  const handleBackupRecovery = useCallback(() => {
    router.push('/(tabs)/(settings)/backup-recovery');
  }, [router]);

  const handleRotateKey = useCallback(() => {
    router.push('/(tabs)/(settings)/rotate-key');
  }, [router]);

  const handlePersonhood = useCallback(() => {
    router.push('/(tabs)/(settings)/personhood');
  }, [router]);

  const handleCredentials = useCallback(() => {
    router.push('/(tabs)/(settings)/credentials');
  }, [router]);

  const handleNode = useCallback(() => {
    router.push('/(tabs)/(settings)/node');
  }, [router]);

  const handleDeleteAccount = useCallback(() => {
    router.push('/(tabs)/(settings)/delete-account');
  }, [router]);

  // 'ManageAccount' is the SDK's unified "Manage your Oxy Account" surface
  // (packages/services/src/ui/navigation/routes.ts) — the same sheet every other
  // Oxy app opens, so account management stays in-app instead of deep-linking out.
  const handleManageAccount = useCallback(() => {
    showBottomSheet?.('ManageAccount');
  }, [showBottomSheet]);

  return (
    // Bloom's SettingsListGroup owns its own 16pt horizontal gutter, so the
    // Screen column runs flush (no SCREEN_PADDING) — otherwise the cards would be
    // double-inset (22 + 16). Non-grouped content (the header) is padded to align
    // with Bloom's section titles.
    <Screen contentStyle={styles.flush} gap={16}>
      <View style={styles.header}>
        <StackHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      </View>

      {/* No device backup on this device (OxyHQ/oxy#1388): stays until the user
          confirms they saved the recovery phrase. */}
      <DeviceBackupWarning variant="settings" />

      {/* Key-management actions */}
      <SettingsListGroup title={t('vault.home.manageKeys')}>
        <SettingsListItem
          icon={<Icons.shield size='md' fill={colors.text} />}
          title={t('vault.home.actions.backupRecovery')}
          description={t('vault.home.actions.backupRecoverySubtitle')}
          onPress={handleBackupRecovery}
        />
        <SettingsListItem
          icon={<Icons.key size='md' fill={colors.text} />}
          title={t('rotateKey.settingsEntry')}
          description={t('rotateKey.settingsEntrySubtitle')}
          onPress={handleRotateKey}
        />
      </SettingsListGroup>

      {/* Trust & verification — Fase 3 personhood + Fase 4 credentials */}
      <SettingsListGroup title={t('civic.personhood.settingsSection')}>
        <SettingsListItem
          icon={<Icons.vouched size='md' fill={colors.text} />}
          title={t('civic.personhood.settingsEntry')}
          description={t('civic.personhood.settingsEntrySubtitle')}
          onPress={handlePersonhood}
        />
        <SettingsListItem
          icon={<Icons.credential size='md' fill={colors.text} />}
          title={t('civic.credentials.settingsEntry')}
          description={t('civic.credentials.settingsEntrySubtitle')}
          onPress={handleCredentials}
        />
        <SettingsListItem
          icon={<Icons.node size='md' fill={colors.text} />}
          title={t('civic.nodes.settingsEntry')}
          description={t('civic.nodes.settingsEntrySubtitle')}
          onPress={handleNode}
        />
      </SettingsListGroup>

      {/* Account management — opens the SDK's in-app account surface */}
      <SettingsListGroup title={t('vault.home.account')} footer={t('vault.home.accountSubtitle')}>
        <SettingsListItem
          icon={<Icons.settings size='md' fill={colors.text} />}
          title={t('vault.home.actions.manageAccount')}
          description={t('vault.home.actions.manageAccountSubtitle')}
          onPress={handleManageAccount}
        />
        <SettingsListItem
          icon={<Icons.delete size='md' fill={colors.error} />}
          title={t('vault.home.actions.deleteAccount')}
          description={t('vault.home.actions.deleteAccountSubtitle')}
          onPress={handleDeleteAccount}
          destructive
        />
      </SettingsListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flush: { paddingHorizontal: 0 },
  header: { paddingHorizontal: 20, marginBottom: 16 },
});
