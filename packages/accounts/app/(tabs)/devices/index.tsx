import React, { useMemo, useCallback, useState } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, ScreenHeader, EmptyStateCard } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, useUserDevices } from '@oxy.so/services';
import { alert, toast } from '@oxy.so/bloom';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';
import { getDeviceIcon, getDeviceDisplayName, type DeviceRecord } from '@/utils/device-utils';

export default function DevicesScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const { t } = useTranslation();

  // colors already from useColors() above
  const isDesktop = Platform.OS === 'web' && width >= 768;

  // OxyServices integration — auth is enforced by the `(tabs)` layout.
  const { oxyServices, isLoading: oxyLoading } = useOxy();
  const {
    data: devicesData,
    isLoading: loading,
    isFetching,
    error: queryError,
    refetch,
  } = useUserDevices();
  const devices = (devicesData ?? []) as DeviceRecord[];
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const handlePressIn = useHapticPress();
  const formatRelativeTime = useRelativeTime();

  // Handle device removal
  const handleRemoveDevice = useCallback(async (deviceId: string, deviceName: string, isCurrent: boolean) => {
    if (isCurrent) {
      toast.warning(t('devices.detail.removeCurrentWarning'));
      return;
    }

    alert(
      t('devices.detail.removeTitle'),
      t('devices.detail.removeMessage', { name: deviceName }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              setActionLoading(deviceId);
              await oxyServices?.removeDevice(deviceId);
              // Refresh devices list
              await refetch();
              // On native, surface a success toast (web's list refresh is its own confirmation).
              if (Platform.OS !== 'web') {
                toast.success(t('devices.remove.success'));
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : t('devices.remove.failed');
              toast.error(message);
            } finally {
              setActionLoading(null);
            }
          },
        },
      ]
    );
  }, [oxyServices, refetch, t]);

  // Transform devices for UI
  const deviceItems = useMemo(() => {
    if (!devices || devices.length === 0) return [];

    return devices.map((device: DeviceRecord) => {
      const deviceId = device.id || device.deviceId || '';
      const deviceName = getDeviceDisplayName(device, t('devices.unknownDevice'));
      const deviceType = device.type || device.deviceType || '';
      const lastActive = device.lastActive || device.createdAt;
      // Use isCurrent from API response (already identified by backend)
      const isCurrent = Boolean(device.isCurrent);
      const isLoading = actionLoading === deviceId;

      return {
        id: deviceId,
        icon: getDeviceIcon(deviceType),
        iconColor: isCurrent ? colors.tint : colors.sidebarIconDevices,
        title: deviceName,
        subtitle: isCurrent
          ? t('devices.item.thisDeviceLastActive', { time: formatRelativeTime(lastActive, t('common.unknown')) })
          : t('devices.item.lastActive', { time: formatRelativeTime(lastActive, t('common.unknown')) }),
        onPress: () => router.push({ pathname: '/(tabs)/devices/[deviceId]', params: { deviceId } }),
        showChevron: true,
        customContent: (
          <View style={styles.deviceActions}>
            {isCurrent ? (
              <View style={[styles.currentBadge, { backgroundColor: colors.tint }]}>
                <Text style={[styles.currentBadgeText, { color: '#FFFFFF' }]}>{t('devices.item.currentBadge')}</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.removeButton, { backgroundColor: colors.card }]}
                onPressIn={handlePressIn}
                onPress={() => handleRemoveDevice(deviceId, deviceName, isCurrent)}
                disabled={isLoading}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.removeDevice')}
                accessibilityState={{ disabled: isLoading }}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={[styles.buttonText, { color: colors.text }]}>{t('common.remove')}</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        ),
      };
    });
  }, [devices, colors, formatRelativeTime, actionLoading, handleRemoveDevice, handlePressIn, router, t]);

  // Show loading state
  if (oxyLoading || loading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('devices.loading')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  // Show error state
  if (error) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.mobileContent}>
            <ScreenHeader title={t('devices.title')} subtitle={t('devices.headerSubtitle')} />
            <View style={styles.errorContainer}>
              <ThemedText style={[styles.errorText, { color: colors.text }]}>
                {error}
              </ThemedText>
              <TouchableOpacity
                style={[styles.retryButton, { backgroundColor: colors.tint }]}
                onPressIn={handlePressIn}
                onPress={() => { void refetch(); }}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.retry')}
              >
                <Text style={[styles.retryButtonText, { color: '#FFFFFF' }]}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScreenContentWrapper>
    );
  }

  const emptyDevices = (
    <EmptyStateCard
      icon="devices"
      title={t('devices.empty.title')}
      subtitle={t('devices.empty.subtitle')}
    />
  );

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('devices.title')} subtitle={t('devices.headerSubtitle')} />
        {deviceItems.length === 0 ? (
          emptyDevices
        ) : (
          <AccountCard>
            <GroupedSection items={deviceItems} />
          </AccountCard>
        )}
      </>
    );
  }

  return (
    <ScreenContentWrapper refreshing={isFetching && !loading} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('devices.title')} subtitle={t('devices.headerSubtitle')} />
          {deviceItems.length === 0 ? (
            emptyDevices
          ) : (
            <AccountCard>
              <GroupedSection items={deviceItems} />
            </AccountCard>
          )}
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  desktopBody: {
    flex: 1,
    flexDirection: 'row',
  },
  desktopSidebar: {
    width: 260,
    padding: 20,
  },
  desktopHeader: {
    marginBottom: 24,
  },
  welcomeText: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 4,
  },
  welcomeSubtext: {
    fontSize: 13,
    opacity: 0.6,
  },
  menuContainer: {
    gap: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 26,
    gap: 12,
  },
  menuItemActive: {},
  menuIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '400',
  },
  desktopMain: {
    flex: 1,
    maxWidth: 720,
  },
  desktopMainContent: {
    padding: 32,
  },
  headerSection: {
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    opacity: 0.6,
  },
  accountCard: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
  mobileHeaderSection: {
    marginBottom: 20,
  },
  mobileTitle: {
    fontSize: 28,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    marginBottom: 6,
  },
  mobileSubtitle: {
    fontSize: 15,
    opacity: 0.6,
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
  deviceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  currentBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  currentBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  removeButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
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
  },
});