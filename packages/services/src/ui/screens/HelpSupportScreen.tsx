import React, { useMemo, useContext } from 'react';
import { View, Linking } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxy.so/bloom/toast';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { OxySupportContext } from '../context/oxySupportContext';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

const HelpSupportScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
  const { t } = useI18n();
  const { onAskAlia, documentationUrl, aliaAvatar } = useContext(OxySupportContext);

  useSurfaceHeader({ title: t('help.title') || 'Help & Support' });
  const bloomTheme = useTheme();

  const handleContactSupport = useMemo(
    () => () => {
      Linking.openURL('mailto:support@oxy.so?subject=Support Request').catch(() => {
        toast.error(t('help.contactError') || 'Failed to open email client');
      });
    },
    [t],
  );

  const handleDocumentation = useMemo(
    () => () => {
      Linking.openURL(documentationUrl ?? 'https://oxy.so/developers/docs/').catch(() => {
        toast.error(t('help.linkError') || 'Failed to open link');
      });
    },
    [t, documentationUrl],
  );

  const handleCommunity = useMemo(
    () => () => {
      Linking.openURL('https://t.me/OxyHQInc').catch(() => {
        toast.error(t('help.linkError') || 'Failed to open link');
      });
    },
    [t],
  );

  const handleDevelopersPortal = useMemo(
    () => () => {
      Linking.openURL('https://oxy.so/developers/').catch(() => {
        toast.error(t('help.linkError') || 'Failed to open link');
      });
    },
    [t],
  );

  return (
    <View className="px-screen-margin pb-space-24">
      {/* Help Options */}
      <GroupedSection title={t('help.options') || 'Get Help'}>
        {onAskAlia ? (
          <GroupedSectionItem
            icon={aliaAvatar ?? <SettingsIcon name="star" color={bloomTheme.colors.primary} />}
            title={t('help.alia.title')}
            description={t('help.alia.subtitle')}
            onPress={async () => {
              try {
                await onAskAlia();
              } catch {
                toast.error(t('help.alia.openError'));
              }
            }}
          />
        ) : (
          <GroupedSectionItem
            icon={<SettingsIcon name="email" color={bloomTheme.colors.success} />}
            title={t('help.contact.title') || 'Contact Support'}
            description={t('help.contact.subtitle') || 'Get help from our support team'}
            onPress={handleContactSupport}
          />
        )}
        <GroupedSectionItem
          icon={<SettingsIcon name="bug" color={bloomTheme.colors.warning} />}
          title={t('help.reportBug.title') || 'Report a Bug'}
          description={t('help.reportBug.subtitle') || 'Help us improve by reporting issues'}
          onPress={() => navigate?.('ReportBug')}
        />
      </GroupedSection>

      {/* Resources */}
      <GroupedSection title={t('help.resources') || 'Resources'}>
        <GroupedSectionItem
          icon={<SettingsIcon name="file-document" color={bloomTheme.colors.textTertiary} />}
          title={t('help.documentation.title') || 'Documentation'}
          description={t('help.documentation.subtitle') || 'User guides and tutorials'}
          onPress={handleDocumentation}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="account-group" color={bloomTheme.colors.secondary} />}
          title={t('help.community.title') || 'Community'}
          description={t('help.community.subtitle') || 'Join our community'}
          onPress={handleCommunity}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="code-tags" color={bloomTheme.colors.error} />}
          title={t('help.developersPortal.title') || 'Developers Portal'}
          description={
            t('help.developersPortal.subtitle') || 'API documentation and developer resources'
          }
          onPress={handleDevelopersPortal}
        />
      </GroupedSection>
    </View>
  );
};

export default React.memo(HelpSupportScreen);
