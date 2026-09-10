import { useMemo } from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import type { SecurityActivity } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { formatEventDescription, getEventIcon, getSeverityColor } from '@/utils/security-utils';
import type { RecentActivityItem } from '@/components/recent-activity-section';
import type { HomeHandlers } from './useHomeHandlers';

/** Number of recent activity cards rendered in the home carousel. */
const MAX_HOME_ACTIVITY_CARDS = 3;

interface UseRecentActivityItemsArgs {
  securityActivities: SecurityActivity[];
  handleSecurity: HomeHandlers['handleSecurity'];
}

/**
 * Builds the recent-activity cards for the home screen carousel.
 *
 * When there are no security activities it returns a single placeholder card
 * (`id === 'no-activity'`); the screen keys its conditional rendering off that
 * sentinel id, so the behaviour is preserved exactly.
 *
 * Extracted verbatim from the screen's inline `useMemo`.
 */
export function useRecentActivityItems({
  securityActivities,
  handleSecurity,
}: UseRecentActivityItemsArgs): RecentActivityItem[] {
  const { mode } = useTheme();
  const colors = useColors();
  const { t } = useTranslation();
  const formatRelativeTime = useRelativeTime();

  return useMemo<RecentActivityItem[]>(() => {
    if (!securityActivities || securityActivities.length === 0) {
      // Show placeholder if no activities
      return [{
        id: 'no-activity',
        icon: 'shield-check-outline',
        iconColor: colors.sidebarIconSecurity,
        title: t('home.activity.noActivity'),
        subtitle: t('home.activity.noActivitySubtitle'),
        onPress: handleSecurity,
      }];
    }

    return securityActivities.slice(0, MAX_HOME_ACTIVITY_CARDS).map((activity: SecurityActivity) => {
      const eventIcon = getEventIcon(activity.eventType);
      const eventColor = getSeverityColor(activity.severity || 'low', mode);
      const description = formatEventDescription(activity);

      return {
        id: `activity-${activity.id}`,
        icon: eventIcon,
        iconColor: eventColor,
        title: description,
        subtitle: formatRelativeTime(activity.timestamp),
        onPress: handleSecurity,
      };
    });
  }, [securityActivities, colors.sidebarIconSecurity, mode, formatRelativeTime, handleSecurity, t]);
}
