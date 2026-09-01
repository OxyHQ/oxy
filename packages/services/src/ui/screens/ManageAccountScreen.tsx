import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
    View,
    StyleSheet,
    ActivityIndicator,
    Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { toast } from '@oxyhq/bloom';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import {
    getAccountDisplayName,
    getAccountFallbackHandle,
    logger as loggerUtil,
    packageInfo,
} from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import ProfileSummaryCard from '../components/ProfileSummaryCard';
import { SettingsIcon } from '../components/SettingsIcon';
import { presentDeleteAccount } from '../components/modals/DeleteAccountModal';
import { presentActionSheet } from '../components/surfaces/ActionSheetSurface';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useCurrentUser } from '../hooks/queries/useAccountQueries';
import { useUserSubscription } from '../hooks/queries/usePaymentQueries';
import { useDeviceSessions } from '../hooks/queries/useServicesQueries';

interface DeviceSessionRow {
    sessionId: string;
    deviceId: string;
    deviceName: string;
    isActive: boolean;
    lastActive: string;
    expiresAt: string;
    isCurrent: boolean;
}

const AVATAR_SIZE = 88;

const formatRelative = (dateString?: string): string => {
    if (!dateString) {
        return '—';
    }
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const absMin = Math.abs(diffMs) / 60000;
    const isFuture = diffMs > 0;
    if (absMin < 1) {
        return isFuture ? 'in moments' : 'just now';
    }
    if (absMin < 60) {
        const v = Math.floor(absMin);
        return isFuture ? `in ${v}m` : `${v}m ago`;
    }
    const hrs = absMin / 60;
    if (hrs < 24) {
        const v = Math.floor(hrs);
        return isFuture ? `in ${v}h` : `${v}h ago`;
    }
    const days = hrs / 24;
    if (days < 7) {
        const v = Math.floor(days);
        return isFuture ? `in ${v}d` : `${v}d ago`;
    }
    return date.toLocaleDateString();
};

/**
 * Unified "Manage your Oxy Account" screen.
 *
 * Replaces AccountOverview + AccountSettings + the per-account half of
 * SessionManagement. Lists ONLY the active user's profile, sessions on this
 * device, and security/destructive actions for THIS account. Multi-account
 * surface lives in the unified `OxyAccountDialogScreen` — keep these concerns separate.
 */
const ManageAccountScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
    navigate,
}) => {
    const bloomTheme = useTheme();
    const { t, locale } = useI18n();

    useSurfaceHeader({ title: t('manageAccount.title') || 'Manage your Oxy Account' });
    const {
        user: contextUser,
        isAuthenticated,
        oxyServices,
        activeSessionId,
        logout,
        openAvatarPicker,
        accounts,
        openAccountDialog,
    } = useOxy();

    const { data: userFromQuery, isLoading: userLoading } = useCurrentUser({
        enabled: isAuthenticated,
    });
    // `user` IS the active account. In the real-session switch model, switching
    // into an org/project/bot makes it the active session, so `useOxy().user`
    // (and the freshest `useCurrentUser` copy) already reflects the switched
    // account everywhere — identity-of-me surfaces and management/GDPR actions
    // alike read this single `user`.
    const user = userFromQuery ?? contextUser;

    const { data: subscription } = useUserSubscription({ enabled: isAuthenticated });
    const {
        data: deviceSessions,
        isLoading: deviceSessionsLoading,
        refetch: refetchDeviceSessions,
    } = useDeviceSessions({ enabled: isAuthenticated && !!activeSessionId });

    const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);
    const [signingOutAllDevices, setSigningOutAllDevices] = useState(false);
    const [signingOut, setSigningOut] = useState(false);

    const displayName = useMemo(() => getAccountDisplayName(user, locale), [user, locale]);
    const handle = useMemo(() => getAccountFallbackHandle(user), [user]);
    const avatarUri = useMemo(() => {
        return user?.avatar
            ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb')
            : undefined;
    }, [user?.avatar, oxyServices]);

    const handleSignOut = useCallback(async () => {
        if (signingOut) {
            return;
        }
        const confirmed = await surfaces.confirm({
            title: t('common.actions.signOut') || 'Sign out',
            message: t('common.confirms.signOut') || 'Are you sure you want to sign out?',
            confirmLabel: t('common.actions.signOut') || 'Sign out',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) {
            return;
        }
        setSigningOut(true);
        try {
            await logout();
            toast.success(t('common.actions.signedOut') || 'Signed out');
            onClose?.();
        } catch (error) {
            loggerUtil.warn('Sign out failed', { component: 'ManageAccountScreen' }, error as unknown);
            toast.error(t('common.errors.signOutFailed') || 'Failed to sign out');
        } finally {
            setSigningOut(false);
        }
    }, [signingOut, logout, t, onClose]);

    const confirmRemoveDevice = useCallback(async (device: DeviceSessionRow) => {
        if (!activeSessionId) {
            return;
        }
        const confirmed = await surfaces.confirm({
            title: t('manageAccount.confirms.removeDeviceTitle') || 'Remove device',
            message:
                t('manageAccount.confirms.removeDevice', { name: device.deviceName })
                || `Sign out from "${device.deviceName}"?`,
            confirmLabel: t('common.remove') || 'Remove',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) {
            return;
        }
        setRemovingDeviceId(device.sessionId);
        try {
            await oxyServices.logoutSession(activeSessionId, device.sessionId);
            await refetchDeviceSessions();
            toast.success(
                t('manageAccount.toasts.deviceRemoved', { name: device.deviceName })
                || `Signed out from ${device.deviceName}`,
            );
        } catch (error) {
            loggerUtil.warn('Remove device failed', { component: 'ManageAccountScreen' }, error as unknown);
            toast.error(t('manageAccount.toasts.deviceRemoveFailed') || 'Failed to remove device');
        } finally {
            setRemovingDeviceId(null);
        }
    }, [activeSessionId, oxyServices, refetchDeviceSessions, t]);

    const handleSignOutAllDevices = useCallback(async () => {
        if (!activeSessionId || signingOutAllDevices) {
            return;
        }
        const otherDeviceCount = ((deviceSessions ?? []) as DeviceSessionRow[]).filter(
            (device) => !device.isCurrent,
        ).length;
        const confirmed = await surfaces.confirm({
            title: t('manageAccount.confirms.signOutAllDevicesTitle') || 'Sign out of all other devices',
            message:
                t('manageAccount.confirms.signOutAllDevices', { count: otherDeviceCount })
                || `End ${otherDeviceCount} other device session(s)? This won't sign you out here.`,
            confirmLabel: t('common.actions.signOut') || 'Sign out',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) {
            return;
        }
        setSigningOutAllDevices(true);
        try {
            await oxyServices.logoutAllDeviceSessions(activeSessionId);
            await refetchDeviceSessions();
            toast.success(
                t('manageAccount.toasts.allDevicesSignedOut')
                || 'Signed out from all other devices',
            );
        } catch (error) {
            loggerUtil.warn('Sign out all devices failed', { component: 'ManageAccountScreen' }, error as unknown);
            toast.error(
                t('manageAccount.toasts.allDevicesFailed')
                || 'Failed to sign out from other devices',
            );
        } finally {
            setSigningOutAllDevices(false);
        }
    }, [activeSessionId, signingOutAllDevices, deviceSessions, oxyServices, refetchDeviceSessions, t]);

    const performDownload = useCallback(
        async (format: 'json' | 'csv') => {
            if (!user) {
                toast.error(
                    t('accountOverview.items.downloadData.error') || 'Service not available',
                );
                return;
            }
            try {
                toast.info(
                    t('accountOverview.items.downloadData.downloading')
                    || 'Preparing download...',
                );
                const blob = await oxyServices.downloadAccountData(format);
                if (Platform.OS === 'web') {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `account-data-${Date.now()}.${format}`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                }
                toast.success(
                    t('accountOverview.items.downloadData.success')
                    || 'Data downloaded successfully',
                );
            } catch (error) {
                loggerUtil.warn(
                    'Download account data failed',
                    { component: 'ManageAccountScreen' },
                    error as unknown,
                );
                toast.error(
                    (error instanceof Error ? error.message : null)
                    || t('accountOverview.items.downloadData.error')
                    || 'Failed to download data',
                );
            }
        },
        [oxyServices, user, t],
    );

    // Runs the actual deletion from inside the delete-account surface; it throws
    // on failure so the surface can surface the error and stay open. Sign-out +
    // close happen in `handleDeleteAccount` once the surface resolves `true`.
    const handleConfirmDelete = useCallback(
        async (confirmText: string) => {
            if (!user) {
                throw new Error(
                    t('accountOverview.items.deleteAccount.error')
                    || 'Service not available',
                );
            }
            await oxyServices.deleteAccount(confirmText);
            toast.success(
                t('accountOverview.items.deleteAccount.success')
                || 'Account deleted successfully',
            );
        },
        [oxyServices, user, t],
    );

    const handleDownloadData = useCallback(async () => {
        if (!user) {
            toast.error(
                t('accountOverview.items.downloadData.error') || 'Service not available',
            );
            return;
        }
        const format = await presentActionSheet<'json' | 'csv'>({
            title: t('accountOverview.items.downloadData.confirmTitle') || 'Download account data',
            message:
                t('accountOverview.items.downloadData.confirmMessage')
                || 'Choose the format for your account data export:',
            options: [
                { label: 'JSON', value: 'json' },
                { label: 'CSV', value: 'csv' },
            ],
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (format) {
            await performDownload(format);
        }
    }, [user, t, performDownload]);

    const handleDeleteAccount = useCallback(async () => {
        if (!user) {
            toast.error(
                t('accountOverview.items.deleteAccount.error') || 'User not available',
            );
            return;
        }
        const deleted = await presentDeleteAccount({
            username: user.username || '',
            onDelete: handleConfirmDelete,
            t,
        });
        if (deleted) {
            await logout();
            onClose?.();
        }
    }, [user, t, handleConfirmDelete, logout, onClose]);

    if (!isAuthenticated) {
        return (
            <>
                <View className="items-center py-space-40">
                    <Text className="text-text font-medium text-base">
                        {t('common.status.notSignedIn') || 'Not signed in'}
                    </Text>
                </View>
            </>
        );
    }

    if (userLoading && !user) {
        return (
            <>
                <View className="items-center py-space-40">
                    <ActivityIndicator color={bloomTheme.colors.primary} size="large" />
                </View>
            </>
        );
    }

    const deviceRows: DeviceSessionRow[] = (deviceSessions ?? []) as DeviceSessionRow[];
    const otherDevices = deviceRows.filter((d) => !d.isCurrent);

    return (
        <>
            <View className="px-screen-margin pb-space-24">
                {/* Profile card */}
                <ProfileSummaryCard
                    displayName={displayName}
                    avatarUri={avatarUri}
                    avatarSize={AVATAR_SIZE}
                    onAvatarPress={openAvatarPicker}
                    showCameraBadge
                    avatarAccessibilityLabel={t('editProfile.changeAvatar') || 'Change avatar'}
                    lines={[
                        handle ? (user?.username ? `@${handle}` : handle) : null,
                        user?.email || null,
                    ]}
                />

                {/* Profile section */}
                <SettingsListGroup title={t('manageAccount.sections.profile') || 'Profile'}>
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="account-circle"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={t('manageAccount.items.editProfile.title') || 'Edit profile'}
                        description={
                            t('manageAccount.items.editProfile.subtitle')
                            || 'Name, username, bio, links'
                        }
                        onPress={() => navigate?.('EditProfile')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="palette"
                                color={bloomTheme.colors.info}
                            />
                        }
                        title={t('manageAccount.items.theme.title') || 'Theme color'}
                        description={
                            t('manageAccount.items.theme.subtitle')
                            || 'Personalize your Bloom color'
                        }
                        onPress={() => navigate?.('Preferences')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="eye"
                                color={bloomTheme.colors.success}
                            />
                        }
                        title={t('editProfile.items.previewProfile.title') || 'Preview profile'}
                        description={
                            t('editProfile.items.previewProfile.subtitle')
                            || 'See how your profile looks to others'
                        }
                        onPress={() =>
                            user?.id ? navigate?.('Profile', { userId: user.id }) : undefined
                        }
                        disabled={!user?.id}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="check-circle"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={
                            t('editProfile.items.verifyAccount.title') || 'Verify account'
                        }
                        description={
                            t('editProfile.items.verifyAccount.subtitle')
                            || 'Get a verified badge'
                        }
                        onPress={() => navigate?.('AccountVerification')}
                    />
                </SettingsListGroup>

                {/* Sessions section */}
                <SettingsListGroup
                    title={t('manageAccount.sections.sessions') || 'Sessions & devices'}
                >
                    {deviceSessionsLoading ? (
                        <SettingsListItem
                            icon={
                                <SettingsIcon name="sync" color={bloomTheme.colors.primary} />
                            }
                            title={
                                t('manageAccount.sessions.loading') || 'Loading sessions…'
                            }
                            rightElement={
                                <ActivityIndicator
                                    color={bloomTheme.colors.primary}
                                    size="small"
                                />
                            }
                            showChevron={false}
                            disabled
                        />
                    ) : deviceRows.length === 0 ? (
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="cellphone"
                                    color={bloomTheme.colors.textTertiary}
                                />
                            }
                            title={t('manageAccount.sessions.empty') || 'No active sessions'}
                            showChevron={false}
                            disabled
                        />
                    ) : (
                        deviceRows.map((device) => (
                            <SettingsListItem
                                key={`device-${device.sessionId}`}
                                icon={
                                    <SettingsIcon
                                        name={device.isCurrent ? 'cellphone' : 'cellphone-basic'}
                                        color={
                                            device.isCurrent
                                                ? bloomTheme.colors.success
                                                : bloomTheme.colors.primary
                                        }
                                    />
                                }
                                title={`${device.deviceName}${device.isCurrent ? ` (${t('manageAccount.sessions.thisDevice') || 'This device'})` : ''}`}
                                description={
                                    t('manageAccount.sessions.lastActive', {
                                        relative: formatRelative(device.lastActive),
                                    }) || `Last active ${formatRelative(device.lastActive)}`
                                }
                                onPress={
                                    device.isCurrent
                                        ? undefined
                                        : () => confirmRemoveDevice(device)
                                }
                                disabled={
                                    device.isCurrent
                                    || removingDeviceId === device.sessionId
                                }
                                rightElement={
                                    !device.isCurrent ? (
                                        removingDeviceId === device.sessionId ? (
                                            <ActivityIndicator
                                                color={bloomTheme.colors.error}
                                                size="small"
                                            />
                                        ) : (
                                            <Ionicons
                                                name="log-out-outline"
                                                size={18}
                                                color={bloomTheme.colors.error}
                                            />
                                        )
                                    ) : undefined
                                }
                                showChevron={false}
                            />
                        ))
                    )}
                    {otherDevices.length > 0 ? (
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="logout"
                                    color={bloomTheme.colors.error}
                                />
                            }
                            title={
                                t('manageAccount.sessions.signOutAllOnThisDevice')
                                || 'Sign out of all other devices'
                            }
                            description={
                                t('manageAccount.sessions.signOutAllSubtitle', {
                                    count: otherDevices.length,
                                })
                                || `End ${otherDevices.length} other device session(s)`
                            }
                            onPress={handleSignOutAllDevices}
                            destructive
                            showChevron={false}
                            disabled={signingOutAllDevices}
                            rightElement={
                                signingOutAllDevices ? (
                                    <ActivityIndicator
                                        color={bloomTheme.colors.error}
                                        size="small"
                                    />
                                ) : undefined
                            }
                        />
                    ) : null}
                </SettingsListGroup>

                {/* Security section */}
                <SettingsListGroup
                    title={t('manageAccount.sections.security') || 'Security'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="shield-check"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={
                            t('manageAccount.items.security.title') || 'Security settings'
                        }
                        description={
                            t('manageAccount.items.security.subtitle')
                            || 'Password, 2FA, recovery'
                        }
                        onPress={() => navigate?.('PrivacySettings')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="star"
                                color={bloomTheme.colors.warning}
                            />
                        }
                        title={
                            t('accountOverview.items.premium.title') || 'Oxy+'
                        }
                        description={
                            user?.isPremium
                                ? (t('accountOverview.items.premium.manage') || 'Manage your premium plan')
                                : (t('accountOverview.items.premium.upgrade') || 'Upgrade to premium features')
                        }
                        onPress={() => navigate?.('PremiumSubscription')}
                    />
                    {user?.isPremium || subscription?.status === 'active' ? (
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="credit-card"
                                    color={bloomTheme.colors.success}
                                />
                            }
                            title={
                                t('manageAccount.items.billing.title') || 'Billing'
                            }
                            description={
                                t('manageAccount.items.billing.subtitle')
                                || 'Manage subscription and payment methods'
                            }
                            onPress={() => navigate?.('PaymentGateway')}
                        />
                    ) : null}
                </SettingsListGroup>

                {/* Account & data */}
                <SettingsListGroup
                    title={t('accountOverview.sections.quickActions') || 'Account & data'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="clock" color={bloomTheme.colors.primary} />
                        }
                        title={t('accountOverview.items.history.title') || 'History'}
                        description={
                            t('accountOverview.items.history.subtitle')
                            || 'View and manage your search history'
                        }
                        onPress={() => navigate?.('HistoryView')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="bookmark" color={bloomTheme.colors.info} />
                        }
                        title={
                            t('accountOverview.items.saves.title') || 'Saves & Collections'
                        }
                        description={
                            t('accountOverview.items.saves.subtitle')
                            || 'View your saved items and collections'
                        }
                        onPress={() => navigate?.('SavesCollections')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="folder" color={bloomTheme.colors.info} />
                        }
                        title={
                            t('accountCenter.items.fileManagement.title') || 'Files'
                        }
                        description={
                            t('accountCenter.items.fileManagement.subtitle')
                            || 'Upload, download, and manage your files'
                        }
                        onPress={() => navigate?.('FileManagement')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="download"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={
                            t('accountOverview.items.downloadData.title')
                            || 'Download your data'
                        }
                        description={
                            t('accountOverview.items.downloadData.subtitle')
                            || 'Export a copy of your account data'
                        }
                        onPress={handleDownloadData}
                    />
                </SettingsListGroup>

                {/* Accounts (unified account graph) */}
                {accounts.length > 0 || isAuthenticated ? (
                    <SettingsListGroup
                        title={
                            t('accountCenter.sections.accounts')
                            || 'Accounts'
                        }
                    >
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="account-switch"
                                    color={bloomTheme.colors.info}
                                />
                            }
                            title={
                                t('accounts.manage.switch.title')
                                || 'Switch account'
                            }
                            description={
                                accounts.length > 0
                                    ? (
                                        t('accounts.manage.switch.count', {
                                            count: accounts.length,
                                        })
                                        || `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`
                                    )
                                    : (
                                        t('accounts.manage.switch.empty')
                                        || 'Accounts you own or share'
                                    )
                            }
                            onPress={() => openAccountDialog('accounts')}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="account-plus"
                                    color={bloomTheme.colors.primary}
                                />
                            }
                            title={
                                t('accounts.create.title')
                                || 'Create account'
                            }
                            description={
                                t('accounts.manage.create.subtitle')
                                || 'Add an organization, project, or bot'
                            }
                            onPress={() => navigate?.('CreateAccount')}
                        />
                    </SettingsListGroup>
                ) : null}

                {/* Preferences */}
                <SettingsListGroup
                    title={t('manageAccount.sections.preferences') || 'Preferences'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="cog" color={bloomTheme.colors.info} />
                        }
                        title={t('preferences.title') || 'Preferences'}
                        description={
                            t('preferences.subtitle')
                            || 'Theme, motion, and regional settings'
                        }
                        onPress={() => navigate?.('Preferences')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="bell" color={bloomTheme.colors.primary} />
                        }
                        title={t('notifications.title') || 'Notifications'}
                        description={
                            t('notifications.subtitle')
                            || 'Manage push, email, and security alerts'
                        }
                        onPress={() => navigate?.('Notifications')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="translate" color={bloomTheme.colors.primary} />
                        }
                        title={t('language.title') || 'Language'}
                        description={
                            t('language.subtitle') || 'Choose your preferred language'
                        }
                        onPress={() => navigate?.('LanguageSelector')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="apps" color={bloomTheme.colors.info} />
                        }
                        title={t('connectedApps.title') || 'Connected apps'}
                        description={
                            t('connectedApps.subtitle')
                            || 'Manage third-party app access'
                        }
                        onPress={() => navigate?.('ConnectedApps')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="magnify" color={bloomTheme.colors.primary} />
                        }
                        title={
                            t('accountOverview.items.searchSettings.title') || 'Search settings'
                        }
                        description={
                            t('accountOverview.items.searchSettings.subtitle')
                            || 'SafeSearch and personalization'
                        }
                        onPress={() => navigate?.('SearchSettings')}
                    />
                </SettingsListGroup>

                {/* Support */}
                <SettingsListGroup
                    title={t('accountOverview.sections.support') || 'Support'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="help-circle" color={bloomTheme.colors.primary} />
                        }
                        title={t('accountOverview.items.help.title') || 'Help & support'}
                        description={
                            t('accountOverview.items.help.subtitle')
                            || 'Get help and contact support'
                        }
                        onPress={() => navigate?.('HelpSupport')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="message-text"
                                color={bloomTheme.colors.info}
                            />
                        }
                        title={t('feedback.title') || 'Send feedback'}
                        description={
                            t('feedback.subtitle') || 'Tell us what you think'
                        }
                        onPress={() => navigate?.('Feedback')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="information" color={bloomTheme.colors.success} />
                        }
                        title={t('accountOverview.items.about.title') || 'About'}
                        description={
                            t('accountOverview.items.about.subtitle')
                            || 'Version and system details'
                        }
                        onPress={() => navigate?.('AppInfo')}
                    />
                </SettingsListGroup>

                {/* Legal */}
                <SettingsListGroup
                    title={t('manageAccount.sections.legal') || 'Legal'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="shield-check"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={
                            t('accountOverview.items.privacyPolicy.title') || 'Privacy policy'
                        }
                        description={
                            t('accountOverview.items.privacyPolicy.subtitle')
                            || 'How we handle your data'
                        }
                        onPress={() => navigate?.('LegalDocuments', { initialStep: 1 })}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="file-document"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={
                            t('accountOverview.items.termsOfService.title') || 'Terms of service'
                        }
                        description={
                            t('accountOverview.items.termsOfService.subtitle')
                            || 'Terms and conditions of use'
                        }
                        onPress={() => navigate?.('LegalDocuments', { initialStep: 2 })}
                    />
                </SettingsListGroup>

                {/* Danger zone */}
                <SettingsListGroup
                    title={t('manageAccount.sections.dangerZone') || 'Danger zone'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="delete" color={bloomTheme.colors.error} />
                        }
                        title={
                            t('accountOverview.items.deleteAccount.title') || 'Delete account'
                        }
                        description={
                            t('accountOverview.items.deleteAccount.subtitle')
                            || 'Permanently delete your account and all data'
                        }
                        onPress={handleDeleteAccount}
                        destructive
                    />
                </SettingsListGroup>

                {/* Sign out of this account */}
                <SettingsListGroup>
                    <SettingsListItem
                        icon={
                            <SettingsIcon name="logout" color={bloomTheme.colors.error} />
                        }
                        title={
                            t('manageAccount.signOutOfThisAccount')
                            || 'Sign out of this account'
                        }
                        onPress={handleSignOut}
                        destructive
                        showChevron={false}
                        disabled={signingOut}
                        rightElement={
                            signingOut ? (
                                <ActivityIndicator
                                    color={bloomTheme.colors.error}
                                    size="small"
                                />
                            ) : undefined
                        }
                    />
                </SettingsListGroup>

                <View className="items-center mt-space-12 mb-space-8">
                    <Text className="text-text-tertiary text-xs">
                        {t('accountCenter.version', { version: packageInfo.version })
                            || `Version ${packageInfo.version}`}
                    </Text>
                </View>

                <View style={styles.footerSpacer} />
            </View>
        </>
    );
};

// Layout-only styles: flex centering, the absolutely-positioned avatar badge,
// and measured pixel dimensions that no token class can express. Colors,
// spacing, radius, and typography roles live on Bloom components + NativeWind
// token classes.
const styles = StyleSheet.create({
    footerSpacer: {
        height: 24,
    },
});

export default ManageAccountScreen;
