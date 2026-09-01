import React, { useMemo, useCallback } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, useUserDevices, useRemoveDevice } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import { formatDate } from '@/utils/date-utils';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useTranslation } from '@/lib/i18n';
import { getDeviceIcon, getDeviceDisplayName, type DeviceRecord } from '@/utils/device-utils';
import { useHapticPress } from '@/hooks/use-haptic-press';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

// 20% alpha suffix applied to the success token for the current-device icon
// badge background (e.g. `#10B981` -> `#10B98120`).
const ICON_BADGE_ALPHA = '20';

export default function DeviceDetailScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ deviceId: string }>();
  const { t } = useTranslation();

  const isDesktop = Platform.OS === 'web' && width >= 768;
  const deviceId = params.deviceId;

  // Devices come from the shared TanStack query (cached across the security and
  // devices-list screens). We select the requested device with a `useMemo`
  // `.find()` instead of an imperative `useEffect` that re-fetched the whole
  // list. Auth is enforced by the `(tabs)` layout.
  const { isLoading: oxyLoading } = useOxy();
  const { data: devicesData, isLoading: loading, error: queryError } = useUserDevices();
  const removeDevice = useRemoveDevice();

  const device = useMemo<DeviceRecord | null>(() => {
    if (!devicesData || !deviceId) return null;
    const devices = devicesData as DeviceRecord[];
    return (
      devices.find((d) => d.id === deviceId || d.deviceId === deviceId) ?? null
    );
  }, [devicesData, deviceId]);

  // Distinguish "the list failed to load" from "the list loaded but this id
  // isn't in it". Both render the same empty state, but the message differs.
  const error = useMemo(() => {
    if (queryError) {
      return queryError instanceof Error ? queryError.message : t('devices.detail.loadFailed');
    }
    if (!loading && !oxyLoading && !device) {
      return t('devices.detail.notFound');
    }
    return null;
  }, [queryError, loading, oxyLoading, device, t]);

  const handlePressIn = useHapticPress();
  const formatRelativeTime = useRelativeTime();

  // Handle device removal via the shared mutation (optimistic toast +
  // automatic device/session cache invalidation live in the hook).
  const handleRemoveDevice = useCallback(() => {
    if (!device) return;

    const deviceName = getDeviceDisplayName(device, t('common.unknown'));
    const isCurrent = Boolean(device.isCurrent);

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
              await removeDevice.mutateAsync(deviceId);
              // Navigate back to the devices list after a successful removal.
              router.back();
            } catch {
              // The mutation surfaces its own error toast; nothing to add here.
            }
          },
        },
      ]
    );
  }, [device, deviceId, removeDevice, router, t]);

  const actionLoading = removeDevice.isPending;

  // Device information items
  const deviceInfoItems = useMemo(() => {
    if (!device) return [];

    const deviceName = getDeviceDisplayName(device, t('common.unknown'));
    const deviceType = device.type || device.deviceType || 'unknown';
    const lastActive = device.lastActive || device.createdAt;
    const createdAt = device.createdAt;
    const isCurrent = Boolean(device.isCurrent);
    const badgeBackground = isCurrent
      ? colors.iconSuccess + ICON_BADGE_ALPHA
      : colors.sidebarIconDevices + ICON_BADGE_ALPHA;

    return [
      {
        id: 'name',
        icon: getDeviceIcon(deviceType),
        iconColor: isCurrent ? colors.success : colors.sidebarIconDevices,
        title: deviceName,
        subtitle: isCurrent ? t('devices.detail.currentDevice') : t('devices.detail.otherDevice'),
        customIcon: (
          <View style={[styles.deviceIconBadge, { backgroundColor: badgeBackground }]}>
            <MaterialCommunityIcons
              name={getDeviceIcon(deviceType)}
              size={24}
              color={isCurrent ? colors.success : colors.sidebarIconDevices}
            />
          </View>
        ),
      },
      {
        id: 'type',
        icon: 'devices',
        iconColor: colors.sidebarIconDevices,
        title: t('devices.detail.deviceType'),
        subtitle: deviceType.charAt(0).toUpperCase() + deviceType.slice(1),
      },
      {
        id: 'lastActive',
        icon: 'clock-outline',
        iconColor: colors.sidebarIconDevices,
        title: t('devices.detail.lastActive'),
        subtitle: formatRelativeTime(lastActive, t('common.unknown')),
      },
      ...(createdAt ? [{
        id: 'createdAt',
        icon: 'calendar-outline',
        iconColor: colors.sidebarIconDevices,
        title: t('devices.detail.firstSeen'),
        subtitle: formatDate(createdAt),
      }] : []),
    ];
  }, [device, colors, formatRelativeTime, t]);

  // Show loading state
  if (oxyLoading || loading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('devices.detail.loading')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  // Show error / not-found state
  if (error || !device) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.mobileContent}>
            <ScreenHeader title={t('devices.detail.title')} subtitle={t('devices.detail.subtitle')} />
            <AccountCard>
              <View style={styles.emptyStateContainer}>
                <MaterialCommunityIcons
                  name="alert-circle-outline"
                  size={40}
                  color={colors.text}
                  style={styles.emptyStateIcon}
                />
                <ThemedText style={[styles.emptyStateTitle, { color: colors.text }]}>
                  {error || t('devices.detail.notFound')}
                </ThemedText>
                <ThemedText style={[styles.emptyStateSubtitle, { color: colors.text }]}>
                  {t('devices.detail.notFoundSubtitle')}
                </ThemedText>
                <TouchableOpacity
                  style={[styles.backButton, { backgroundColor: colors.tint }]}
                  onPressIn={handlePressIn}
                  onPress={() => router.back()}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.back')}
                >
                  <Text style={styles.backButtonText}>{t('devices.detail.goBack')}</Text>
                </TouchableOpacity>
              </View>
            </AccountCard>
          </View>
        </View>
      </ScreenContentWrapper>
    );
  }

  const renderContent = () => {
    const isCurrent = Boolean(device?.isCurrent);

    return (
      <>
        <Section title={t('devices.detail.infoSection')}>
          <AccountCard>
            <GroupedSection items={deviceInfoItems} />
          </AccountCard>
        </Section>

        {!isCurrent && (
          <Section title={t('devices.detail.actionsSection')}>
            <ThemedText style={styles.sectionSubtitle}>
              {t('devices.detail.actionsSubtitle')}
            </ThemedText>
            <AccountCard>
              <GroupedSection items={[{
                id: 'remove-device',
                icon: 'delete-outline',
                iconColor: colors.error,
                title: t('devices.detail.removeAction'),
                subtitle: t('devices.detail.removeActionSubtitle'),
                onPress: handleRemoveDevice,
                showChevron: false,
                disabled: actionLoading,
                customContent: actionLoading ? (
                  <ActivityIndicator size="small" color={colors.error} />
                ) : undefined,
              }]} />
            </AccountCard>
          </Section>
        )}
      </>
    );
  };

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('devices.detail.title')} subtitle={t('devices.detail.subtitle')} />
        {renderContent()}
      </>
    );
  }

  return (
    <ScreenContentWrapper>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('devices.detail.title')} subtitle={t('devices.detail.subtitle')} />
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
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
  emptyStateContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  emptyStateIcon: {
    opacity: 0.4,
    marginBottom: 12,
  },
  emptyStateTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
    opacity: 0.8,
    textAlign: 'center',
  },
  emptyStateSubtitle: {
    fontSize: 13,
    opacity: 0.6,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  backButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginTop: 8,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
  },
  deviceIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
