import React, { useState, useCallback } from 'react';
import { View, Linking } from 'react-native';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { logger } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { Loading } from '@oxyhq/bloom/loading';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';

/** Component name used in `logger` context for filtered diagnostics. */
const LOG_COMPONENT = 'LegalDocumentsScreen';

/** Policy URLs from the Oxy Transparency Center. */
const POLICY_URLS = {
    privacy: 'https://oxy.so/company/transparency/policies/privacy',
    terms: 'https://oxy.so/company/transparency/policies/terms-of-service',
    community: 'https://oxy.so/company/transparency/policies/community-guidelines',
    dataRetention: 'https://oxy.so/company/transparency/policies/data-retention',
    contentModeration: 'https://oxy.so/company/transparency/policies/content-moderation',
    childSafety: 'https://oxy.so/company/transparency/policies/child-safety',
    cookie: 'https://oxy.so/company/transparency/policies/cookies',
} as const;

type PolicyKey = keyof typeof POLICY_URLS;

/**
 * Map a deep-link `initialStep` to the policy it should auto-open. `null` means
 * "show the full list" (no deep link). Kept as an explicit lookup so the
 * deep-link contract is obvious at a glance.
 */
const STEP_TO_DOCUMENT: Record<number, PolicyKey> = {
    1: 'privacy',
    2: 'terms',
    3: 'community',
    4: 'dataRetention',
    5: 'contentModeration',
    6: 'childSafety',
    7: 'cookie',
};

const LegalDocumentsScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
    initialStep,
}) => {
    const { t } = useI18n();
    const bloomTheme = useTheme();
    const [loading, setLoading] = useState(false);

    // Determine which document to auto-open based on the deep-link step.
    const documentType: PolicyKey | null =
        typeof initialStep === 'number' ? STEP_TO_DOCUMENT[initialStep] ?? null : null;

    // Generic handler to open any policy URL via the system browser.
    const handleOpenPolicy = useCallback(
        (policyKey: PolicyKey) => {
            return async () => {
                try {
                    setLoading(true);
                    const url = POLICY_URLS[policyKey];
                    const canOpen = await Linking.canOpenURL(url);
                    if (canOpen) {
                        await Linking.openURL(url);
                    } else {
                        toast.error(t('legal.openError') || 'Failed to open document');
                    }
                } catch (error) {
                    logger.error(
                        `Failed to open ${policyKey} policy`,
                        error,
                        { component: LOG_COMPONENT },
                    );
                    toast.error(t('legal.openError') || 'Failed to open document');
                } finally {
                    setLoading(false);
                }
            };
        },
        [t],
    );

    // If a specific document type is requested, open it directly.
    React.useEffect(() => {
        if (documentType) {
            handleOpenPolicy(documentType)();
        }
    }, [documentType, handleOpenPolicy]);

    // Localized title for a policy key (used for the deep-link header).
    const getPolicyTitle = (key: PolicyKey): string => {
        const titles: Record<PolicyKey, string> = {
            privacy: t('legal.privacyPolicy.title') || 'Privacy Policy',
            terms: t('legal.termsOfService.title') || 'Terms of Service',
            community: t('legal.communityGuidelines.title') || 'Community Guidelines',
            dataRetention: t('legal.dataRetention.title') || 'Data Retention Policy',
            contentModeration:
                t('legal.contentModeration.title') || 'Content Moderation Policy',
            childSafety: t('legal.childSafety.title') || 'Child Safety Policy',
            cookie: t('legal.cookiePolicy.title') || 'Cookie Policy',
        };
        return titles[key];
    };

    useSurfaceHeader({
        title: documentType ? getPolicyTitle(documentType) : (t('legal.title') || 'Legal Documents'),
    });

    // Deep-link entry: show loading state while the document opens.
    if (documentType) {
        return (
                <Loading
                    size="large"
                    color={bloomTheme.colors.text}
                    text={t('legal.opening') || 'Opening document...'}
                />
        );
    }

    // Default: show the full list of policies & guidelines.
    return (
            <View className="px-screen-margin py-space-16">
                    <SettingsListGroup title={t('legal.policies') || 'Policies & Guidelines'}>
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="shield-check"
                                    color={bloomTheme.colors.success}
                                />
                            }
                            title={t('legal.privacyPolicy.title') || 'Privacy Policy'}
                            description={
                                t('legal.privacyPolicy.subtitle') || 'How we handle your data'
                            }
                            onPress={handleOpenPolicy('privacy')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="file-document"
                                    color={bloomTheme.colors.primary}
                                />
                            }
                            title={t('legal.termsOfService.title') || 'Terms of Service'}
                            description={
                                t('legal.termsOfService.subtitle')
                                || 'Terms and conditions of use'
                            }
                            onPress={handleOpenPolicy('terms')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="account-group"
                                    color={bloomTheme.colors.secondary}
                                />
                            }
                            title={
                                t('legal.communityGuidelines.title') || 'Community Guidelines'
                            }
                            description={
                                t('legal.communityGuidelines.subtitle')
                                || 'Rules and expectations for our community'
                            }
                            onPress={handleOpenPolicy('community')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="clock"
                                    color={bloomTheme.colors.warning}
                                />
                            }
                            title={t('legal.dataRetention.title') || 'Data Retention Policy'}
                            description={
                                t('legal.dataRetention.subtitle')
                                || 'How long we keep your data'
                            }
                            onPress={handleOpenPolicy('dataRetention')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon name="eye" color={bloomTheme.colors.info} />
                            }
                            title={
                                t('legal.contentModeration.title')
                                || 'Content Moderation Policy'
                            }
                            description={
                                t('legal.contentModeration.subtitle')
                                || 'How we moderate content'
                            }
                            onPress={handleOpenPolicy('contentModeration')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon name="heart" color={bloomTheme.colors.error} />
                            }
                            title={t('legal.childSafety.title') || 'Child Safety Policy'}
                            description={
                                t('legal.childSafety.subtitle')
                                || 'Protecting minors on our platform'
                            }
                            onPress={handleOpenPolicy('childSafety')}
                            disabled={loading}
                        />
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="cookie"
                                    color={bloomTheme.colors.textTertiary}
                                />
                            }
                            title={t('legal.cookiePolicy.title') || 'Cookie Policy'}
                            description={
                                t('legal.cookiePolicy.subtitle')
                                || 'How we use cookies and similar technologies'
                            }
                            onPress={handleOpenPolicy('cookie')}
                            disabled={loading}
                        />
                    </SettingsListGroup>
                </View>
    );
};

export default React.memo(LegalDocumentsScreen);
