import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { IdentityRootStatus } from '@oxy.so/contracts';
import type { GroupedItem } from '@/components/sections/types';
import type { HomeHandlers } from './useHomeHandlers';

interface UseSecurityOverviewItemsArgs {
  biometricEnabled: boolean;
  canEnableBiometric: boolean;
  hasBiometricHardware: boolean;
  biometricLoading: boolean;
  /** `GET /identity/root-status`, or `undefined` while unknown. */
  rootStatus: IdentityRootStatus | undefined;
  /** Link Commons to this passkey account (auth.oxy.so/link-commons). */
  handleLinkCommons: () => void;
  handleSecurity: HomeHandlers['handleSecurity'];
}

/**
 * Builds the security-overview rows on the home screen (biometric status, how
 * the account is recovered, overall security status). The recovery row of a
 * passkey account links Commons; every other row opens the security screen.
 * The biometric row is native-only.
 *
 * Extracted verbatim from the screen's inline `useMemo`.
 */
export function useSecurityOverviewItems({
  biometricEnabled,
  canEnableBiometric,
  hasBiometricHardware,
  biometricLoading,
  rootStatus,
  handleLinkCommons,
  handleSecurity,
}: UseSecurityOverviewItemsArgs): GroupedItem[] {
  const colors = useColors();
  const { t } = useTranslation();

  return useMemo<GroupedItem[]>(() => {
    const items: GroupedItem[] = [];

    // Biometric status
    if (Platform.OS !== 'web') {
      let biometricSubtitle = '';
      if (biometricLoading) {
        biometricSubtitle = t('home.securityOverview.biometricChecking');
      } else if (!hasBiometricHardware) {
        biometricSubtitle = t('home.securityOverview.biometricNotAvailable');
      } else if (biometricEnabled) {
        biometricSubtitle = t('home.securityOverview.biometricEnabled');
      } else if (canEnableBiometric) {
        biometricSubtitle = t('home.securityOverview.biometricAvailable');
      } else {
        biometricSubtitle = t('home.securityOverview.biometricNotSetUp');
      }

      items.push({
        id: 'biometric',
        icon: Platform.OS === 'ios' ? 'face-recognition' : 'fingerprint',
        iconColor: biometricEnabled ? colors.success : colors.sidebarIconSecurity,
        title: Platform.OS === 'ios' ? t('home.securityOverview.faceTouchId') : t('home.securityOverview.biometricAuth'),
        subtitle: biometricSubtitle,
        onPress: handleSecurity,
      });
    }

    // How the account gets back in (ADR 0029 D3): Commons' recovery phrase for
    // a self-custodied account, the recovery email for a passkey account.
    // Unknown status shows no verdict.
    const recoveryNeedsAttention = rootStatus !== undefined && !rootStatus.rootLinked && !rootStatus.recoveryEmail;
    let recoverySubtitle = '';
    if (rootStatus === undefined) recoverySubtitle = t('home.securityOverview.recoveryChecking');
    else if (rootStatus.rootLinked) recoverySubtitle = t('home.securityOverview.recoveryInCommons');
    else if (rootStatus.recoveryEmail) recoverySubtitle = t('home.securityOverview.recoveryEmail', { email: rootStatus.recoveryEmail });
    else recoverySubtitle = t('home.securityOverview.recoveryNotSecured');
    items.push({
      id: 'recovery',
      icon: rootStatus?.rootLinked ? 'form-textbox-password' : 'email-lock-outline',
      iconColor: recoveryNeedsAttention ? colors.sidebarIconSecurity : colors.success,
      title: t('home.securityOverview.recovery'),
      subtitle: recoverySubtitle,
      // A passkey account is one step from its own key.
      onPress: rootStatus && !rootStatus.rootLinked ? handleLinkCommons : handleSecurity,
    });

    // Security status based on recommendations
    const hasSecurityIssues = recoveryNeedsAttention || (Platform.OS !== 'web' && hasBiometricHardware && !biometricEnabled && canEnableBiometric);
    items.push({
      id: 'security-status',
      icon: 'shield-lock-outline',
      iconColor: hasSecurityIssues ? colors.sidebarIconPayments : colors.success,
      title: t('home.securityOverview.securityStatus'),
      subtitle: hasSecurityIssues ? t('home.securityOverview.needsAttention') : t('home.securityOverview.protected'),
      onPress: handleSecurity,
    });

    return items;
  }, [biometricEnabled, canEnableBiometric, hasBiometricHardware, biometricLoading, colors.sidebarIconSecurity, colors.sidebarIconPayments, colors.success, rootStatus, handleLinkCommons, handleSecurity, t]);
}
