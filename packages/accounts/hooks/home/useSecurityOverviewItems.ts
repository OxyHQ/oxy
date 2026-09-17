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
  /** Open the person's Oxy identity page (save/show the recovery phrase, recover). */
  handleIdentity: () => void;
  handleSecurity: HomeHandlers['handleSecurity'];
}

/**
 * Builds the security-overview rows on the home screen (biometric status,
 * recovery phrase, overall security status). The biometric and status rows link
 * to the security screen; the recovery row opens the person's Oxy identity. The
 * biometric row is native-only.
 *
 * Extracted verbatim from the screen's inline `useMemo`.
 */
export function useSecurityOverviewItems({
  biometricEnabled,
  canEnableBiometric,
  hasBiometricHardware,
  biometricLoading,
  rootStatus,
  handleIdentity,
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

    // Recovery phrase — what gets an Oxy account back (ADR 0024: no email or
    // support recovery exists). Unknown status shows no verdict.
    const recoveryNeedsAttention =
      rootStatus !== undefined && (!rootStatus.rootLinked || (rootStatus.hasPhrase === true && !rootStatus.phraseConfirmedAt));
    let recoverySubtitle = '';
    if (rootStatus === undefined) recoverySubtitle = t('home.securityOverview.recoveryChecking');
    else if (!rootStatus.rootLinked) recoverySubtitle = t('home.securityOverview.recoveryNotSecured');
    else if (rootStatus.webHolder === null) recoverySubtitle = t('home.securityOverview.recoveryInCommons');
    else if (rootStatus.hasPhrase === false || rootStatus.phraseConfirmedAt) recoverySubtitle = t('home.securityOverview.recoverySaved');
    else recoverySubtitle = t('home.securityOverview.recoveryNotSaved');
    items.push({
      id: 'recovery-phrase',
      icon: 'form-textbox-password',
      iconColor: recoveryNeedsAttention ? colors.sidebarIconSecurity : colors.success,
      title: t('home.securityOverview.recoveryPhrase'),
      subtitle: recoverySubtitle,
      onPress: handleIdentity,
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
  }, [biometricEnabled, canEnableBiometric, hasBiometricHardware, biometricLoading, colors.sidebarIconSecurity, colors.sidebarIconPayments, colors.success, rootStatus, handleIdentity, handleSecurity, t]);
}
