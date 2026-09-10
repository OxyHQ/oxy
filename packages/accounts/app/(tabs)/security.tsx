import React from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, useUserDevices, useRecentSecurityActivity } from '@oxy.so/services';
import { type DeviceRecord } from '@/utils/device-utils';
import { useTranslation } from '@/lib/i18n';
import { useBiometricSettings } from '@/hooks/useBiometricSettings';
import { SecurityRecommendationsSection } from '@/components/security/security-recommendations-section';
import { useSecurityRecommendations } from '@/components/security/useSecurityRecommendations';
import { SecurityActivitySection } from '@/components/security/security-activity-section';
import { useSecurityActivityItems } from '@/components/security/useSecurityActivityItems';
import { SignInSection } from '@/components/security/sign-in-section';
import { useSignInItems } from '@/components/security/useSignInItems';
import { usePasskeyItems } from '@/components/security/usePasskeyItems';
import { LanguageSection } from '@/components/security/language-section';
import { DevicesSection } from '@/components/security/devices-section';
import { useDeviceItems } from '@/components/security/useDeviceItems';
import { ActiveSessionsSection } from '@/components/security/active-sessions-section';
import { useActiveSessions } from '@/components/security/useActiveSessions';
import { ConnectedAppsSection } from '@/components/security/connected-apps-section';

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

    const securityRecommendations = useSecurityRecommendations({
        canEnableBiometric,
        biometricEnabled,
        biometricLoading,
        userEmail: user?.email,
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

    // Passkey rows (web-only, Oxy RP origin) appended to "How you sign in".
    // Returns [] on native / non-Oxy origins, so the spread below is a no-op there.
    const passkeyItems = usePasskeyItems();

    const deviceItems = useDeviceItems({ devices });

    const { items: activeSessionsItems } = useActiveSessions({ sessions, logoutAll });

    // Show loading state
    if (oxyLoading || loading) {
        return (
            <ScreenContentWrapper>
                <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
                    <ActivityIndicator size="large" color={colors.tint} />
                    <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('security.loading')}</ThemedText>
                </View>
            </ScreenContentWrapper>
        );
    }

    const renderContent = () => (
        <>
            <SecurityRecommendationsSection items={securityRecommendations} />

            <SecurityActivitySection
                items={recentActivity}
                securityActivities={securityActivities}
                isLoading={securityActivityLoading}
            />

            <SignInSection items={[...signInItems, ...passkeyItems]} />

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
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
    },
    loadingText: {
        fontSize: 16,
        opacity: 0.7,
    },
});
