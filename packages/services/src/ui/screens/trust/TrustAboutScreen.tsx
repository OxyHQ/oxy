import type React from 'react';
import { View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { H4, Text } from '@oxy.so/bloom/typography';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { BenefitList, BenefitRow } from '../../components/BenefitList';
// Per glyph, never `@oxy.so/bloom/icons`. That barrel re-exports all 461 Remix
// glyphs and Metro does not tree-shake, so one import of it here re-ships every
// glyph — 313,123 B, measured — to every app in this package's graph, and no
// consumer can opt out of what a dependency asks for.
import { RiAccountCircleLine } from '@oxy.so/bloom/icons/RiAccountCircleLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
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
                    <IconCircle icon={RiShieldCheckLine} />
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
                        icon={<RiAccountCircleLine size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.help') || 'Helping other users'}
                    />
                    <BenefitRow
                        icon={<RiFlagLine size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.report') || 'Reporting bugs'}
                    />
                    <BenefitRow
                        icon={<RiEditLine size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.contribute') || 'Contributing content'}
                    />
                    <BenefitRow
                        icon={<RiCalendarLine size="sm" style={{ color: iconColor }} />}
                        label={t('trust.about.how.participate') || 'Participating in events'}
                    />
                    <BenefitRow
                        icon={<RiSparklingLine size="sm" style={{ color: iconColor }} />}
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
