import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';
import { alert } from '@oxy.so/bloom';
import type { SecurityActivity } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { formatDate } from '@/utils/date-utils';
import {
  getEventIcon,
  getSeverityColor,
  getEventSeverity,
  formatEventDescription,
} from '@/utils/security-utils';
import type { GroupedItem } from '@/components/sections/types';

/** Maximum number of recent activity rows rendered in the security card. */
const MAX_RECENT_ACTIVITY_ROWS = 5;
/** User-agent strings longer than this are truncated in the detail alert. */
const USER_AGENT_PREVIEW_LENGTH = 50;

interface UseSecurityActivityItemsArgs {
  securityActivities: SecurityActivity[];
}

/**
 * Builds the recent-activity `GroupedSection` rows for the security screen.
 * Each row opens a detail alert (type, severity, device, browser, time)
 * with an optional "view device" navigation action for device/sign-in events.
 *
 * Extracted verbatim from the security screen's inline `useMemo`.
 */
export function useSecurityActivityItems({
  securityActivities,
}: UseSecurityActivityItemsArgs): GroupedItem[] {
  const { mode } = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const formatRelativeTime = useRelativeTime();

  return useMemo(() => {
    if (!securityActivities || securityActivities.length === 0) return [];

    return securityActivities.slice(0, MAX_RECENT_ACTIVITY_ROWS).map((activity: SecurityActivity) => {
      const eventIcon = getEventIcon(activity.eventType);
      // Use severity-based color for better consistency
      const severity = activity.severity || getEventSeverity(activity.eventType);
      const eventColor = getSeverityColor(severity, mode);
      const description = formatEventDescription(activity);
      const deviceId = activity.deviceId;

      // Show details on press - include device info, etc.
      const onPress = () => {
        const details = [
          `${t('security.activity.detailType')}: ${activity.eventType}`,
          `${t('security.activity.detailSeverity')}: ${severity}`,
          activity.deviceId && activity.metadata?.deviceName
            ? `${t('security.activity.detailDevice')}: ${activity.metadata.deviceName}`
            : activity.deviceId
              ? `${t('security.activity.detailDeviceId')}: ${activity.deviceId}`
              : null,
          activity.userAgent ? `${t('security.activity.detailBrowser')}: ${activity.userAgent.substring(0, USER_AGENT_PREVIEW_LENGTH)}${activity.userAgent.length > USER_AGENT_PREVIEW_LENGTH ? '...' : ''}` : null,
          `${t('security.activity.detailTime')}: ${formatDate(activity.timestamp)}`,
        ].filter(Boolean).join('\n');

        alert(
          description,
          details,
          [
            // Add navigation to device if available
            ...(deviceId && (activity.eventType === 'device_added' || activity.eventType === 'device_removed' || activity.eventType === 'sign_in')
              ? [{
                  text: t('security.activity.viewDevice'),
                  onPress: () => router.push({ pathname: '/(tabs)/devices/[deviceId]', params: { deviceId } }),
                }]
              : []),
            { text: t('common.ok'), style: 'default' as const },
          ]
        );
      };

      return {
        id: `activity-${activity.id}`,
        icon: eventIcon,
        iconColor: eventColor,
        title: description,
        subtitle: formatRelativeTime(activity.timestamp),
        onPress,
        showChevron: true, // Always show chevron since we show details
      };
    });
  }, [securityActivities, mode, formatRelativeTime, router, t]);
}
