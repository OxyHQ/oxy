import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useSettingToggles } from '../hooks/useSettingToggle';
import { useOxy } from '../context/OxyContext';
import type { User } from '@oxy.so/core';

interface SearchSettings {
    safeSearch: boolean;
    searchPersonalization: boolean;
}

const SearchSettingsScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
}) => {
    // Search settings are persisted on the ACTIVE account's profile (the
    // org/project/bot when switched, else the personal user); reads/writes
    // authenticate as the active session, which IS that account.
    const { oxyServices, user } = useOxy();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('searchSettings.title') || 'Search Settings' });
    const bloomTheme = useTheme();
    const [isLoading, setIsLoading] = useState(true);

    // Use the existing useSettingToggles hook for toggle management
    const { values: settings, toggle, savingKeys, setValues } = useSettingToggles<SearchSettings>({
        initialValues: { safeSearch: false, searchPersonalization: true },
        onSave: async (key, value) => {
            if (!user?.id || !oxyServices) return;

            const fieldMap: Record<keyof SearchSettings, string> = {
                safeSearch: 'autoFilter',
                searchPersonalization: 'dataSharing',
            };

            await oxyServices.updateProfile({
                privacySettings: {
                    [fieldMap[key]]: value,
                },
            });
        },
        errorMessage: (key) => t(`searchSettings.${key}.error`) || `Failed to update ${key}`,
    });

    const isSaving = savingKeys.size > 0;

    // Load initial settings
    useEffect(() => {
        const loadSettings = async () => {
            try {
                setIsLoading(true);
                if (user?.id && oxyServices) {
                    const userData = await oxyServices.getCurrentUser() as User & { privacySettings?: { autoFilter?: boolean; dataSharing?: boolean } };
                    const privacySettings = userData?.privacySettings || {};

                    setValues({
                        safeSearch: privacySettings.autoFilter ?? false,
                        searchPersonalization: privacySettings.dataSharing ?? true,
                    });
                }
            } catch (error) {
                if (__DEV__) {
                    console.error('Failed to load search settings:', error);
                }
            } finally {
                setIsLoading(false);
            }
        };

        loadSettings();
    }, [user?.id, oxyServices, setValues]);

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
                    {/* SafeSearch */}
                    <SettingsListGroup title={t('searchSettings.safeSearch.title') || 'SafeSearch'}>
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="shield-search"
                                    color={bloomTheme.colors.success}
                                />
                            }
                            title={t('searchSettings.safeSearch.label') || 'Enable SafeSearch'}
                            description={t('searchSettings.safeSearch.description') || 'Filter out explicit content from search results'}
                            rightElement={
                                <Switch
                                    value={settings.safeSearch}
                                    onValueChange={() => toggle('safeSearch')}
                                    disabled={isSaving}
                                />
                            }
                            showChevron={false}
                        />
                    </SettingsListGroup>

                    {/* Search Personalization */}
                    <SettingsListGroup title={t('searchSettings.personalization.title') || 'Search Personalization'}>
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="account-search"
                                    color={bloomTheme.colors.primary}
                                />
                            }
                            title={t('searchSettings.personalization.label') || 'Personalized Search'}
                            description={t('searchSettings.personalization.description') || 'Use your activity to improve search results'}
                            rightElement={
                                <Switch
                                    value={settings.searchPersonalization}
                                    onValueChange={() => toggle('searchPersonalization')}
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

export default React.memo(SearchSettingsScreen);
