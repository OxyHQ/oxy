import React, { useMemo, useCallback, useState } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, ActivityIndicator, Linking } from 'react-native';
import { File } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { logger } from '@oxyhq/core';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, ScreenHeader, Switch } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, usePrivacySettings, useUpdatePrivacySettings } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import { useTranslation } from '@/lib/i18n';
import { COMMONS_DELETE_ACCOUNT_URL } from '@/constants/oxy';

export default function DataScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const [isDownloading, setIsDownloading] = useState(false);
  const [pendingPrivacyKey, setPendingPrivacyKey] = useState<string | null>(null);
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();

  // OxyServices integration — auth is enforced by the `(tabs)` layout.
  const { user, isLoading: oxyLoading, oxyServices } = useOxy();
  const { data: privacySettings, isLoading: privacyLoading } = usePrivacySettings(user?.id, {
    enabled: !!user?.id,
  });
  const updatePrivacyMutation = useUpdatePrivacySettings();

  // Cast privacy settings to a record so we can access dynamic keys
  const settings = privacySettings as Record<string, unknown> | undefined;

  // Get privacy settings values (use defaults if not loaded yet)
  const dataSharing = (settings?.dataSharing as boolean | undefined) ?? true;
  const locationSharing = (settings?.locationSharing as boolean | undefined) ?? false;
  const analyticsSharing = (settings?.analyticsSharing as boolean | undefined) ?? true;
  const showActivity = (settings?.showActivity as boolean | undefined) ?? true;

  // Handle privacy setting updates
  const handlePrivacyUpdate = useCallback(async (key: string, value: boolean) => {
    if (!user?.id) return;

    setPendingPrivacyKey(key);
    try {
      await updatePrivacyMutation.mutateAsync({
        settings: { [key]: value },
        userId: user.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('data.privacy.updateFailed');
      toast.error(message);
    } finally {
      setPendingPrivacyKey((current) => (current === key ? null : current));
    }
  }, [user?.id, updatePrivacyMutation, t]);

  // Save a downloaded blob to the user's device. Web uses an anchor download;
  // native writes to the cache directory and opens the OS share sheet so the
  // user can save it to Files, send via email, etc.
  const saveBlob = useCallback(async (blob: Blob, filename: string, mimeType: string) => {
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    // Native: convert blob → Uint8Array → write to cache → open share sheet
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
    if (!cacheDir) {
      throw new Error(t('data.download.noCacheDir'));
    }
    const fileUri = `${cacheDir}${filename}`;
    const file = new File(fileUri);
    await file.write(bytes);

    if (!(await Sharing.isAvailableAsync())) {
      throw new Error(t('data.download.noSharing'));
    }
    await Sharing.shareAsync(fileUri, {
      mimeType,
      dialogTitle: t('data.download.saveTitle'),
    });
  }, [t]);

  const downloadFormat = useCallback(async (format: 'json' | 'csv') => {
    if (!oxyServices) return;
    setIsDownloading(true);
    try {
      const blob = await oxyServices.downloadAccountData(format);
      const filename = `account-data-${Date.now()}.${format}`;
      const mimeType = format === 'json' ? 'application/json' : 'text/csv';
      await saveBlob(blob, filename, mimeType);
      toast.success(t('data.download.successMessage'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('data.download.failedDefault');
      toast.error(message);
    } finally {
      setIsDownloading(false);
    }
  }, [oxyServices, saveBlob, t]);

  const handleDownloadData = useCallback(() => {
    alert(
      t('data.download.promptTitle'),
      t('data.download.promptMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: 'JSON', onPress: () => downloadFormat('json') },
        { text: 'CSV', onPress: () => downloadFormat('csv') },
      ]
    );
  }, [downloadFormat, t]);

  // Handle delete account — deletion is key-gated (the API verifies a signature
  // over the user's private key), and that key lives in the Commons app, never
  // in this management-only app. Hand off to Commons via its deep link.
  const handleDeleteAccount = useCallback(() => {
    alert(
      t('data.deleteAccount.title'),
      t('data.deleteAccount.commonsMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('data.deleteAccount.openCommons'),
          style: 'destructive',
          onPress: () => {
            Linking.openURL(COMMONS_DELETE_ACCOUNT_URL).catch((error) => {
              logger.error(
                'DataScreen: failed to open Commons delete-account deep link',
                error instanceof Error ? error : new Error(String(error)),
                { component: 'DataScreen' },
              );
              toast.error(t('data.deleteAccount.commonsUnavailable'));
            });
          },
        },
      ],
    );
  }, [t]);

  // Data download section
  const dataDownloadItems = useMemo(() => [
    {
      id: 'download',
      icon: 'download-outline',
      iconColor: colors.sidebarIconData,
      title: t('data.download.title'),
      subtitle: t('data.download.subtitle'),
      onPress: handleDownloadData,
      showChevron: true,
    },
  ], [colors, handleDownloadData, t]);

  // Privacy controls section
  const privacyControlItems = useMemo(() => [
    {
      id: 'data-sharing',
      icon: 'share-variant-outline',
      iconColor: colors.sidebarIconData,
      title: t('data.privacy.dataSharing'),
      subtitle: t('data.privacy.dataSharingSubtitle'),
      customContent: (
        <Switch
          value={dataSharing}
          onValueChange={(value) => handlePrivacyUpdate('dataSharing', value)}
          disabled={pendingPrivacyKey === 'dataSharing'}
        />
      ),
    },
    {
      id: 'location-sharing',
      icon: 'map-marker-outline',
      iconColor: colors.sidebarIconData,
      title: t('data.privacy.locationSharing'),
      subtitle: t('data.privacy.locationSharingSubtitle'),
      customContent: (
        <Switch
          value={locationSharing}
          onValueChange={(value) => handlePrivacyUpdate('locationSharing', value)}
          disabled={pendingPrivacyKey === 'locationSharing'}
        />
      ),
    },
    {
      id: 'analytics-sharing',
      icon: 'chart-line-variant',
      iconColor: colors.sidebarIconData,
      title: t('data.privacy.analytics'),
      subtitle: t('data.privacy.analyticsSubtitle'),
      customContent: (
        <Switch
          value={analyticsSharing}
          onValueChange={(value) => handlePrivacyUpdate('analyticsSharing', value)}
          disabled={pendingPrivacyKey === 'analyticsSharing'}
        />
      ),
    },
    {
      id: 'show-activity',
      icon: 'eye-outline',
      iconColor: colors.sidebarIconData,
      title: t('data.privacy.showActivity'),
      subtitle: t('data.privacy.showActivitySubtitle'),
      customContent: (
        <Switch
          value={showActivity}
          onValueChange={(value) => handlePrivacyUpdate('showActivity', value)}
          disabled={pendingPrivacyKey === 'showActivity'}
        />
      ),
    },
  ], [colors, dataSharing, locationSharing, analyticsSharing, showActivity, handlePrivacyUpdate, pendingPrivacyKey, t]);

  // Account management section
  const accountManagementItems = useMemo(() => [
    {
      id: 'delete-account',
      icon: 'delete-outline',
      iconColor: colors.error,
      title: t('data.deleteAccount.title'),
      subtitle: t('data.deleteAccount.subtitle'),
      onPress: handleDeleteAccount,
      showChevron: false,
    },
  ], [colors.error, handleDeleteAccount, t]);


  // Show loading state
  if (oxyLoading || privacyLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('data.loading')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  const renderContent = () => (
    <>
      <Section title={t('data.sections.download')}>
        <ThemedText style={styles.sectionSubtitle}>{t('data.sections.downloadSubtitle')}</ThemedText>
        <AccountCard>
          <GroupedSection items={dataDownloadItems} />
        </AccountCard>
      </Section>

      <Section title={t('data.sections.privacy')}>
        <ThemedText style={styles.sectionSubtitle}>{t('data.sections.privacySubtitle')}</ThemedText>
        <AccountCard>
          <GroupedSection items={privacyControlItems} />
        </AccountCard>
      </Section>

      <Section title={t('data.sections.account')}>
        <ThemedText style={styles.sectionSubtitle}>{t('data.sections.accountSubtitle')}</ThemedText>
        <AccountCard>
          <GroupedSection items={accountManagementItems} />
        </AccountCard>
      </Section>
    </>
  );

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('data.title')} subtitle={t('data.subtitle')} />
        {renderContent()}
      </>
    );
  }

  return (
    <ScreenContentWrapper>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('data.title')} subtitle={t('data.subtitle')} />
          {renderContent()}
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
  },
});
