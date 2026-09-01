import React, { useMemo } from 'react';
import { View, Linking } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxyhq/bloom/toast';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

const HelpSupportScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
    navigate,
}) => {
    const { t } = useI18n();

    useSurfaceHeader({ title: t('help.title') || 'Help & Support' });
    const bloomTheme = useTheme();

    const handleContactSupport = useMemo(() => () => {
        Linking.openURL('mailto:support@oxy.so?subject=Support Request').catch(() => {
            toast.error(t('help.contactError') || 'Failed to open email client');
        });
    }, [t]);

    const handleFAQ = useMemo(() => () => {
        if (navigate) {
            navigate('FAQ');
        } else {
            toast.info(t('help.faqComing') || 'FAQ coming soon');
        }
    }, [navigate, t]);

    const handleReportBug = useMemo(() => () => {
        Linking.openURL('mailto:bugs@oxy.so?subject=Bug Report').catch(() => {
            toast.error(t('help.reportError') || 'Failed to open email client');
        });
    }, [t]);

    const handleDocumentation = useMemo(() => () => {
        Linking.openURL('https://developer.oxy.so/docs').catch(() => {
            toast.error(t('help.linkError') || 'Failed to open link');
        });
    }, [t]);

    const handleCommunity = useMemo(() => () => {
        Linking.openURL('https://community.oxy.so').catch(() => {
            toast.error(t('help.linkError') || 'Failed to open link');
        });
    }, [t]);

    const handleDevelopersPortal = useMemo(() => () => {
        Linking.openURL('https://developer.oxy.so').catch(() => {
            toast.error(t('help.linkError') || 'Failed to open link');
        });
    }, [t]);

    return (
        <>

            <View className="px-screen-margin pb-space-24">
                    {/* Help Options */}
                    <SettingsListGroup title={t('help.options') || 'Get Help'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="help-circle" color={bloomTheme.colors.info} />}
                            title={t('help.faq.title') || 'Frequently Asked Questions'}
                            description={t('help.faq.subtitle') || 'Find answers to common questions'}
                            onPress={handleFAQ}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="email" color={bloomTheme.colors.success} />}
                            title={t('help.contact.title') || 'Contact Support'}
                            description={t('help.contact.subtitle') || 'Get help from our support team'}
                            onPress={handleContactSupport}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="bug" color={bloomTheme.colors.warning} />}
                            title={t('help.reportBug.title') || 'Report a Bug'}
                            description={t('help.reportBug.subtitle') || 'Help us improve by reporting issues'}
                            onPress={handleReportBug}
                        />
                    </SettingsListGroup>

                    {/* Resources */}
                    <SettingsListGroup title={t('help.resources') || 'Resources'}>
                        <SettingsListItem
                            icon={<SettingsIcon name="file-document" color={bloomTheme.colors.textTertiary} />}
                            title={t('help.documentation.title') || 'Documentation'}
                            description={t('help.documentation.subtitle') || 'User guides and tutorials'}
                            onPress={handleDocumentation}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="account-group" color={bloomTheme.colors.secondary} />}
                            title={t('help.community.title') || 'Community'}
                            description={t('help.community.subtitle') || 'Join our community'}
                            onPress={handleCommunity}
                        />
                        <SettingsListItem
                            icon={<SettingsIcon name="code-tags" color={bloomTheme.colors.error} />}
                            title={t('help.developersPortal.title') || 'Developers Portal'}
                            description={t('help.developersPortal.subtitle') || 'API documentation and developer resources'}
                            onPress={handleDevelopersPortal}
                        />
                    </SettingsListGroup>
                </View>
        </>
    );
};

export default React.memo(HelpSupportScreen);
