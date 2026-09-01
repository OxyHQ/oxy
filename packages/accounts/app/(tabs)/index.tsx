import React, { useMemo, useCallback, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, useUserDevices, useRecentSecurityActivity, useCurrentUser } from '@oxyhq/services';
import { formatDate } from '@/utils/date-utils';
import { getAccountDisplayName, getNormalizedUserHandle } from '@oxyhq/core';
import { useAvatarUrl } from '@/hooks/useAvatarUrl';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useBiometricSettings } from '@/hooks/useBiometricSettings';
import { QuickActionsSection } from '@/components/quick-actions-section';
import { AccountInfoGrid } from '@/components/account-info-grid';
import { RecentActivitySection } from '@/components/recent-activity-section';
import { HomeHeader } from '@/components/home/home-header';
import { HomeBottomActions } from '@/components/home/home-bottom-actions';
import { useTranslation } from '@/lib/i18n';
import { useHomeHandlers } from '@/hooks/home/useHomeHandlers';
import { useHomeRecommendations } from '@/hooks/home/useHomeRecommendations';
import { useQuickActions } from '@/hooks/home/useQuickActions';
import { useAccountCards } from '@/hooks/home/useAccountCards';
import { useRecentActivityItems } from '@/hooks/home/useRecentActivityItems';
import { useQuickStatsCards } from '@/hooks/home/useQuickStatsCards';
import { useSecurityOverviewItems } from '@/hooks/home/useSecurityOverviewItems';
import { useManagedAccountItems } from '@/hooks/home/useManagedAccountItems';

export default function HomeScreen() {
  const colors = useColors();
  const [refreshing, setRefreshing] = useState(false);
  const { t } = useTranslation();

  // OxyServices integration — auth is enforced by the `(tabs)` layout.
  // `user` is the account the app is currently signed in as. Switching accounts
  // is a real session switch, so `user` already reflects the switched-into
  // account — identity display (name / avatar / profile fields) and the login
  // security surfaces all read from `user`.
  const { user, isLoading: oxyLoading, refreshSessions, sessions, accounts } = useOxy();
  // Hydrate the user record from the server (createdAt + any fields that were
  // missing from a cached signIn response). useCurrentUser handles staleness
  // via TanStack Query and re-fetches on mount / staleTime expiry, then
  // OxyContext picks up the fresh record from the same cache key.
  useCurrentUser();

  // Fetch devices for stats
  const { data: devicesData } = useUserDevices();
  const devices = (devicesData ?? []) as { id: string }[];

  // Fetch security activity
  const { data: securityActivities = [] } = useRecentSecurityActivity(5);

  // Biometric settings
  const {
    enabled: biometricEnabled,
    canEnable: canEnableBiometric,
    hasHardware: hasBiometricHardware,
    isLoading: biometricLoading,
  } = useBiometricSettings();

  // Compute current-account identity data (the account signed in as).
  const displayName = useMemo(
    () => user?.name?.displayName ?? getNormalizedUserHandle(user) ?? getAccountDisplayName(null),
    [user],
  );
  const accountCreatedDate = useMemo(() => formatDate(user?.createdAt), [user?.createdAt]);
  const avatarUrl = useAvatarUrl(user);

  const handlePressIn = useHapticPress();

  const handlers = useHomeHandlers();
  const {
    handleAvatarPress,
    handleDevices,
    handleMenu,
    handleSearch,
  } = handlers;

  const handleReload = useCallback(async () => {
    if (!refreshSessions) return;
    try {
      await refreshSessions();
    } catch (error) {
      console.error('Failed to refresh sessions', error);
    }
  }, [refreshSessions]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (refreshSessions) {
        await refreshSessions();
      }
    } catch (error) {
      console.error('Failed to refresh', error);
    } finally {
      setRefreshing(false);
    }
  }, [refreshSessions]);

  // Section item builders — each owns its own memoization.
  const recommendations = useHomeRecommendations({
    username: user?.username,
    handleSetUsername: handlers.handleSetUsername,
  });
  const quickActions = useQuickActions(handlers);
  const accountCards = useAccountCards({
    displayName,
    accountCreatedDate,
    handleEditName: handlers.handleEditName,
  });
  const recentActivityItems = useRecentActivityItems({
    securityActivities,
    handleSecurity: handlers.handleSecurity,
  });
  const quickStatsCards = useQuickStatsCards({
    deviceCount: devices.length,
    sessions,
    username: user?.username,
    handleDevices: handlers.handleDevices,
    handleSecurity: handlers.handleSecurity,
    handlePersonalInfo: handlers.handlePersonalInfo,
    handleSetUsername: handlers.handleSetUsername,
  });
  const securityOverviewItems = useSecurityOverviewItems({
    biometricEnabled,
    canEnableBiometric,
    hasBiometricHardware,
    biometricLoading,
    userEmail: user?.email,
    handleSecurity: handlers.handleSecurity,
  });
  const managedAccountItems = useManagedAccountItems({
    accounts,
    currentAccountId: user?.id ?? null,
    handleManagedAccounts: handlers.handleManagedAccounts,
    handleCreateManagedAccount: handlers.handleCreateManagedAccount,
  });

  const content = useMemo(() => (
    <>
      {/* Recommendations Section */}
      {recommendations.length > 0 && (
        <Section title={t('home.sections.recommendations')} isFirst>
          <AccountCard>
            <GroupedSection items={recommendations} />
          </AccountCard>
        </Section>
      )}

      {/* Quick Actions - Horizontal Scroll */}
      <Section title={t('home.sections.quickActions')} isFirst={recommendations.length === 0}>
        <QuickActionsSection actions={quickActions} onPressIn={handlePressIn} />
      </Section>

      {/* Account Info - Grid Layout */}
      <Section title={t('home.sections.accountInfo')}>
        <AccountInfoGrid cards={accountCards} onPressIn={handlePressIn} />
      </Section>

      {/* Recent Activity - Horizontal Scroll */}
      {recentActivityItems.length > 0 && recentActivityItems[0].id !== 'no-activity' && (
        <Section title={t('home.sections.recentActivity')}>
          <RecentActivitySection items={recentActivityItems} onPressIn={handlePressIn} />
        </Section>
      )}

      {/* Quick Stats - Grid Layout */}
      <Section title={t('home.sections.overview')}>
        <AccountInfoGrid cards={quickStatsCards} onPressIn={handlePressIn} />
      </Section>

      {/* Managed Accounts Section */}
      <Section title={t('home.sections.yourIdentities')}>
        <ThemedText style={styles.subtitle}>{t('home.sections.yourIdentitiesSubtitle')}</ThemedText>
        <AccountCard>
          <GroupedSection items={managedAccountItems} />
        </AccountCard>
      </Section>

      {/* Security Overview - Card Layout */}
      {securityOverviewItems.length > 0 && (
        <Section title={t('home.sections.security')}>
          <AccountCard>
            <GroupedSection items={securityOverviewItems} />
          </AccountCard>
        </Section>
      )}
    </>
  ), [quickActions, accountCards, recentActivityItems, quickStatsCards, securityOverviewItems, managedAccountItems, handlePressIn, recommendations, t]);

  // Show loading state while OxyServices is initializing. Auth itself is
  // enforced by the `(tabs)` layout — by the time this screen mounts the
  // user is signed in, so no unauthenticated branch is needed.
  if (oxyLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('common.loadingShort')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  return (
    <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.content}>
          <HomeHeader
            displayName={displayName}
            avatarUrl={avatarUrl}
            onAvatarPress={handleAvatarPress}
            onSearch={handleSearch}
            onPressIn={handlePressIn}
          />
          {content}
          <HomeBottomActions
            onReload={handleReload}
            onDevices={handleDevices}
            onMenu={handleMenu}
          />
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  } as const,
  content: {
    padding: 16,
  } as const,
  subtitle: {
    fontSize: 14,
    opacity: 0.7,
    marginBottom: 12,
  } as const,
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  } as const,
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  } as const,
});
