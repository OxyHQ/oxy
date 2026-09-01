import React, { useMemo, useCallback, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { AccountCard, ScreenHeader, EmptyStateCard } from '@/components/ui';
import { useOxy } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import { GroupedSection } from '@/components/grouped-section';
import { Section } from '@/components/section';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ClientSession } from '@oxyhq/core';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';

export default function SessionsScreen() {
    const colors = useColors();
    const router = useRouter();
    const { t } = useTranslation();

    // OxyServices integration — auth is enforced by the `(tabs)` layout, so
    // we can assume the session exists here.
    const { sessions, activeSessionId, removeSession, switchSession, isLoading: oxyLoading, refreshSessions } = useOxy();
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const handlePressIn = useHapticPress();

    const handleRefresh = useCallback(async () => {
        if (!refreshSessions) return;
        setRefreshing(true);
        try {
            await refreshSessions();
        } finally {
            setRefreshing(false);
        }
    }, [refreshSessions]);

    const handleGoToManagedAccounts = useCallback(() => {
        router.push('/(tabs)/managed-accounts');
    }, [router]);

    const formatRelativeTime = useRelativeTime();

    // Handle session removal
    const handleRemoveSession = useCallback(async (sessionId: string, isActive: boolean) => {
        if (isActive) {
            toast.warning(t('sessions.remove.currentWarning'));
            return;
        }

        alert(
            t('sessions.remove.confirmTitle'),
            t('sessions.remove.confirmMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.remove'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            setActionLoading(sessionId);
                            await removeSession(sessionId);
                            toast.success(t('sessions.remove.success'));
                        } catch (error) {
                            console.error('Failed to remove session:', error);
                            toast.error(t('sessions.remove.failed'));
                        } finally {
                            setActionLoading(null);
                        }
                    },
                },
            ]
        );
    }, [removeSession, alert, t]);

    // Handle session switch
    const handleSwitchSession = useCallback(async (sessionId: string) => {
        if (sessionId === activeSessionId) return;

        try {
            setActionLoading(sessionId);
            await switchSession(sessionId);
            toast.success(t('sessions.switch.success'));
        } catch (error) {
            console.error('Failed to switch session:', error);
            toast.error(t('sessions.switch.failed'));
        } finally {
            setActionLoading(null);
        }
    }, [switchSession, activeSessionId, t]);

    // Format session items for display
    const sessionItems = useMemo(() => {
        if (!sessions || sessions.length === 0) return [];

        return sessions.map((session: ClientSession) => {
            const isActive = session.sessionId === activeSessionId;
            const isLoading = actionLoading === session.sessionId;

            return {
                id: session.sessionId,
                icon: 'devices',
                iconColor: isActive ? colors.tint : colors.sidebarIconDevices,
                title: t('sessions.item.title', { id: session.deviceId?.substring(0, 8) || session.sessionId.substring(0, 8) }),
                subtitle: isActive
                    ? t('sessions.item.currentActive', { time: formatRelativeTime(session.lastActive, t('common.unknown')) })
                    : t('sessions.item.lastActive', { time: formatRelativeTime(session.lastActive, t('common.unknown')) }),
                customContent: (
                    <View style={styles.sessionActions}>
                        {isActive && (
                            <View style={[styles.activeBadge, { backgroundColor: colors.tint }]}>
                                <Text style={[styles.activeBadgeText, { color: '#FFFFFF' }]}>{t('sessions.item.activeBadge')}</Text>
                            </View>
                        )}
                        {!isActive && (
                            <>
                                <TouchableOpacity
                                    style={[styles.actionButton, { backgroundColor: colors.card }]}
                                    onPressIn={handlePressIn}
                                    onPress={() => handleSwitchSession(session.sessionId)}
                                    disabled={isLoading}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('a11y.switchSession')}
                                    accessibilityState={{ disabled: isLoading }}
                                >
                                    {isLoading ? (
                                        <ActivityIndicator size="small" color={colors.text} />
                                    ) : (
                                        <MaterialCommunityIcons name="swap-horizontal" size={16} color={colors.text} />
                                    )}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.actionButton, { backgroundColor: colors.card }]}
                                    onPressIn={handlePressIn}
                                    onPress={() => handleRemoveSession(session.sessionId, isActive)}
                                    disabled={isLoading}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('a11y.removeSession')}
                                    accessibilityState={{ disabled: isLoading }}
                                >
                                    <MaterialCommunityIcons name="delete-outline" size={16} color={colors.text} />
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                ),
            };
        });
    }, [sessions, activeSessionId, colors, formatRelativeTime, actionLoading, handleRemoveSession, handleSwitchSession, handlePressIn, t]);

    // Show loading state
    if (oxyLoading) {
        return (
            <ScreenContentWrapper>
                <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
                    <ActivityIndicator size="large" color={colors.tint} />
                    <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('sessions.loading')}</ThemedText>
                </View>
            </ScreenContentWrapper>
        );
    }

    return (
        <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
            <View style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.content}>
                    <ScreenHeader title={t('sessions.title')} subtitle={t('sessions.subtitle')} />

                    {sessionItems.length === 0 ? (
                        <EmptyStateCard
                            icon="devices"
                            title={t('sessions.empty.title')}
                            subtitle={t('sessions.empty.subtitle')}
                        />
                    ) : (
                        <AccountCard>
                            <GroupedSection items={sessionItems} />
                        </AccountCard>
                    )}

                    {/* Link to managed accounts */}
                    <Section title="">
                        <AccountCard>
                            <GroupedSection items={[{
                                id: 'managed-accounts-link',
                                icon: 'account-group-outline',
                                iconColor: colors.sidebarIconSharing,
                                title: t('sessions.managedLink.title'),
                                subtitle: t('sessions.managedLink.subtitle'),
                                onPress: handleGoToManagedAccounts,
                                showChevron: true,
                            }]} />
                        </AccountCard>
                    </Section>
                </View>
            </View>
        </ScreenContentWrapper>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    content: {
        padding: 20,
    },
    headerSection: {
        marginBottom: 24,
    },
    title: {
        fontSize: 32,
        fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        opacity: 0.6,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
    },
    loadingText: {
        fontSize: 16,
        opacity: 0.7,
    },
    sessionActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    activeBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
    },
    activeBadgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
    actionButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
});
