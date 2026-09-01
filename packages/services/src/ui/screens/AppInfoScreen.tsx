import type React from 'react';
import { useState, useEffect } from 'react';
import {
    View,
    Platform,
    Dimensions,
    Clipboard,
    ActivityIndicator,
} from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { packageInfo } from '@oxyhq/core';
import { toast } from '@oxyhq/bloom/toast';
import OxyServicesLogo from '../../assets/icons/OxyServices';
import { SettingsIcon } from '../components/SettingsIcon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';

interface SystemInfo {
    platform: string;
    version: string;
    screenDimensions: {
        width: number;
        height: number;
    };
    timestamp: string;
}

const AppInfoScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
    navigate,
}) => {
    // Use useOxy() hook for OxyContext values
    const { user, sessions, oxyServices, isAuthenticated } = useOxy();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('appInfo.title') });
    const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
    const [isRunningSystemCheck, setIsRunningSystemCheck] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'disconnected' | 'unknown'>('unknown');

    const bloomTheme = useTheme();
    const colors = bloomTheme.colors;

    useEffect(() => {
        const updateDimensions = () => {
            const dimensions = Dimensions.get('window');
            setSystemInfo(prev => ({
                ...prev,
                platform: Platform.OS,
                version: Platform.Version?.toString() || 'Unknown',
                screenDimensions: {
                    width: dimensions.width,
                    height: dimensions.height,
                },
                timestamp: new Date().toISOString(),
            }));
        };

        // Set initial dimensions
        updateDimensions();

        // Listen for dimension changes
        const subscription = Dimensions.addEventListener('change', updateDimensions);

        // Check API connection on mount
        const checkConnection = async () => {
            setConnectionStatus('checking');

            if (!oxyServices) {
                setConnectionStatus('disconnected');
                return;
            }

            try {
                await oxyServices.healthCheck();
                setConnectionStatus('connected');
            } catch (error) {
                setConnectionStatus('disconnected');
            }
        };

        checkConnection();

        // Cleanup listener on unmount
        return () => {
            subscription?.remove();
        };
    }, [oxyServices]);

    const copyToClipboard = async (text: string, label: string) => {
        try {
            await Clipboard.setString(text);
            toast.success(t('appInfo.toasts.copiedToClipboard', { label }));
        } catch (error) {
            toast.error(t('appInfo.toasts.copyFailed'));
        }
    };

    const runSystemCheck = async () => {
        setIsRunningSystemCheck(true);

        try {
            // Simulate system check
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check API connection
            if (oxyServices) {
                try {
                    await oxyServices.healthCheck();
                    setConnectionStatus('connected');
                } catch (error) {
                    setConnectionStatus('disconnected');
                }
            }

            toast.success(t('appInfo.toasts.systemCheckSuccess'));
        } catch (error) {
            toast.error(t('appInfo.toasts.systemCheckFailed'));
        } finally {
            setIsRunningSystemCheck(false);
        }
    };

    const generateFullReport = () => {
        const report = {
            package: packageInfo,
            system: systemInfo,
            user: user ? {
                id: user.id,
                username: user.username,
                email: user.email,
                isPremium: user.isPremium,
            } : null,
            sessions: sessions?.length || 0,
            connection: connectionStatus,
            timestamp: new Date().toISOString(),
        };

        return JSON.stringify(report, null, 2);
    };

    const handleCopyFullReport = () => {
        const report = generateFullReport();
        copyToClipboard(report, t('appInfo.items.copyFullReport'));
    };

    return (
        <>

            <View className="px-screen-margin py-space-16 pb-space-24">
                    {/* Package Information */}
                    <SettingsListGroup title={t('appInfo.sections.package')}>
                        <SettingsListItem
                            icon={<OxyServicesLogo width={20} height={20} />}
                            title={t('appInfo.items.name')}
                            description={packageInfo.name}
                            onPress={() => copyToClipboard(packageInfo.name, t('appInfo.items.name'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="tag" color={colors.info} />}
                            title={t('appInfo.items.version')}
                            description={packageInfo.version}
                            onPress={() => copyToClipboard(packageInfo.version, t('appInfo.items.version'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="file-document" color={colors.success} />}
                            title={t('appInfo.items.description')}
                            description={packageInfo.description || t('appInfo.items.noDescription')}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="code-tags" color={colors.secondary} />}
                            title={t('appInfo.items.mainEntry')}
                            description={packageInfo.main || 'N/A'}
                            onPress={() => copyToClipboard(packageInfo.main || 'N/A', t('appInfo.items.mainEntry'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="library" color={colors.warning} />}
                            title={t('appInfo.items.moduleEntry')}
                            description={packageInfo.module || 'N/A'}
                            onPress={() => copyToClipboard(packageInfo.module || 'N/A', t('appInfo.items.moduleEntry'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="wrench" color={colors.success} />}
                            title={t('appInfo.items.typesEntry')}
                            description={packageInfo.types || 'N/A'}
                            onPress={() => copyToClipboard(packageInfo.types || 'N/A', t('appInfo.items.typesEntry'))}
                        />
                    </SettingsListGroup>

                    {/* System Information */}
                    <SettingsListGroup title={t('appInfo.sections.system')}>
                        <SettingsListItem
                            icon={<SettingsIcon name="cellphone" color={colors.primary} />}
                            title={t('appInfo.items.platform')}
                            description={Platform.OS}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="chip" color={colors.info} />}
                            title={t('appInfo.items.platformVersion')}
                            description={systemInfo?.version || t('common.status.loading')}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="resize" color={colors.secondary} />}
                            title={t('appInfo.items.screenWidth')}
                            description={`${systemInfo?.screenDimensions.width || 0}px`}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="resize" color={colors.warning} />}
                            title={t('appInfo.items.screenHeight')}
                            description={`${systemInfo?.screenDimensions.height || 0}px`}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="cog" color={colors.success} />}
                            title={t('appInfo.items.environment')}
                            description={__DEV__ ? t('appInfo.items.development') : t('appInfo.items.production')}
                        />
                    </SettingsListGroup>

                    {/* User Information */}
                    <SettingsListGroup title={t('appInfo.sections.user')}>
                        <SettingsListItem
                            icon={<SettingsIcon name="shield-check" color={isAuthenticated ? colors.success : colors.warning} />}
                            title={t('appInfo.items.authStatus')}
                            description={isAuthenticated ? t('appInfo.items.authenticated') : t('appInfo.items.notAuthenticated')}
                        />
                        {user && (
                            <>
                                <SettingsListItem
                                    icon={<SettingsIcon name="account" color={colors.primary} />}
                                    title={t('appInfo.items.userId')}
                                    description={user.id}
                                    onPress={() => copyToClipboard(user.id, t('appInfo.items.userId'))}
                                />
                                <SettingsListItem
                                    icon={<SettingsIcon name="at" color={colors.info} />}
                                    title={t('appInfo.items.username')}
                                    description={user.username || 'N/A'}
                                    onPress={() => {
                                        if (user?.username && navigate) {
                                            navigate('Profile', { userId: user.id });
                                        } else {
                                            toast.info(t('appInfo.toasts.noUsernameOrNav'));
                                        }
                                    }}
                                />
                                <SettingsListItem
                                    icon={<SettingsIcon name="email" color={colors.secondary} />}
                                    title={t('appInfo.items.email')}
                                    description={user.email || 'N/A'}
                                />
                                <SettingsListItem
                                    icon={<SettingsIcon name="star" color={user.isPremium ? colors.warning : colors.textTertiary} />}
                                    title={t('appInfo.items.premiumStatus')}
                                    description={user.isPremium ? t('appInfo.items.premium') : t('appInfo.items.standard')}
                                />
                            </>
                        )}
                        <SettingsListItem
                            icon={<SettingsIcon name="account-group" color={colors.success} />}
                            title={t('appInfo.items.totalActiveSessions')}
                            description={sessions?.length?.toString() || '0'}
                        />
                    </SettingsListGroup>

                    {/* API Configuration */}
                    <SettingsListGroup title={t('appInfo.sections.api')}>
                        <SettingsListItem
                            icon={<SettingsIcon name="server" color={colors.primary} />}
                            title={t('appInfo.items.apiBaseUrl')}
                            description={oxyServices?.getBaseURL() || t('appInfo.items.notConfigured')}
                            onPress={() => copyToClipboard(oxyServices?.getBaseURL() || t('appInfo.items.notConfigured'), t('appInfo.items.apiBaseUrl'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon
                                name={connectionStatus === 'checking' ? 'sync' : connectionStatus === 'connected' ? 'wifi' : 'wifi-off'}
                                color={connectionStatus === 'checking' ? colors.secondary : connectionStatus === 'connected' ? colors.success : colors.warning}
                            />}
                            title={t('appInfo.items.connectionStatus')}
                            description={connectionStatus === 'checking' ? t('appInfo.items.checking') : connectionStatus === 'connected' ? t('appInfo.items.connected') : connectionStatus === 'disconnected' ? t('appInfo.items.disconnected') : t('appInfo.items.unknown')}
                            onPress={async () => {
                                setConnectionStatus('checking');

                                if (!oxyServices) {
                                    setConnectionStatus('disconnected');
                                    toast.error(t('appInfo.toasts.oxyServicesNotInitialized'));
                                    return;
                                }

                                try {
                                    await oxyServices.healthCheck();
                                    setConnectionStatus('connected');
                                    toast.success(t('appInfo.toasts.apiConnectionSuccess'));
                                } catch (error) {
                                    setConnectionStatus('disconnected');
                                    toast.error(t('appInfo.toasts.apiConnectionFailed'));
                                }
                            }}
                        />
                    </SettingsListGroup>

                    {/* Build Information */}
                    <SettingsListGroup title={t('appInfo.sections.build')}>
                        <SettingsListItem
                            icon={<SettingsIcon name="clock" color={colors.primary} />}
                            title={t('appInfo.items.buildTimestamp')}
                            description={systemInfo?.timestamp || t('common.status.loading')}
                            onPress={() => copyToClipboard(systemInfo?.timestamp || t('common.status.loading'), t('appInfo.items.buildTimestamp'))}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="react" color={colors.info} />}
                            title={t('appInfo.items.reactNative')}
                            description={t('appInfo.items.reactNativeValue')}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="flash" color={colors.warning} />}
                            title={t('appInfo.items.jsEngine')}
                            description={t('appInfo.items.jsEngineValue')}
                        />
                    </SettingsListGroup>

                    {/* Quick Actions */}
                    <SettingsListGroup title={t('appInfo.sections.quickActions')}>
                        <SettingsListItem
                            icon={<SettingsIcon name="content-copy" color={colors.primary} />}
                            title={t('appInfo.items.copyFullReport')}
                            description={t('appInfo.items.copyFullReportSubtitle')}
                            onPress={handleCopyFullReport}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon
                                name={isRunningSystemCheck ? 'sync' : 'check-circle'}
                                color={isRunningSystemCheck ? colors.warning : colors.success}
                            />}
                            title={isRunningSystemCheck ? t('appInfo.items.runningSystemCheck') : t('appInfo.items.runSystemCheck')}
                            description={isRunningSystemCheck
                                ? t('appInfo.items.systemCheckRunning')
                                : t('appInfo.items.systemCheckSubtitle')}
                            onPress={runSystemCheck}
                            disabled={isRunningSystemCheck}
                            rightElement={isRunningSystemCheck ? (
                                <ActivityIndicator color={colors.warning} size="small" />
                            ) : undefined}
                        />
                    </SettingsListGroup>
                </View>
        </>
    );
};

export default AppInfoScreen;
