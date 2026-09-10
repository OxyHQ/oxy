import React, { useCallback } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ScreenHeader, LinkButton } from '@/components/ui';
import { Section } from '@/components/section';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { OverviewSection } from '@/components/storage/overview-section';
import { AccountInfoSection } from '@/components/storage/account-info-section';
import { CategoriesSection } from '@/components/storage/categories-section';
import { useStorageDetails } from '@/hooks/storage/useStorageDetails';
import { useOxy, useAccountStorageUsage } from '@oxy.so/services';
import { useTranslation } from '@/lib/i18n';

export default function StorageScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();

  // Auth is enforced by the `(tabs)` layout — assume a session here.
  // Storage usage is served by a TanStack query (caching, background refetch,
  // pull-to-refresh via `refetch`) instead of hand-rolled `useEffect` fetches.
  const { isLoading: oxyLoading } = useOxy();
  const {
    data: usage = null,
    isLoading: loading,
    isFetching,
    error: queryError,
    refetch,
  } = useAccountStorageUsage();
  const error = queryError
    ? (queryError instanceof Error ? queryError.message : t('storage.loadFailed'))
    : null;

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const { usagePercentage, usageSummaryText, segments, storageDetails, accountInfoItems } =
    useStorageDetails(usage);

  const content = (
    <>
      <ScreenHeader title={t('storage.title')} subtitle={t('storage.subtitle')} />

      <OverviewSection
        loading={loading || oxyLoading}
        hasUsage={!!usage}
        error={error}
        usageSummaryText={usageSummaryText}
        usagePercentage={usagePercentage}
        segments={segments}
        onRetry={() => { void refetch(); }}
      />

      {usage && (
        <>
          <AccountInfoSection items={accountInfoItems} />

          <CategoriesSection items={storageDetails} />

          <Section>
            <View style={{ marginTop: -8 }}>
              <LinkButton text={t('storage.cleanUp')} onPress={() => router.push('/(tabs)/data')} />
            </View>
          </Section>
        </>
      )}
    </>
  );

  if (isDesktop) {
    return content;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenContentWrapper refreshing={isFetching && !loading} onRefresh={handleRefresh}>
        <View style={styles.mobileContent}>{content}</View>
      </ScreenContentWrapper>
    </View>
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
});
