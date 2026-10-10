import { useMemo } from 'react';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { QuickAction } from '@/components/quick-actions-section';
import type { HomeHandlers } from './useHomeHandlers';

/**
 * Builds the horizontally-scrolling quick-action chips on the home screen
 * (personal info, security, devices, data, sharing, payments, storage,
 * third-party connections). Extracted verbatim from the screen's inline
 * `useMemo`.
 */
export function useQuickActions(handlers: HomeHandlers): QuickAction[] {
  const colors = useColors();
  const { t } = useTranslation();

  const {
    handlePersonalInfo,
    handleSecurity,
    handleDevices,
    handleDataPrivacy,
    handleSharing,
    handlePayments,
    handleStorage,
    handleFamily,
  } = handlers;

  return useMemo<QuickAction[]>(
    () => [
      {
        id: 'personal-info',
        icon: 'card-account-details-outline',
        iconColor: colors.sidebarIconPersonalInfo,
        title: t('home.quickActions.personalInfo'),
        onPress: handlePersonalInfo,
      },
      {
        id: 'security',
        icon: 'shield-check-outline',
        iconColor: colors.sidebarIconSecurity,
        title: t('home.quickActions.security'),
        onPress: handleSecurity,
      },
      {
        id: 'devices',
        icon: 'desktop-classic',
        iconColor: colors.sidebarIconDevices,
        title: t('home.quickActions.devices'),
        onPress: handleDevices,
      },
      {
        id: 'data',
        icon: 'toggle-switch-outline',
        iconColor: colors.sidebarIconData,
        title: t('home.quickActions.data'),
        onPress: handleDataPrivacy,
      },
      {
        id: 'sharing',
        icon: 'account-group-outline',
        iconColor: colors.sidebarIconSharing,
        title: t('home.quickActions.sharing'),
        onPress: handleSharing,
      },
      {
        id: 'payments',
        icon: 'wallet-outline',
        iconColor: colors.sidebarIconPayments,
        title: t('home.quickActions.payments'),
        onPress: handlePayments,
      },
      {
        id: 'storage',
        icon: 'cloud-outline',
        iconColor: colors.sidebarIconStorage,
        title: t('home.quickActions.storage'),
        onPress: handleStorage,
      },
      {
        id: 'family',
        icon: 'share-variant-outline',
        iconColor: colors.sidebarIconFamily,
        title: t('drawer.thirdParty'),
        onPress: handleFamily,
      },
    ],
    [
      colors.sidebarIconPersonalInfo,
      colors.sidebarIconSecurity,
      colors.sidebarIconDevices,
      colors.sidebarIconData,
      colors.sidebarIconSharing,
      colors.sidebarIconPayments,
      colors.sidebarIconStorage,
      colors.sidebarIconFamily,
      handlePersonalInfo,
      handleSecurity,
      handleDevices,
      handleDataPrivacy,
      handleSharing,
      handlePayments,
      handleStorage,
      handleFamily,
      t,
    ],
  );
}
