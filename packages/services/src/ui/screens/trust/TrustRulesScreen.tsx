import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { View, Text } from 'react-native';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Chip } from '@oxyhq/bloom/chip';
import { useTheme } from '@oxyhq/bloom/theme';
import { reputationCategoryLabel } from '@oxyhq/core';
import type { ReputationRule, ReputationCategory } from '@oxyhq/contracts';
import type { BaseScreenProps } from '../../types/navigation';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { Loading } from '@oxyhq/bloom/loading';
import { useI18n } from '../../hooks/useI18n';
import { useOxy } from '../../context/OxyContext';

/** Stable display order for rule category sections. */
const CATEGORY_ORDER: ReputationCategory[] = [
    'content',
    'social',
    'trust',
    'moderation',
    'physical',
    'penalty',
    'other',
];

const TrustRulesScreen: React.FC<BaseScreenProps> = () => {
    const { oxyServices } = useOxy();
    const { t, locale } = useI18n();

    useSurfaceHeader({
        title: t('trust.rules.title') || 'Trust Rules',
        subtitle: t('trust.rules.subtitle') || 'How to earn reputation',
    });
    const bloomTheme = useTheme();

    const [rules, setRules] = useState<ReputationRule[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setIsLoading(true);
        setError(null);
        oxyServices.getReputationRules()
            .then((data) => setRules(Array.isArray(data) ? data : []))
            .catch((err: unknown) => setError((err instanceof Error ? err.message : null) || 'Failed to load rules'))
            .finally(() => setIsLoading(false));
    }, [oxyServices]);

    // Group rules by category, preserving a stable section order. Categories
    // with no rules are dropped; unknown categories fall back to "other".
    const groupedRules = useMemo(() => {
        const buckets = new Map<ReputationCategory, ReputationRule[]>();
        for (const rule of rules) {
            const category: ReputationCategory = CATEGORY_ORDER.includes(rule.category)
                ? rule.category
                : 'other';
            const bucket = buckets.get(category);
            if (bucket) {
                bucket.push(rule);
            } else {
                buckets.set(category, [rule]);
            }
        }
        return CATEGORY_ORDER
            .filter((category) => buckets.has(category))
            .map((category) => ({ category, items: buckets.get(category) ?? [] }));
    }, [rules]);

    return (
        <>
            {isLoading ? (
                <Loading size="large" color={bloomTheme.colors.primary} />
            ) : error ? (
                <Text className="text-text-secondary text-base text-center px-screen-margin pt-space-40">
                    {error}
                </Text>
            ) : rules.length === 0 ? (
                <Text className="text-text-secondary text-base text-center px-screen-margin pt-space-40">
                    {t('trust.rules.empty') || 'No rules found.'}
                </Text>
            ) : (
                    <View className="px-screen-margin pb-space-24 pt-space-12">
                        {groupedRules.map(({ category, items }) => (
                            <SettingsListGroup
                                key={category}
                                title={reputationCategoryLabel(locale, category)}
                            >
                                {items.map((rule) => (
                                    <SettingsListItem
                                        key={rule.id}
                                        title={rule.description}
                                        showChevron={false}
                                        rightElement={
                                            <Chip
                                                variant="subtle"
                                                size="small"
                                                color={rule.points > 0 ? 'success' : rule.points < 0 ? 'error' : 'default'}
                                            >
                                                {rule.points > 0 ? `+${rule.points}` : `${rule.points}`}
                                            </Chip>
                                        }
                                        accessibilityLabel={`${rule.description}, ${rule.points > 0 ? '+' : ''}${rule.points} ${t('trust.center.balance') || 'reputation points'}`}
                                    />
                                ))}
                            </SettingsListGroup>
                        ))}
                    </View>
            )}
        </>
    );
};

export default TrustRulesScreen;
