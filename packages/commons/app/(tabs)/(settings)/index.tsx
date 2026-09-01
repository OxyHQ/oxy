import React, { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useOxy } from '@oxyhq/services';
import { Screen, StackHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';

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

      {/* Key-management actions */}
      <SettingsListGroup title={t('vault.home.manageKeys')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="shield-key" size={22} color={colors.text} />}
          title={t('vault.home.actions.backupRecovery')}
          description={t('vault.home.actions.backupRecoverySubtitle')}
          onPress={handleBackupRecovery}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="key-change" size={22} color={colors.text} />}
          title={t('rotateKey.settingsEntry')}
          description={t('rotateKey.settingsEntrySubtitle')}
          onPress={handleRotateKey}
        />
      </SettingsListGroup>

      {/* Trust & verification — Fase 3 personhood + Fase 4 credentials */}
      <SettingsListGroup title={t('civic.personhood.settingsSection')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="account-check" size={22} color={colors.text} />}
          title={t('civic.personhood.settingsEntry')}
          description={t('civic.personhood.settingsEntrySubtitle')}
          onPress={handlePersonhood}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="certificate" size={22} color={colors.text} />}
          title={t('civic.credentials.settingsEntry')}
          description={t('civic.credentials.settingsEntrySubtitle')}
          onPress={handleCredentials}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="server-network" size={22} color={colors.text} />}
          title={t('civic.nodes.settingsEntry')}
          description={t('civic.nodes.settingsEntrySubtitle')}
          onPress={handleNode}
        />
      </SettingsListGroup>

      {/* Account management — opens the SDK's in-app account surface */}
      <SettingsListGroup title={t('vault.home.account')} footer={t('vault.home.accountSubtitle')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="account-cog" size={22} color={colors.text} />}
          title={t('vault.home.actions.manageAccount')}
          description={t('vault.home.actions.manageAccountSubtitle')}
          onPress={handleManageAccount}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="delete-outline" size={22} color={colors.error} />}
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
