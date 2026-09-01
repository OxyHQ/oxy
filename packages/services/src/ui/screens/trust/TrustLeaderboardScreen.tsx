import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View,
    StyleSheet,
    ActivityIndicator,
    FlatList,
    TouchableOpacity,
} from 'react-native';
import type { ReputationLeaderboardEntry } from '@oxyhq/core';
import { getAccountDisplayName, logger } from '@oxyhq/core';
import { useTheme } from '@oxyhq/bloom/theme';
import { H6, Text } from '@oxyhq/bloom/typography';
import { Chip } from '@oxyhq/bloom/chip';
import { Button } from '@oxyhq/bloom/button';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { BaseScreenProps } from '../../types/navigation';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { useOxy } from '../../context/OxyContext';
import { getTrustTierLabel } from './trustTier';

const AVATAR_SIZE = 40;
const EMPTY_ICON_SIZE = 64;
const ERROR_ICON_SIZE = 48;
/** Ranks within the podium (1–3) get a highlighted row surface. */
const PODIUM_RANK = 3;

const TrustLeaderboardScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
    const { oxyServices, user: currentUser } = useOxy();
    const { t, locale } = useI18n();
    const bloomTheme = useTheme();

    const [leaderboard, setLeaderboard] = useState<ReputationLeaderboardEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const currentUserId = currentUser?.id ?? '';

    const loadLeaderboard = useCallback(() => {
        setIsLoading(true);
        setError(null);
        oxyServices
            .getReputationLeaderboard()
            .then((data) => setLeaderboard(Array.isArray(data) ? data : []))
            .catch((err: unknown) => {
                logger.error(
                    'Failed to load trust leaderboard',
                    err instanceof Error ? err : new Error(String(err)),
                    { component: 'TrustLeaderboardScreen' },
                );
                setError(err instanceof Error ? err.message : null);
            })
            .finally(() => setIsLoading(false));
    }, [oxyServices]);

    useEffect(() => {
        loadLeaderboard();
    }, [loadLeaderboard]);

    const title = t('trust.leaderboard.title') || 'Trust Leaderboard';
    const subtitle = t('trust.leaderboard.subtitle') || 'Top contributors in the community';
    useSurfaceHeader({ title, subtitle });

    const handleEntryPress = useCallback(
        (entry: ReputationLeaderboardEntry) => {
            navigate?.('Profile', { userId: entry.user.id, username: entry.user.username });
        },
        [navigate],
    );

    const renderEntry = useCallback(
        ({ item }: { item: ReputationLeaderboardEntry }) => {
            const displayName = getAccountDisplayName(item.user, locale);
            const isViewer = currentUserId !== '' && item.user.id === currentUserId;
            const isPodium = item.rank <= PODIUM_RANK;
            // Viewer's own row and podium ranks get a subtle highlighted surface.
            const highlightClass = isViewer || isPodium ? 'bg-fill-secondary' : '';

            return (
                <TouchableOpacity
                    style={styles.row}
                    className={`px-screen-margin py-space-12 gap-space-12 rounded-radius-12 ${highlightClass}`}
                    onPress={() => handleEntryPress(item)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${displayName}, ${t('trust.leaderboard.rankLabel', { rank: item.rank }) || `rank ${item.rank}`}`}
                >
                    <Text
                        className="text-text-secondary font-bold text-subtitle text-center"
                        style={styles.rank}
                        numberOfLines={1}
                    >
                        {item.rank}
                    </Text>
                    <Avatar
                        source={item.user.avatar ? oxyServices.getFileDownloadUrl(item.user.avatar, 'thumb') : undefined}
                        name={displayName}
                        size={AVATAR_SIZE}
                    />
                    <View style={styles.userColumn}>
                        <Text className="text-text font-medium text-base" numberOfLines={1}>
                            {displayName}
                        </Text>
                        <View style={styles.tierRow} className="mt-space-4">
                            <Chip size="small" variant="soft" color={isPodium ? 'primary' : 'default'}>
                                {getTrustTierLabel(item.trustTier, t)}
                            </Chip>
                        </View>
                    </View>
                    <Text className="text-text font-bold text-base" numberOfLines={1}>
                        {item.total}
                    </Text>
                </TouchableOpacity>
            );
        },
        [oxyServices, locale, currentUserId, handleEntryPress, t],
    );

    const keyExtractor = useCallback(
        (item: ReputationLeaderboardEntry, index: number) => item.user.id || `entry-${index}`,
        [],
    );

    const ItemSeparator = useMemo(
        () => () => <View style={styles.separator} className="border-b border-border-image" />,
        [],
    );

    if (isLoading) {
        return (
            <View className="flex-1 bg-bg">
                <View style={styles.center}>
                    <ActivityIndicator size="large" color={bloomTheme.colors.primary} />
                </View>
            </View>
        );
    }

    if (error) {
        return (
            <View className="flex-1 bg-bg">
                <View style={styles.center} className="px-space-32 gap-space-16">
                    <Ionicons name="alert-circle" size={ERROR_ICON_SIZE} color={bloomTheme.colors.error} />
                    <Text className="text-text-secondary text-base text-center">
                        {error || t('trust.leaderboard.error') || 'Failed to load leaderboard'}
                    </Text>
                    <Button variant="primary" onPress={loadLeaderboard}>
                        {t('common.retry') || 'Retry'}
                    </Button>
                </View>
            </View>
        );
    }

    return (
        <View className="flex-1 bg-bg">
            <FlatList
                data={leaderboard}
                renderItem={renderEntry}
                keyExtractor={keyExtractor}
                contentContainerStyle={styles.listContent}
                className="px-space-8 pt-space-12"
                ItemSeparatorComponent={ItemSeparator}
                ListEmptyComponent={
                    <View style={styles.emptyContainer} className="px-space-32 gap-space-8">
                        <Ionicons name="trophy-outline" size={EMPTY_ICON_SIZE} color={bloomTheme.colors.textSecondary} />
                        <H6 className="text-text text-center mt-space-8">
                            {t('trust.leaderboard.empty') || 'No leaderboard data'}
                        </H6>
                        <Text className="text-text-secondary text-sm text-center">
                            {t('trust.leaderboard.emptyDesc') || 'Top contributors will appear here as the community grows.'}
                        </Text>
                    </View>
                }
            />
        </View>
    );
};

// Layout-only styles: flex centering, measured rank column width, separator
// inset, and row flex layout. Colors, spacing, radius, and typography roles
// live on Bloom components + NativeWind token classes.
const styles = StyleSheet.create({
    center: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    listContent: {
        flexGrow: 1,
        paddingBottom: 40,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    rank: {
        width: 28,
    },
    userColumn: {
        flex: 1,
    },
    tierRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    // Inset the hairline separator to align with the start of the entry's text
    // content (rank column + avatar + screen margin + gaps).
    separator: {
        marginLeft: 80,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: 80,
    },
});

export default TrustLeaderboardScreen;
