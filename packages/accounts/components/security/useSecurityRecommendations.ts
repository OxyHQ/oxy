import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { alert } from '@oxy.so/bloom';
import type { ClientSession, SecurityActivity } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { PrioritizedGroupedItem } from '@/components/sections/types';
import {
  selectSecurityRecommendations,
  type SecurityRecommendationDescriptor,
} from '@/utils/security-recommendations';

interface UseSecurityRecommendationsArgs {
  canEnableBiometric: boolean;
  biometricEnabled: boolean;
  biometricLoading: boolean;
  userEmail: string | undefined;
  sessions: ClientSession[] | undefined;
  deviceCount: number;
  securityActivities: SecurityActivity[];
}

/**
 * Builds the prioritized list of actionable security recommendations shown at
 * the top of the security screen. Each recommendation is a `GroupedSection`
 * row; the list is ordered by ascending priority (lower = more urgent).
 *
 * The decision of *which* recommendations appear and *in what order* lives in
 * the pure `selectSecurityRecommendations` (utils/security-recommendations);
 * this hook maps each descriptor to its rendered row (icon, color, copy, and
 * tap action). Behaviour is identical to the screen's original inline `useMemo`.
 */
export function useSecurityRecommendations({
  canEnableBiometric,
  biometricEnabled,
  biometricLoading,
  userEmail,
  sessions,
  deviceCount,
  securityActivities,
}: UseSecurityRecommendationsArgs): PrioritizedGroupedItem[] {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  return useMemo(() => {
    const descriptors = selectSecurityRecommendations({
      canEnableBiometric,
      biometricEnabled,
      biometricLoading,
      hasRecoveryEmail: !!userEmail,
      sessions,
      deviceCount,
      securityActivities,
    });

    const render = (descriptor: SecurityRecommendationDescriptor): PrioritizedGroupedItem => {
      const count = descriptor.count ?? 0;
      switch (descriptor.id) {
        case 'biometric':
          return {
            id: descriptor.id,
            priority: descriptor.priority,
            icon: Platform.OS === 'ios' ? 'face-recognition' : 'fingerprint',
            iconColor: colors.warning,
            title: t('security.recommendations.biometric'),
            subtitle: t('security.recommendations.biometricSubtitle'),
            onPress: () => {
              // The biometric toggle lives in the "How you sign in"
              // section on this same screen, so the recommendation is
              // purely informational — point the user at the toggle
              // below rather than offering a no-op navigation action.
              alert(
                t('security.recommendations.biometricAlertTitle'),
                t('security.recommendations.biometricAlertMessage'),
                [{ text: t('common.ok'), style: 'default' }]
              );
            },
            showChevron: true,
          };
        case 'recovery-email':
          return {
            id: descriptor.id,
            priority: descriptor.priority,
            icon: 'email-alert-outline',
            iconColor: colors.warning,
            title: t('security.recommendations.recoveryEmail'),
            subtitle: t('security.recommendations.recoveryEmailSubtitle'),
            onPress: () => {
              // Single prompt: confirm → route straight to the profile
              // screen where the email field lives. No nested alerts.
              alert(
                t('security.recommendations.recoveryEmailAlertTitle'),
                t('security.recommendations.recoveryEmailGoToProfile'),
                [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('security.recommendations.recoveryEmailAddCta'),
                    onPress: () => router.push('/(tabs)/personal-info'),
                  },
                ]
              );
            },
            showChevron: true,
          };
        case 'old-sessions':
          return {
            id: descriptor.id,
            priority: descriptor.priority,
            icon: 'clock-alert-outline',
            iconColor: colors.warning,
            title: t('security.recommendations.oldSessions', { count }),
            subtitle: t('security.recommendations.oldSessionsSubtitle'),
            onPress: () => {
              router.push('/(tabs)/devices');
            },
            showChevron: true,
          };
        case 'many-devices':
          return {
            id: descriptor.id,
            priority: descriptor.priority,
            icon: 'devices',
            iconColor: colors.sidebarIconDevices,
            title: t('security.recommendations.manyDevices', { count }),
            subtitle: t('security.recommendations.manyDevicesSubtitle'),
            onPress: () => {
              router.push('/(tabs)/devices');
            },
            showChevron: true,
          };
        case 'suspicious-activity':
          return {
            id: descriptor.id,
            priority: descriptor.priority,
            icon: 'alert-octagon',
            iconColor: colors.error,
            title: t('security.recommendations.suspicious', { count }),
            subtitle: t('security.recommendations.suspiciousSubtitle'),
            onPress: () => {
              alert(
                t('security.recommendations.suspiciousAlertTitle'),
                t('security.recommendations.suspiciousAlertMessage', { count }),
                [{ text: t('common.ok'), style: 'default' }]
              );
            },
            showChevron: true,
          };
      }
    };

    return descriptors.map(render);
  }, [
    canEnableBiometric,
    biometricEnabled,
    biometricLoading,
    userEmail,
    sessions,
    deviceCount,
    securityActivities,
    router,
    t,
    colors.warning,
    colors.error,
    colors.sidebarIconDevices,
  ]);
}
