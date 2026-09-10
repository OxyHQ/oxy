import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { AccountCard, ScreenHeader, EmptyStateCard } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy } from '@oxy.so/services';
import { alert, toast } from '@oxy.so/bloom';
import type { ConnectedApp } from '@oxy.so/core';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';
import { ConnectedAppRow } from '@/components/connected-apps/connected-app-row';
import { useConnectedApps, useRevokeAppGrant } from '@/hooks/useConnectedApps';

/** True when the string is an absolute http(s) URL (vs. a bare Oxy file id). */
function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Third-party connections (the visible `family` drawer route, labelled
 * `drawer.thirdParty`): lists the third-party apps and services the user has
 * authorized against their Oxy account via the OAuth consent flow
 * (`oxyServices.listConnectedApps()` → `GET /auth/grants`) and lets them revoke
 * any grant. The data + revoke logic live in the shared {@link useConnectedApps}
 * / {@link useRevokeAppGrant} hooks so the security-screen summary reuses the
 * same cached query.
 */
export default function ThirdPartyConnectionsScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();

  // OxyServices integration — auth is enforced by the `(tabs)` layout, so a
  // session is guaranteed by the time this screen mounts.
  const { oxyServices } = useOxy();
  const { data, isLoading, isFetching, error, refetch } = useConnectedApps();
  const revoke = useRevokeAppGrant();
  const apps = data ?? [];

  const handlePressIn = useHapticPress();

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Resolve each app's logo once: a full URL is used as-is, a bare file id is
  // turned into a download URL via the canonical media chokepoint.
  const logoUris = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const app of apps) {
      if (!app.logoUrl) {
        map[app.applicationId] = undefined;
      } else if (isAbsoluteUrl(app.logoUrl)) {
        map[app.applicationId] = app.logoUrl;
      } else {
        map[app.applicationId] = oxyServices.getFileDownloadUrl(app.logoUrl, 'thumb');
      }
    }
    return map;
  }, [apps, oxyServices]);

  const handleRevoke = useCallback(
    (app: ConnectedApp) => {
      alert(
        t('connectedApps.revokeConfirmTitle', { name: app.name }),
        t('connectedApps.revokeConfirmMessage', { name: app.name }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('connectedApps.revokeConfirmAction'),
            style: 'destructive',
            onPress: () => {
              revoke.mutate(app.applicationId, {
                onSuccess: () => toast.success(t('connectedApps.revokeSuccess')),
                onError: (err: unknown) => {
                  const message = err instanceof Error ? err.message : t('connectedApps.revokeFailed');
                  toast.error(message);
                },
              });
            },
          },
        ],
      );
    },
    [revoke, t],
  );

  const renderList = () => {
    if (apps.length === 0) {
      return (
        <EmptyStateCard
          icon="apps"
          title={t('family.emptyTitle')}
          subtitle={t('family.emptySubtitle')}
        />
      );
    }

    return (
      <AccountCard>
        {apps.map((app, index) => (
          <ConnectedAppRow
            key={app.applicationId}
            app={app}
            logoUri={logoUris[app.applicationId]}
            isFirst={index === 0}
            hasDivider={index > 0}
            isRevoking={revoke.isPending && revoke.variables === app.applicationId}
            onRevoke={() => handleRevoke(app)}
          />
        ))}
      </AccountCard>
    );
  };

  // Loading state (initial fetch only — background refetches keep the list).
  if (isLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>
            {t('connectedApps.loading')}
          </ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  // Error state with a retry affordance.
  if (error) {
    const message = error instanceof Error ? error.message : t('connectedApps.loadFailed');
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.mobileContent}>
            <ScreenHeader title={t('family.title')} subtitle={t('family.subtitle')} />
            <View style={styles.errorContainer}>
              <ThemedText style={[styles.errorText, { color: colors.text }]}>{message}</ThemedText>
              <TouchableOpacity
                style={[styles.retryButton, { backgroundColor: colors.tint }]}
                onPressIn={handlePressIn}
                onPress={() => { void refetch(); }}
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
              >
                <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScreenContentWrapper>
    );
  }

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('family.title')} subtitle={t('family.subtitle')} />
        {renderList()}
      </>
    );
  }

  return (
    <ScreenContentWrapper refreshing={isFetching && !isLoading} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('family.title')} subtitle={t('family.subtitle')} />
          {renderList()}
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
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    opacity: 0.7,
  },
  retryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
