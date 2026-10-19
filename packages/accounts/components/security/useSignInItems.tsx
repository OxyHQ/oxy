import React, { useMemo } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Switch } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

interface UseSignInItemsArgs {
  biometricEnabled: boolean;
  canEnableBiometric: boolean;
  hasBiometricHardware: boolean;
  isBiometricEnrolled: boolean;
  biometricTypes: string[];
  biometricLoading: boolean;
  biometricSaving: boolean;
  toggleBiometricLogin: (value: boolean) => void | Promise<void>;
}

/**
 * Builds the "On this device" `GroupedSection` rows: the biometric toggle
 * (with a context-aware subtitle and either a `Switch`, a check icon, or
 * nothing depending on capability). Empty on the web.
 *
 * Extracted verbatim from the security screen's inline `useMemo`. Lives in a
 * `.tsx` file because the rows embed JSX (the `Switch` / check-icon).
 */
export function useSignInItems({
  biometricEnabled,
  canEnableBiometric,
  hasBiometricHardware,
  isBiometricEnrolled,
  biometricTypes,
  biometricLoading,
  biometricSaving,
  toggleBiometricLogin,
}: UseSignInItemsArgs): GroupedItem[] {
  const colors = useColors();
  const { t } = useTranslation();

  return useMemo(() => {
    const items: GroupedItem[] = [];

    // Biometric authentication
    if (Platform.OS !== 'web') {
      let biometricSubtitle = '';
      if (biometricLoading) {
        biometricSubtitle = t('security.signIn.biometricChecking');
      } else if (!hasBiometricHardware) {
        biometricSubtitle = t('security.signIn.biometricNoHardware');
      } else if (!isBiometricEnrolled) {
        biometricSubtitle = t('security.signIn.biometricNotEnrolled');
      } else if (biometricEnabled) {
        biometricSubtitle =
          biometricTypes.length > 0
            ? t('security.signIn.biometricEnabledWithTypes', { types: biometricTypes.join(', ') })
            : t('security.signIn.biometricEnabled');
      } else {
        biometricSubtitle = canEnableBiometric
          ? t('security.signIn.biometricAvailableToggle')
          : t('security.signIn.biometricNotAvailable');
      }

      items.push({
        id: 'biometric',
        icon: Platform.OS === 'ios' ? 'face-recognition' : 'fingerprint',
        iconColor: biometricEnabled ? colors.success : colors.sidebarIconSecurity,
        title:
          Platform.OS === 'ios'
            ? t('security.signIn.faceTouchId')
            : t('security.signIn.biometricAuthTitle'),
        subtitle: biometricSubtitle,
        customContent: canEnableBiometric ? (
          <Switch
            checked={biometricEnabled}
            onCheckedChange={toggleBiometricLogin}
            disabled={biometricSaving || biometricLoading}
          />
        ) : biometricEnabled ? (
          <View style={styles.statusContainer}>
            <Ionicons name="checkmark-circle" size={20} color={colors.iconSuccess} />
          </View>
        ) : undefined,
      });
    }

    return items;
  }, [
    colors,
    biometricEnabled,
    canEnableBiometric,
    hasBiometricHardware,
    isBiometricEnrolled,
    biometricTypes,
    biometricLoading,
    biometricSaving,
    toggleBiometricLogin,
    t,
  ]);
}

const styles = StyleSheet.create({
  statusContainer: {
    marginLeft: 8,
  },
});
