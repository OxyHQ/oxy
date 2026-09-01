import React, { useCallback, useState } from 'react';
import {
    View,
    StyleSheet,
    ActivityIndicator,
    TouchableOpacity,
    Platform,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { ScreenHeader, AccountCard } from '@/components/ui';
import { useOxy } from '@oxyhq/services';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@oxyhq/bloom/theme';
import { useActivityGroups } from '@/hooks/activity/useActivityGroups';
import { ActivityGroup } from '@/components/activity/activity-group';

export default function ActivityScreen() {
    const colors = useColors();
    const { mode } = useTheme();
    const { t } = useTranslation();
    // Auth is enforced by the `(tabs)` layout — we can assume a session here.
    const { isLoading: oxyLoading } = useOxy();
    const handlePressIn = useHapticPress();
    const [refreshing, setRefreshing] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const {
        groups,
        activities,
        formatters,
        isLoading,
        isError,
        error,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        refetch,
    } = useActivityGroups();

    const handleToggleExpand = useCallback((eventId: string) => {
        setExpandedId((current) => (current === eventId ? null : eventId));
    }, []);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await refetch();
        } finally {
            setRefreshing(false);
        }
    }, [refetch]);

    const handleLoadMore = useCallback(() => {
        if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
        }
    }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    const handleRetry = useCallback(() => {
        refetch();
    }, [refetch]);

    const showInitialLoading =
        (isLoading || oxyLoading) && activities.length === 0;
    const isEmpty = !showInitialLoading && !isError && activities.length === 0;

    return (
        <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
            <View
                style={[styles.container, { backgroundColor: colors.background }]}
            >
                <View style={styles.content}>
                    <ScreenHeader
                        title={t('activity.title')}
                        subtitle={t('activity.subtitle')}
                    />

                    {showInitialLoading ? (
                        <View style={styles.centeredState}>
                            <ActivityIndicator size="large" color={colors.tint} />
                            <ThemedText
                                style={[styles.centeredText, { color: colors.text }]}
                            >
                                {t('activity.loading')}
                            </ThemedText>
                        </View>
                    ) : isError ? (
                        <AccountCard>
                            <View style={styles.centeredState}>
                                <MaterialCommunityIcons
                                    name="alert-circle-outline"
                                    size={40}
                                    color={colors.error}
                                    style={styles.emptyIcon}
                                />
                                <ThemedText
                                    style={[styles.emptyTitle, { color: colors.text }]}
                                >
                                    {t('activity.errorTitle')}
                                </ThemedText>
                                <ThemedText
                                    style={[
                                        styles.emptySubtitle,
                                        { color: colors.textSecondary },
                                    ]}
                                >
                                    {error?.message ?? t('activity.errorMessage')}
                                </ThemedText>
                                <TouchableOpacity
                                    style={[
                                        styles.retryButton,
                                        { backgroundColor: colors.tint },
                                    ]}
                                    onPressIn={handlePressIn}
                                    onPress={handleRetry}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('activity.retry')}
                                >
                                    <ThemedText
                                        style={[
                                            styles.retryButtonText,
                                            { color: '#FFFFFF' },
                                        ]}
                                    >
                                        {t('activity.retry')}
                                    </ThemedText>
                                </TouchableOpacity>
                            </View>
                        </AccountCard>
                    ) : isEmpty ? (
                        <AccountCard>
                            <View style={styles.centeredState}>
                                <MaterialCommunityIcons
                                    name="shield-check-outline"
                                    size={40}
                                    color={colors.text}
                                    style={styles.emptyIcon}
                                />
                                <ThemedText
                                    style={[styles.emptyTitle, { color: colors.text }]}
                                >
                                    {t('activity.empty.title')}
                                </ThemedText>
                                <ThemedText
                                    style={[
                                        styles.emptySubtitle,
                                        { color: colors.textSecondary },
                                    ]}
                                >
                                    {t('activity.empty.subtitle')}
                                </ThemedText>
                            </View>
                        </AccountCard>
                    ) : (
                        <>
                            {groups.map((group) => (
                                <ActivityGroup
                                    key={group.id}
                                    group={group}
                                    severityMode={mode}
                                    expandedId={expandedId}
                                    onToggle={handleToggleExpand}
                                    formatters={formatters}
                                    t={t}
                                    onPressIn={handlePressIn}
                                />
                            ))}

                            {hasNextPage && (
                                <View style={styles.loadMoreContainer}>
                                    {isFetchingNextPage ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={colors.tint}
                                        />
                                    ) : (
                                        <TouchableOpacity
                                            style={[
                                                styles.loadMoreButton,
                                                {
                                                    backgroundColor: colors.card,
                                                    borderColor: colors.border,
                                                },
                                            ]}
                                            onPressIn={handlePressIn}
                                            onPress={handleLoadMore}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('activity.loadMore')}
                                        >
                                            <ThemedText
                                                style={[
                                                    styles.loadMoreText,
                                                    { color: colors.text },
                                                ]}
                                            >
                                                {t('activity.loadMore')}
                                            </ThemedText>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            )}
                        </>
                    )}
                </View>
            </View>
        </ScreenContentWrapper>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        padding: 20,
    },
    centeredState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 16,
        gap: 12,
    },
    centeredText: {
        fontSize: 15,
        opacity: 0.7,
    },
    emptyIcon: {
        opacity: 0.6,
    },
    emptyTitle: {
        fontSize: 17,
        fontWeight: Platform.OS === 'web' ? '600' : undefined,
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 14,
        textAlign: 'center',
        maxWidth: 320,
    },
    retryButton: {
        marginTop: 8,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 12,
    },
    retryButtonText: {
        fontSize: 15,
        fontWeight: '600',
    },
    loadMoreContainer: {
        alignItems: 'center',
        paddingVertical: 16,
    },
    loadMoreButton: {
        paddingHorizontal: 24,
        paddingVertical: 10,
        borderRadius: 24,
        borderWidth: 1,
    },
    loadMoreText: {
        fontSize: 14,
        fontWeight: '500',
    },
});
