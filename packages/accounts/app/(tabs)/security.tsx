import React from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, useUserDevices, useRecentSecurityActivity } from '@oxy.so/services';
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
import { useSignInMethodItems } from '@/components/security/useSignInMethodItems';
import { LanguageSection } from '@/components/security/language-section';
import { DevicesSection } from '@/components/security/devices-section';
import { useDeviceItems } from '@/components/security/useDeviceItems';
import { ActiveSessionsSection } from '@/components/security/active-sessions-section';
import { useActiveSessions } from '@/components/security/useActiveSessions';
import { ConnectedAppsSection } from '@/components/security/connected-apps-section';
import { SecuritySkeleton } from '@/components/security/security-skeleton';

export default function SecurityScreen() {
    const colors = useColors();
    const { width } = useWindowDimensions();
    const isDesktop = Platform.OS === 'web' && width >= 768;
    const { t } = useTranslation();

    // OxyServices integration — auth is enforced by the `(tabs)` layout.
    const { user, isLoading: oxyLoading, sessions, logoutAll } = useOxy();

    // Fetch devices using TanStack Query hook — the `(tabs)` layout guarantees
    // an authenticated session by the time this hook mounts.
    const { data: rawDevices, isLoading: loading } = useUserDevices();
    const devices = (rawDevices ?? []) as DeviceRecord[];

    // Fetch security activity
    const { data: securityActivities = [], isLoading: securityActivityLoading } = useRecentSecurityActivity(10);

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

    // An account without a key: its email, password, authenticator and
    // linking Commons. Returns [] for a Commons account, which signs in with its
    // key (the public-key row says so).
    const signInMethodItems = useSignInMethodItems();
    const keyed = Boolean(user?.publicKey);

    const deviceItems = useDeviceItems({ devices });

    const { items: activeSessionsItems } = useActiveSessions({ sessions, logoutAll });

    // While the account and its devices load, the page keeps its header and
    // shows the sections' shape (Bloom `Skeleton`) rather than a spinner.
    const loadingContent = oxyLoading || loading;

    const renderContent = () => loadingContent ? (
        <SecuritySkeleton label={t('security.loading')} />
    ) : (
        <>
            <SecurityRecommendationsSection items={securityRecommendations} />

            <SecurityActivitySection
                items={recentActivity}
                securityActivities={securityActivities}
                isLoading={securityActivityLoading}
            />

            <SignInSection
                items={[...signInMethodItems, ...signInItems.filter((item) => keyed || item.id !== 'public-key-auth')]}
            />

            <LanguageSection />

            <DevicesSection items={deviceItems} deviceCount={devices.length} />

            <ActiveSessionsSection items={activeSessionsItems} />

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
