import React from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import {
  OxySignInSecurityPanel,
  useOxy,
  useSignInMethods,
  useUserDevices,
  useRecentSecurityActivity,
} from '@oxy.so/services';
import type { DeviceRecord } from '@/utils/device-utils';
import { useTranslation } from '@/lib/i18n';
import { useBiometricSettings } from '@/hooks/useBiometricSettings';
import { SecurityRecommendationsSection } from '@/components/security/security-recommendations-section';
import { useIdentityRootStatus } from '@/hooks/useIdentityRootStatus';
import { useSecurityRecommendations } from '@/components/security/useSecurityRecommendations';
import { SecurityActivitySection } from '@/components/security/security-activity-section';
import { useSecurityActivityItems } from '@/components/security/useSecurityActivityItems';
import { SignInSection } from '@/components/security/sign-in-section';
import { useSignInItems } from '@/components/security/useSignInItems';
import { DevicesSection } from '@/components/security/devices-section';
import { useDeviceItems } from '@/components/security/useDeviceItems';
import { ConnectedAppsSection } from '@/components/security/connected-apps-section';
import { SecuritySkeleton } from '@/components/security/security-skeleton';

export default function SecurityScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();

  // OxyServices integration — auth is enforced by the `(tabs)` layout.
  const { user, isLoading: oxyLoading, sessions } = useOxy();
  // How a personal account without a key signs in, for the recommendations;
  // the same query the sign-in & security panel below reads.
  const keylessPerson = !user?.publicKey && (!user?.kind || user.kind === 'personal');
  const { data: signInMethods } = useSignInMethods({ enabled: keylessPerson });

  // Fetch devices using TanStack Query hook — the `(tabs)` layout guarantees
  // an authenticated session by the time this hook mounts.
  const { data: rawDevices, isLoading: loading } = useUserDevices();
  const devices = (rawDevices ?? []) as DeviceRecord[];

  // Fetch security activity
  const { data: securityActivities = [], isLoading: securityActivityLoading } =
    useRecentSecurityActivity(10);

  // Biometric settings
  const {
    enabled: biometricEnabled,
    canEnable: canEnableBiometric,
    hasHardware: hasBiometricHardware,
    isEnrolled: isBiometricEnrolled,
    supportedTypes: biometricTypes,
    isLoading: biometricLoading,
    isSaving: biometricSaving,
    toggleBiometricLogin,
  } = useBiometricSettings();

  const rootStatus = useIdentityRootStatus();
  const securityRecommendations = useSecurityRecommendations({
    canEnableBiometric,
    biometricEnabled,
    biometricLoading,
    rootStatus,
    signInMethods: keylessPerson ? signInMethods : undefined,
    sessions,
    deviceCount: devices.length,
    securityActivities,
  });

  const recentActivity = useSecurityActivityItems({ securityActivities });

  const signInItems = useSignInItems({
    biometricEnabled,
    canEnableBiometric,
    hasBiometricHardware,
    isBiometricEnrolled,
    biometricTypes,
    biometricLoading,
    biometricSaving,
    toggleBiometricLogin,
  });

  const deviceItems = useDeviceItems({ devices });

  // While the account and its devices load, the page keeps its header and
  // shows the sections' shape (Bloom `Skeleton`) rather than a spinner.
  const loadingContent = oxyLoading || loading;

  const renderContent = () =>
    loadingContent ? (
      <SecuritySkeleton label={t('security.loading')} />
    ) : (
      <>
        <SecurityRecommendationsSection items={securityRecommendations} />

        <SecurityActivitySection
          items={recentActivity}
          securityActivities={securityActivities}
          isLoading={securityActivityLoading}
        />

        {/* The SDK's one sign-in & security page: the email, password,
            authenticator and Commons, each with its state, and every
            session of the account. */}
        <OxySignInSecurityPanel />

        <SignInSection items={signInItems} />

        <DevicesSection items={deviceItems} deviceCount={devices.length} />

        <ConnectedAppsSection />
      </>
    );

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('security.title')} subtitle={t('security.subtitle')} />
        {renderContent()}
      </>
    );
  }

  return (
    <ScreenContentWrapper>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('security.title')} subtitle={t('security.subtitle')} />
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
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
});
