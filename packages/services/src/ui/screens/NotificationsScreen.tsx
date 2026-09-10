import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import type { NotificationPreferences } from '@oxy.so/core';
import type { BaseScreenProps } from '../types/navigation';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { useCurrentUser } from '../hooks/queries/useAccountQueries';
import { useUpdateNotificationPreferences } from '../hooks/mutations/useAccountMutations';
import { useSettingToggles } from '../hooks/useSettingToggle';

interface NotificationToggleValues {
    pushEnabled: boolean;
    emailDigest: boolean;
    securityAlerts: boolean;
    marketingEmails: boolean;
}

const DEFAULT_VALUES: NotificationToggleValues = {
    pushEnabled: true,
    emailDigest: true,
    securityAlerts: true,
    marketingEmails: false,
};

/**
 * NotificationsScreen — manage per-channel notification preferences.
 *
 * Persists every toggle change via `useUpdateNotificationPreferences`, which
 * uses optimistic updates + offline-queue support. The initial values seed
 * from the current user's `notificationPreferences` field, defaulting to the
 * platform defaults when the field has never been set.
 */
const NotificationsScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => {
    const bloomTheme = useTheme();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('notifications.title') || 'Notifications' });
    const { isAuthenticated } = useOxy();
    const { data: user } = useCurrentUser({ enabled: isAuthenticated });
    const updateMutation = useUpdateNotificationPreferences();

    const initialValues = useMemo<NotificationToggleValues>(() => {
        const prefs = user?.notificationPreferences;
        return {
            pushEnabled: prefs?.pushEnabled ?? DEFAULT_VALUES.pushEnabled,
            emailDigest: prefs?.emailDigest ?? DEFAULT_VALUES.emailDigest,
            securityAlerts: prefs?.securityAlerts ?? DEFAULT_VALUES.securityAlerts,
            marketingEmails: prefs?.marketingEmails ?? DEFAULT_VALUES.marketingEmails,
        };
    }, [user?.notificationPreferences]);

    const handleSave = useCallback(
        async (key: keyof NotificationToggleValues, value: boolean) => {
            const patch: Partial<NotificationPreferences> = { [key]: value };
            await updateMutation.mutateAsync(patch);
        },
        [updateMutation],
    );

    const { values, toggle, savingKeys } = useSettingToggles<NotificationToggleValues>({
        initialValues,
        onSave: handleSave,
        errorMessage: t('notifications.updateError') || 'Failed to update notification preferences',
    });

    const isSaving = savingKeys.size > 0;

    return (
        <>
            <View className="px-screen-margin pb-space-24">
                    <SettingsListGroup
                        title={t('notifications.sections.channels') || 'Channels'}
                    >
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="bell"
                                    color={bloomTheme.colors.primary}
                                />
                            }
                            title={t('notifications.items.push.title') || 'Push notifications'}
                            description={
                                t('notifications.items.push.subtitle')
                                || 'Real-time alerts on your devices'
                            }
                            rightElement={
                                <Switch
                                    value={values.pushEnabled}
                                    onValueChange={() => toggle('pushEnabled')}
                                    disabled={isSaving}
                                />
                            }
                            showChevron={false}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="email"
                                    color={bloomTheme.colors.info}
                                />
                            }
                            title={t('notifications.items.emailDigest.title') || 'Email digest'}
                            description={
                                t('notifications.items.emailDigest.subtitle')
                                || 'Periodic summary of your account activity'
                            }
                            rightElement={
                                <Switch
                                    value={values.emailDigest}
                                    onValueChange={() => toggle('emailDigest')}
                                    disabled={isSaving}
                                />
                            }
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    <SettingsListGroup
                        title={t('notifications.sections.alerts') || 'Alerts'}
                    >
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="shield-check"
                                    color={bloomTheme.colors.success}
                                />
                            }
                            title={
                                t('notifications.items.securityAlerts.title') || 'Security alerts'
                            }
                            description={
                                t('notifications.items.securityAlerts.subtitle')
                                || 'Sign-ins, recovery codes, and key changes'
                            }
                            rightElement={
                                <Switch
                                    value={values.securityAlerts}
                                    onValueChange={() => toggle('securityAlerts')}
                                    disabled={isSaving}
                                />
                            }
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    <SettingsListGroup
                        title={t('notifications.sections.marketing') || 'Marketing'}
                    >
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="bullhorn"
                                    color={bloomTheme.colors.secondary}
                                />
                            }
                            title={
                                t('notifications.items.marketingEmails.title')
                                || 'Marketing emails'
                            }
                            description={
                                t('notifications.items.marketingEmails.subtitle')
                                || 'Product news and occasional offers'
                            }
                            rightElement={
                                <Switch
                                    value={values.marketingEmails}
                                    onValueChange={() => toggle('marketingEmails')}
                                    disabled={isSaving}
                                />
                            }
                            showChevron={false}
                        />
                    </SettingsListGroup>
                </View>
        </>
    );
};

export default React.memo(NotificationsScreen);
