import type React from 'react';
import { View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { H4, Text } from '@oxy.so/bloom/typography';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { BenefitList, BenefitRow } from '@oxy.so/bloom/benefit-list';
import * as Icons from '@oxy.so/bloom/icons';
import type { BaseScreenProps } from '../../types/navigation';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';

const TrustAboutScreen: React.FC<BaseScreenProps> = () => {
    const { t } = useI18n();
    const bloomTheme = useTheme();
    const iconColor = bloomTheme.colors.primary;

    useSurfaceHeader({
        title: t('trust.about.title') || 'About Oxy Trust',
        subtitle: t('trust.about.subtitle') || 'Learn about the reputation system',
    });

    return (
            <View className="px-screen-margin pt-space-16 pb-space-32">
                <View className="items-center py-space-24 gap-space-12">
                    <IconCircle icon={Icons.ShieldCheck_Stroke2_Corner0_Rounded} />
                    <Text className="font-sans text-body text-text-secondary text-center">
                        {t('trust.about.intro') || 'Oxy Trust is a recognition of your positive actions in the Oxy Ecosystem. Reputation cannot be sent or received directly, only earned by contributing to the community.'}
                    </Text>
                </View>

                <H4 className="text-sectionTitle font-sectionTitle text-text-secondary mb-space-12">
                    {t('trust.about.how.title') || 'How to Earn Reputation'}
                </H4>
                <BenefitList
                    className="mb-space-24"
                    accessibilityLabel={t('trust.about.how.title') || 'How to Earn Reputation'}
                >
                    <BenefitRow
                        icon={<Icons.UserCircle_Stroke2_Corner0_Rounded size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.help') || 'Helping other users'}
                    />
                    <BenefitRow
                        icon={<Icons.Flag_Stroke2_Corner0_Rounded size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.report') || 'Reporting bugs'}
                    />
                    <BenefitRow
                        icon={<Icons.PencilLine_Stroke2_Corner0_Rounded size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.contribute') || 'Contributing content'}
                    />
                    <BenefitRow
                        icon={<Icons.Calendar_Stroke2_Corner0_Rounded size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.participate') || 'Participating in events'}
                    />
                    <BenefitRow
                        icon={<Icons.Sparkle_Stroke2_Corner0_Rounded size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.other') || 'Other positive actions'}
                    />
                </BenefitList>

                <H4 className="text-sectionTitle font-sectionTitle text-text-secondary mb-space-12">
                    {t('trust.about.why.title') || 'Why Oxy Trust?'}
                </H4>
                <Text className="font-sans text-body text-text-secondary">
                    {t('trust.about.why.text') || 'Your reputation and trust tier unlock special features and recognition in the Oxy Ecosystem. The more you contribute, the more you earn!'}
                </Text>
            </View>
    );
};

export default TrustAboutScreen;
