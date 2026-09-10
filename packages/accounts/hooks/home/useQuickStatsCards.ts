import { useMemo } from 'react';
import type { ClientSession } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { AccountInfoCard } from '@/components/account-info-grid';
import type { HomeHandlers } from './useHomeHandlers';

interface UseQuickStatsCardsArgs {
  deviceCount: number;
  sessions: ClientSession[] | undefined;
  username: string | undefined;
  handleDevices: HomeHandlers['handleDevices'];
  handleSecurity: HomeHandlers['handleSecurity'];
  handlePersonalInfo: HomeHandlers['handlePersonalInfo'];
  handleSetUsername: HomeHandlers['handleSetUsername'];
}

/**
 * Builds the at-a-glance stats grid on the home screen (active devices, active
 * sessions, username status). The active-session count mirrors the security
 * screen's definition (a session counts unless explicitly flagged
 * non-current). Extracted verbatim from the screen's inline `useMemo`.
 */
export function useQuickStatsCards({
  deviceCount,
  sessions,
  username,
  handleDevices,
  handleSecurity,
  handlePersonalInfo,
  handleSetUsername,
}: UseQuickStatsCardsArgs): AccountInfoCard[] {
  const colors = useColors();
  const { t } = useTranslation();

  return useMemo<AccountInfoCard[]>(() => {
    // Mirror the security screen's "active session" definition (a session is
    // counted unless it is explicitly flagged non-current).
    const sessionCount = sessions?.filter((s: ClientSession) => s.isCurrent !== false).length || 0;
    return [
      {
        id: 'devices-count',
        icon: 'devices',
        iconColor: colors.sidebarIconDevices,
        title: t('home.stats.activeDevices'),
        value: t('home.stats.activeDevicesValue', { count: deviceCount }),
        onPress: handleDevices,
      },
      {
        id: 'sessions-count',
        icon: 'account-multiple-outline',
        iconColor: colors.sidebarIconSecurity,
        title: t('home.stats.activeSessions'),
        value: t('home.stats.activeSessionsValue', { count: sessionCount }),
        onPress: handleSecurity,
      },
      {
        id: 'username-status',
        icon: 'account-check-outline',
        iconColor: colors.sidebarIconPersonalInfo,
        title: t('home.stats.username'),
        value: username ? `@${username}` : t('common.notSet'),
        onPress: username ? handlePersonalInfo : handleSetUsername,
      },
    ];
  }, [deviceCount, sessions, username, colors.sidebarIconDevices, colors.sidebarIconSecurity, colors.sidebarIconPersonalInfo, handleDevices, handleSecurity, handlePersonalInfo, handleSetUsername, t]);
}
