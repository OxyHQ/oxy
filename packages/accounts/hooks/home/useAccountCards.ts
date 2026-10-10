import { useMemo } from 'react';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { AccountInfoCard } from '@/components/account-info-grid';
import type { HomeHandlers } from './useHomeHandlers';

interface UseAccountCardsArgs {
  displayName: string;
  accountCreatedDate: string;
  handleEditName: HomeHandlers['handleEditName'];
}

/**
 * Builds the two-up account-info grid (full name + account-created date) on
 * the home screen. Extracted verbatim from the screen's inline `useMemo`.
 */
export function useAccountCards({
  displayName,
  accountCreatedDate,
  handleEditName,
}: UseAccountCardsArgs): AccountInfoCard[] {
  const colors = useColors();
  const { t } = useTranslation();

  return useMemo<AccountInfoCard[]>(
    () => [
      {
        id: 'name',
        icon: 'account-outline',
        iconColor: colors.sidebarIconPersonalInfo,
        title: t('home.accountInfo.fullName'),
        value: displayName,
        onPress: handleEditName,
      },
      {
        id: 'created',
        icon: 'calendar-outline',
        iconColor: colors.sidebarIconData,
        title: t('home.accountInfo.accountCreated'),
        value: accountCreatedDate || '—',
      },
    ],
    [
      colors.sidebarIconPersonalInfo,
      colors.sidebarIconData,
      displayName,
      accountCreatedDate,
      handleEditName,
      t,
    ],
  );
}
