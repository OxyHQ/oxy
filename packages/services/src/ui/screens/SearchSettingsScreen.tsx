import React, { useEffect } from 'react';
import { View } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useUpdatePrivacySettings } from '../hooks/mutations/useAccountMutations';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '../context/oxyRuntimeContext';
import { usePrivacySettings } from '../hooks/queries/useAccountQueries';

interface SearchSettings {
  safeSearch: boolean;
  searchPersonalization: boolean;
}

const SearchSettingsScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => {
  // Search settings are persisted on the ACTIVE account's profile (the
  // org/project/bot when switched, else the personal user); reads/writes
  // authenticate as the active session, which IS that account.
  const { user } = useOxy();
  const { t } = useI18n();

  useSurfaceHeader({ title: t('searchSettings.title') || 'Search Settings' });
  const bloomTheme = useTheme();

  const privacyQuery = usePrivacySettings(user?.id);
  const updateSettings = useUpdatePrivacySettings();
  const privacy = privacyQuery.data ?? user?.privacySettings;
  const settings: SearchSettings = {
    safeSearch: privacy?.autoFilter ?? true,
    searchPersonalization: privacy?.dataSharing ?? true,
  };
  const isSaving = updateSettings.isPending;
  const isLoading = !user?.id || privacyQuery.isPending;
  const toggle = (key: keyof SearchSettings) => {
    if (isSaving || isLoading) return;
    const field = key === 'safeSearch' ? 'autoFilter' : 'dataSharing';
    updateSettings.mutate({ userId: user.id, settings: { [field]: !settings[key] } });
  };
  useEffect(() => {
    if (privacyQuery.error) toast.error(t('privacySettings.loadError'));
  }, [privacyQuery.error, t]);

  return (
    <>
      <View className="px-screen-margin pb-space-24">
        {/* SafeSearch */}
        <GroupedSection title={t('searchSettings.safeSearch.title') || 'SafeSearch'}>
          <GroupedSectionItem
            icon={<SettingsIcon name="shield-search" color={bloomTheme.colors.success} />}
            title={t('searchSettings.safeSearch.label') || 'Enable SafeSearch'}
            description={
              t('searchSettings.safeSearch.description') ||
              'Filter out explicit content from search results'
            }
            rightElement={
              <Switch
                checked={settings.safeSearch}
                onCheckedChange={() => toggle('safeSearch')}
                disabled={isSaving || isLoading}
              />
            }
            showChevron={false}
          />
        </GroupedSection>

        {/* Search Personalization */}
        <GroupedSection
          title={t('searchSettings.personalization.title') || 'Search Personalization'}
        >
          <GroupedSectionItem
            icon={<SettingsIcon name="account-search" color={bloomTheme.colors.primary} />}
            title={t('searchSettings.personalization.label') || 'Personalized Search'}
            description={
              t('searchSettings.personalization.description') ||
              'Use your activity to improve search results'
            }
            rightElement={
              <Switch
                checked={settings.searchPersonalization}
                onCheckedChange={() => toggle('searchPersonalization')}
                disabled={isSaving || isLoading}
              />
            }
            showChevron={false}
          />
        </GroupedSection>
      </View>
    </>
  );
};

export default React.memo(SearchSettingsScreen);
