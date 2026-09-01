import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import type { ReputationTransaction, TrustTier } from '@oxyhq/core';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Chip } from '@oxyhq/bloom/chip';
import { useTheme } from '@oxyhq/bloom/theme';
import { H1, Text } from '@oxyhq/bloom/typography';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import type { BaseScreenProps } from '../../types/navigation';
import { SettingsIcon } from '../../components/SettingsIcon';
import { Loading } from '@oxyhq/bloom/loading';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { useOxy } from '../../context/OxyContext';
import { getTrustTierLabel } from './trustTier';

const TrustCenterScreen: React.FC<BaseScreenProps> = ({
    navigate,
}) => {
    // Reputation/trust is the ACTIVE account's standing (the org/project/bot
    // when switched, else the personal user).
    const { user, oxyServices, isAuthenticated } = useOxy();
    const { t } = useI18n();
    const [reputationTotal, setReputationTotal] = useState<number | null>(null);
    const [trustTier, setTrustTier] = useState<TrustTier | null>(null);
    const [transactions, setTransactions] = useState<ReputationTransaction[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const bloomTheme = useTheme();
    const primaryColor = bloomTheme.colors.primary;

    useEffect(() => {
        if (!user) return;
        setIsLoading(true);
        setError(null);
        Promise.all([
            oxyServices.getReputationBalance(user.id),
            oxyServices.getReputationTransactions(user.id, 20, 0),
        ])
            .then(([balance, txns]) => {
                setReputationTotal(balance.total);
                setTrustTier(balance.trustTier);
                setTransactions(Array.isArray(txns) ? txns : []);
            })
            .catch((err: unknown) => {
                setError(
                    (err instanceof Error ? err.message : null) ||
                        (t('trust.center.loadError') || 'Failed to load reputation data'),
                );
            })
            .finally(() => setIsLoading(false));
    }, [user, oxyServices, t]);

    const trustTierLabel = useMemo(
        () => (trustTier ? getTrustTierLabel(trustTier, t) : null),
        [trustTier, t],
    );

    const title = t('trust.center.title') || 'Trust Center';
    useSurfaceHeader({ title });

    if (!isAuthenticated) {
        return (
                <View className="items-center py-space-40">
                    <Text className="text-text font-medium text-base">
                        {t('common.status.notSignedIn') || 'Not signed in'}
                    </Text>
                </View>
        );
    }

    if (isLoading) {
        return (
                <View className="items-center py-space-40">
                    <Loading size="large" color={primaryColor} />
                </View>
        );
    }

    return (
            <View className="px-screen-margin pt-space-16 pb-space-24">
                {/* Balance hero card */}
                <View className="items-center bg-fill-secondary rounded-radius-20 px-space-20 py-space-24 mb-space-16">
                    <H1 style={{ color: primaryColor }}>{reputationTotal ?? 0}</H1>
                    <Text className="text-text-tertiary text-base mt-space-2 mb-space-12">
                        {t('trust.center.balance') || 'Reputation Balance'}
                    </Text>
                    {trustTierLabel ? (
                        <Chip
                            variant="soft"
                            color="primary"
                            startIcon={
                                <Ionicons
                                    name="shield-checkmark-outline"
                                    size={14}
                                    color={primaryColor}
                                />
                            }
                        >
                            {trustTierLabel}
                        </Chip>
                    ) : null}
                    <Text
                        className="text-text-tertiary text-sm text-center mt-space-16"
                        style={styles.infoText}
                    >
                        {t('trust.center.info') ||
                            'Reputation can only be earned by positive actions in the Oxy Ecosystem. It cannot be sent or received directly.'}
                    </Text>
                </View>

                {/* Trust actions */}
                <SettingsListGroup
                    title={t('trust.center.actions.title') || 'Explore'}
                >
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="trophy"
                                color={bloomTheme.colors.warning}
                            />
                        }
                        title={t('trust.center.actions.leaderboard') || 'Leaderboard'}
                        onPress={() => navigate?.('TrustLeaderboard')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="file-document"
                                color={bloomTheme.colors.info}
                            />
                        }
                        title={t('trust.center.actions.rules') || 'Rules'}
                        onPress={() => navigate?.('TrustRules')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="gift"
                                color={bloomTheme.colors.success}
                            />
                        }
                        title={t('trust.center.actions.rewards') || 'Rewards'}
                        onPress={() => navigate?.('TrustRewards')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="star"
                                color={bloomTheme.colors.primary}
                            />
                        }
                        title={t('trust.center.actions.about') || 'About'}
                        onPress={() => navigate?.('AboutTrust')}
                    />
                    <SettingsListItem
                        icon={
                            <SettingsIcon
                                name="help-circle"
                                color={bloomTheme.colors.secondary}
                            />
                        }
                        title={t('trust.center.actions.faq') || 'FAQ'}
                        onPress={() => navigate?.('TrustFAQ')}
                    />
                </SettingsListGroup>

                {/* Reputation history */}
                <SettingsListGroup
                    title={t('trust.center.history') || 'Reputation History'}
                >
                    {transactions.length === 0 ? (
                        <SettingsListItem
                            icon={
                                <SettingsIcon
                                    name="history"
                                    color={bloomTheme.colors.textTertiary}
                                />
                            }
                            title={
                                t('trust.center.noHistory') || 'No reputation history yet.'
                            }
                            showChevron={false}
                            disabled
                        />
                    ) : (
                        transactions.map((entry) => (
                            <SettingsListItem
                                key={entry.id}
                                icon={
                                    <SettingsIcon
                                        name={
                                            entry.points > 0
                                                ? 'plus-circle'
                                                : 'minus-circle'
                                        }
                                        color={
                                            entry.points > 0
                                                ? bloomTheme.colors.success
                                                : bloomTheme.colors.error
                                        }
                                    />
                                }
                                title={
                                    entry.reason ||
                                    entry.actionType ||
                                    (t('trust.center.noDescription') || 'No description')
                                }
                                description={
                                    `${entry.category}${
                                        entry.createdAt
                                            ? ` · ${new Date(entry.createdAt).toLocaleString()}`
                                            : ''
                                    }`
                                }
                                rightElement={
                                    <Chip
                                        variant="soft"
                                        size="small"
                                        color={entry.points > 0 ? 'success' : 'error'}
                                    >
                                        {`${entry.points > 0 ? '+' : ''}${entry.points}`}
                                    </Chip>
                                }
                                showChevron={false}
                            />
                        ))
                    )}
                </SettingsListGroup>

                {error ? (
                    <Text
                        className="text-sm text-center mt-space-16"
                        style={{ color: bloomTheme.colors.error }}
                    >
                        {error}
                    </Text>
                ) : null}
            </View>
    );
};

// Layout-only styles: the info caption's measured max width. No color, spacing,
// radius, or typography roles live here — those use Bloom token classes.
const styles = StyleSheet.create({
    infoText: {
        maxWidth: 320,
    },
});

export default TrustCenterScreen;
