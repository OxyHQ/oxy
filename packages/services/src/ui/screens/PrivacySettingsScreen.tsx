import React, { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxy.so/bloom/toast';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useSettingToggles } from '../hooks/useSettingToggle';
import type { BlockedUser, RestrictedUser } from '@oxy.so/core';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useOxy } from '../context/OxyContext';
import { usePrivacySettings } from '../hooks/queries/useAccountQueries';
import { queryKeys } from '../hooks/queries/queryKeys';

interface PrivacySettings {
    isPrivateAccount: boolean;
    hideOnlineStatus: boolean;
    hideLastSeen: boolean;
    profileVisibility: boolean;
    loginAlerts: boolean;
    blockScreenshots: boolean;
    login: boolean;
    biometricLogin: boolean;
    showActivity: boolean;
    allowTagging: boolean;
    allowMentions: boolean;
    hideReadReceipts: boolean;
    allowDirectMessages: boolean;
    dataSharing: boolean;
    locationSharing: boolean;
    analyticsSharing: boolean;
    sensitiveContent: boolean;
    autoFilter: boolean;
    muteKeywords: boolean;
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
    isPrivateAccount: false,
    hideOnlineStatus: false,
    hideLastSeen: false,
    profileVisibility: true,
    loginAlerts: true,
    blockScreenshots: false,
    login: true,
    biometricLogin: false,
    showActivity: true,
    allowTagging: true,
    allowMentions: true,
    hideReadReceipts: false,
    allowDirectMessages: true,
    dataSharing: true,
    locationSharing: false,
    analyticsSharing: true,
    sensitiveContent: false,
    autoFilter: true,
    muteKeywords: false,
};

const PrivacySettingsScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
}) => {
    // Privacy settings belong to the ACTIVE account (the org/project/bot when
    // switched, else the personal user).
    const { oxyServices, user } = useOxy();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('privacySettings.title') || 'Privacy Settings' });
    const bloomTheme = useTheme();
    const queryClient = useQueryClient();

    // Use the existing useSettingToggles hook for toggle management
    const { values: settings, toggle, savingKeys, setValues } = useSettingToggles<PrivacySettings>({
        initialValues: DEFAULT_PRIVACY_SETTINGS,
        onSave: async (key, value) => {
            if (!user?.id || !oxyServices) return;
            await oxyServices.privacy.updateSettings({ [key]: value }, user.id);
        },
        errorMessage: t('privacySettings.updateError') || 'Failed to update privacy setting',
    });

    const isSaving = savingKeys.size > 0;

    // Settings and the block/restrict lists come from React Query, keyed on the
    // active account — switching accounts reads that account's lists.
    const settingsQuery = usePrivacySettings(user?.id);
    const isLoading = Boolean(user?.id) && settingsQuery.isPending;
    useEffect(() => {
        if (settingsQuery.data) setValues(settingsQuery.data);
    }, [settingsQuery.data, setValues]);
    useEffect(() => {
        if (settingsQuery.error) {
            toast.error(t('privacySettings.loadError') || 'Failed to load privacy settings');
        }
    }, [settingsQuery.error, t]);

    const listsKey = useMemo(() => queryKeys.privacy.lists(user?.id), [user?.id]);
    const listsQuery = useQuery({
        queryKey: listsKey,
        enabled: Boolean(oxyServices),
        queryFn: async () => {
            const [blocked, restricted] = await Promise.all([
                oxyServices.privacy.blocked(),
                oxyServices.privacy.restricted(),
            ]);
            return { blocked, restricted };
        },
    });
    const blockedUsers: BlockedUser[] = listsQuery.data?.blocked ?? [];
    const restrictedUsers: RestrictedUser[] = listsQuery.data?.restricted ?? [];
    const isLoadingUsers = listsQuery.isPending;

    const removeFromLists = useCallback((userId: string, list: 'blocked' | 'restricted') => {
        queryClient.setQueryData<{ blocked: BlockedUser[]; restricted: RestrictedUser[] }>(listsKey, (prev) => {
            if (!prev) return prev;
            if (list === 'blocked') {
                return { ...prev, blocked: prev.blocked.filter((u) => (typeof u.blockedId === 'string' ? u.blockedId : u.blockedId._id) !== userId) };
            }
            return { ...prev, restricted: prev.restricted.filter((u) => (typeof u.restrictedId === 'string' ? u.restrictedId : u.restrictedId._id) !== userId) };
        });
    }, [queryClient, listsKey]);

    const handleUnblock = useCallback(async (userId: string) => {
        if (!oxyServices) return;
        try {
            await oxyServices.privacy.unblock(userId);
            removeFromLists(userId, 'blocked');
            toast.success(t('privacySettings.userUnblocked') || 'User unblocked');
        } catch (error) {
            if (__DEV__) {
                console.error('Failed to unblock user:', error);
            }
            toast.error(t('privacySettings.unblockError') || 'Failed to unblock user');
        }
    }, [oxyServices, t, removeFromLists]);

    const handleUnrestrict = useCallback(async (userId: string) => {
        if (!oxyServices) return;
        try {
            await oxyServices.privacy.unrestrict(userId);
            removeFromLists(userId, 'restricted');
            toast.success(t('privacySettings.userUnrestricted') || 'User unrestricted');
        } catch (error) {
            if (__DEV__) {
                console.error('Failed to unrestrict user:', error);
            }
            toast.error(t('privacySettings.unrestrictError') || 'Failed to unrestrict user');
        }
    }, [oxyServices, t, removeFromLists]);

    // Helper to extract user info from blocked/restricted objects.
    const extractUserInfo = useCallback((
        item: BlockedUser | RestrictedUser,
        idField: 'blockedId' | 'restrictedId'
    ) => {
        let userIdField: string | { _id: string; username?: string; avatar?: string; name?: { displayName?: string } };
        let userShape: { username?: string; name?: { displayName?: string } };
        let avatar: string | undefined;

        if (idField === 'blockedId' && 'blockedId' in item) {
            userIdField = item.blockedId;
            userShape = typeof item.blockedId === 'string'
                ? { username: item.username }
                : { username: item.blockedId.username, name: item.blockedId.name };
            avatar = typeof item.blockedId === 'string' ? item.avatar : item.blockedId.avatar;
        } else if (idField === 'restrictedId' && 'restrictedId' in item) {
            userIdField = item.restrictedId;
            userShape = typeof item.restrictedId === 'string'
                ? { username: item.username }
                : { username: item.restrictedId.username, name: item.restrictedId.name };
            avatar = typeof item.restrictedId === 'string' ? item.avatar : item.restrictedId.avatar;
        } else {
            return { userId: '', displayName: getNormalizedUserHandle(null) ?? '', avatar: undefined };
        }

        const userId = typeof userIdField === 'string' ? userIdField : userIdField._id;
        return {
            userId,
            displayName: userShape.name?.displayName ?? getNormalizedUserHandle(userShape) ?? '',
            avatar,
        };
    }, []);

    if (isLoading) {
        return (
            <>
                <Loading size="large" color={bloomTheme.colors.text} />
            </>
        );
    }

    return (
        <>

            <View className="px-screen-margin pb-space-24">
                    {/* Account Privacy */}
                    <SettingsListGroup title={t('privacySettings.sections.account') || 'ACCOUNT PRIVACY'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="lock-outline" color={bloomTheme.colors.primary} />}
                            title={t('privacySettings.isPrivateAccount') || 'Private Account'}
                            description={t('privacySettings.isPrivateAccountDesc') || 'Only approved followers can see your posts'}
                            rightElement={<Switch value={settings.isPrivateAccount} onValueChange={() => toggle('isPrivateAccount')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="account-eye-outline" color={bloomTheme.colors.info} />}
                            title={t('privacySettings.profileVisibility') || 'Profile Visibility'}
                            description={t('privacySettings.profileVisibilityDesc') || 'Control who can view your profile'}
                            rightElement={<Switch value={settings.profileVisibility} onValueChange={() => toggle('profileVisibility')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="circle-outline" color={bloomTheme.colors.success} />}
                            title={t('privacySettings.hideOnlineStatus') || 'Hide Online Status'}
                            description={t('privacySettings.hideOnlineStatusDesc') || 'Don\'t show when you\'re online'}
                            rightElement={<Switch value={settings.hideOnlineStatus} onValueChange={() => toggle('hideOnlineStatus')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="clock-outline" color={bloomTheme.colors.secondary} />}
                            title={t('privacySettings.hideLastSeen') || 'Hide Last Seen'}
                            description={t('privacySettings.hideLastSeenDesc') || 'Don\'t show when you were last active'}
                            rightElement={<Switch value={settings.hideLastSeen} onValueChange={() => toggle('hideLastSeen')} disabled={isSaving} />}
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    {/* Interactions */}
                    <SettingsListGroup title={t('privacySettings.sections.interactions') || 'INTERACTIONS'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="tag-outline" color={bloomTheme.colors.primary} />}
                            title={t('privacySettings.allowTagging') || 'Allow Tagging'}
                            description={t('privacySettings.allowTaggingDesc') || 'Let others tag you in posts'}
                            rightElement={<Switch value={settings.allowTagging} onValueChange={() => toggle('allowTagging')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="at" color={bloomTheme.colors.info} />}
                            title={t('privacySettings.allowMentions') || 'Allow Mentions'}
                            description={t('privacySettings.allowMentionsDesc') || 'Let others mention you'}
                            rightElement={<Switch value={settings.allowMentions} onValueChange={() => toggle('allowMentions')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="message-outline" color={bloomTheme.colors.success} />}
                            title={t('privacySettings.allowDirectMessages') || 'Allow Direct Messages'}
                            description={t('privacySettings.allowDirectMessagesDesc') || 'Let others send you direct messages'}
                            rightElement={<Switch value={settings.allowDirectMessages} onValueChange={() => toggle('allowDirectMessages')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="check-all" color={bloomTheme.colors.secondary} />}
                            title={t('privacySettings.hideReadReceipts') || 'Hide Read Receipts'}
                            description={t('privacySettings.hideReadReceiptsDesc') || 'Don\'t show read receipts in messages'}
                            rightElement={<Switch value={settings.hideReadReceipts} onValueChange={() => toggle('hideReadReceipts')} disabled={isSaving} />}
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    {/* Activity & Data */}
                    <SettingsListGroup title={t('privacySettings.sections.activity') || 'ACTIVITY & DATA'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="pulse" color={bloomTheme.colors.primary} />}
                            title={t('privacySettings.showActivity') || 'Show Activity Status'}
                            description={t('privacySettings.showActivityDesc') || 'Display your activity on your profile'}
                            rightElement={<Switch value={settings.showActivity} onValueChange={() => toggle('showActivity')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="database-outline" color={bloomTheme.colors.info} />}
                            title={t('privacySettings.dataSharing') || 'Data Sharing'}
                            description={t('privacySettings.dataSharingDesc') || 'Allow sharing data for personalization'}
                            rightElement={<Switch value={settings.dataSharing} onValueChange={() => toggle('dataSharing')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="map-marker-outline" color={bloomTheme.colors.warning} />}
                            title={t('privacySettings.locationSharing') || 'Location Sharing'}
                            description={t('privacySettings.locationSharingDesc') || 'Share your location'}
                            rightElement={<Switch value={settings.locationSharing} onValueChange={() => toggle('locationSharing')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="chart-line" color={bloomTheme.colors.secondary} />}
                            title={t('privacySettings.analyticsSharing') || 'Analytics Sharing'}
                            description={t('privacySettings.analyticsSharingDesc') || 'Allow analytics data collection'}
                            rightElement={<Switch value={settings.analyticsSharing} onValueChange={() => toggle('analyticsSharing')} disabled={isSaving} />}
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    {/* Content & Safety */}
                    <SettingsListGroup title={t('privacySettings.sections.content') || 'CONTENT & SAFETY'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="eye-off-outline" color={bloomTheme.colors.warning} />}
                            title={t('privacySettings.sensitiveContent') || 'Show Sensitive Content'}
                            description={t('privacySettings.sensitiveContentDesc') || 'Allow sensitive or explicit content'}
                            rightElement={<Switch value={settings.sensitiveContent} onValueChange={() => toggle('sensitiveContent')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="filter-outline" color={bloomTheme.colors.success} />}
                            title={t('privacySettings.autoFilter') || 'Auto Filter'}
                            description={t('privacySettings.autoFilterDesc') || 'Automatically filter inappropriate content'}
                            rightElement={<Switch value={settings.autoFilter} onValueChange={() => toggle('autoFilter')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="volume-off" color={bloomTheme.colors.info} />}
                            title={t('privacySettings.muteKeywords') || 'Mute Keywords'}
                            description={t('privacySettings.muteKeywordsDesc') || 'Hide posts containing muted keywords'}
                            rightElement={<Switch value={settings.muteKeywords} onValueChange={() => toggle('muteKeywords')} disabled={isSaving} />}
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="cellphone-screenshot" color={bloomTheme.colors.secondary} />}
                            title={t('privacySettings.blockScreenshots') || 'Block Screenshots'}
                            description={t('privacySettings.blockScreenshotsDesc') || 'Prevent screenshots of your content'}
                            rightElement={<Switch value={settings.blockScreenshots} onValueChange={() => toggle('blockScreenshots')} disabled={isSaving} />}
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    {/* Blocked Users */}
                    <SettingsListGroup title={t('privacySettings.sections.blockedUsers') || 'BLOCKED USERS'}>
                        {isLoadingUsers ? (
                            <Loading size="small" color={bloomTheme.colors.text} />
                        ) : blockedUsers.length === 0 ? (
                            <Text className="text-text-secondary text-center p-space-40">
                                {t('privacySettings.noBlockedUsers') || 'No blocked users'}
                            </Text>
                        ) : (
                            blockedUsers.map((blocked) => {
                                const { userId, displayName, avatar } = extractUserInfo(blocked, 'blockedId');
                                const avatarUri = avatar && oxyServices ? oxyServices.assets.publicUrl(avatar, 'thumb') : undefined;
                                return (
                                    <SettingsListItem
                                        key={userId}
                                        icon={<Avatar source={avatarUri} name={displayName} size={20} />}
                                        title={displayName}
                                        rightElement={
                                            <Button
                                                appearance="solid" tone="danger"
                                                size="small"
                                                onPress={() => handleUnblock(userId)}
                                            >
                                                {t('privacySettings.unblock') || 'Unblock'}
                                            </Button>
                                        }
                                        showChevron={false}
                                    />
                                );
                            })
                        )}
                    </SettingsListGroup>

                    {/* Restricted Users */}
                    <SettingsListGroup title={t('privacySettings.sections.restrictedUsers') || 'RESTRICTED USERS'}>
                        {isLoadingUsers ? (
                            <Loading size="small" color={bloomTheme.colors.text} />
                        ) : restrictedUsers.length === 0 ? (
                            <Text className="text-text-secondary text-center p-space-40">
                                {t('privacySettings.noRestrictedUsers') || 'No restricted users'}
                            </Text>
                        ) : (
                            restrictedUsers.map((restricted) => {
                                const { userId, displayName, avatar } = extractUserInfo(restricted, 'restrictedId');
                                const avatarUri = avatar && oxyServices ? oxyServices.assets.publicUrl(avatar, 'thumb') : undefined;
                                return (
                                    <SettingsListItem
                                        key={userId}
                                        icon={<Avatar source={avatarUri} name={displayName} size={20} />}
                                        title={displayName}
                                        description={t('privacySettings.restrictedDescription') || 'Limited interactions'}
                                        rightElement={
                                            <Button
                                                appearance="subtle" tone="neutral"
                                                size="small"
                                                onPress={() => handleUnrestrict(userId)}
                                            >
                                                {t('privacySettings.unrestrict') || 'Unrestrict'}
                                            </Button>
                                        }
                                        showChevron={false}
                                    />
                                );
                            })
                        )}
                    </SettingsListGroup>
                </View>
        </>
    );
};

export default React.memo(PrivacySettingsScreen);
