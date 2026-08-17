import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import type { ConnectedApp } from '@oxyhq/core';
import { logger as loggerUtil } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { Text } from '@oxyhq/bloom/typography';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { useConnectedApps } from '../hooks/queries/useAccountQueries';
import { useRevokeConnectedApp } from '../hooks/mutations/useAccountMutations';

const APP_ICON_SIZE = 40;

/**
 * Format an ISO-8601 timestamp as a human-readable relative time. Mirrors the
 * formatter used in ManageAccountScreen — kept local to avoid pulling a new
 * shared module into the package public surface for one consumer.
 */
const formatRelative = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    const diffMs = Date.now() - date.getTime();
    const absMin = Math.abs(diffMs) / 60000;
    if (absMin < 1) return 'just now';
    if (absMin < 60) return `${Math.floor(absMin)}m ago`;
    const hrs = absMin / 60;
    if (hrs < 24) return `${Math.floor(hrs)}h ago`;
    const days = hrs / 24;
    if (days < 7) return `${Math.floor(days)}d ago`;
    return date.toLocaleDateString();
};

/**
 * ConnectedAppsScreen — list and revoke connected OAuth applications.
 *
 * Fetches via `useConnectedApps` (drives `GET /auth/grants`) and exposes a
 * "Revoke" action that hits `DELETE /auth/grants/:applicationId`. Each revoke
 * invalidates the connected-apps query so the list refreshes immediately.
 */
const ConnectedAppsScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => {
    const bloomTheme = useTheme();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('connectedApps.title') || 'Connected apps' });
    const { isAuthenticated } = useOxy();
    const {
        data: apps,
        isLoading,
        refetch,
        isRefetching,
    } = useConnectedApps({ enabled: isAuthenticated });
    const revokeMutation = useRevokeConnectedApp();
    const [revokingAppId, setRevokingAppId] = useState<string | null>(null);

    const confirmRevoke = useCallback(
        async (app: ConnectedApp) => {
            const confirmed = await surfaces.confirm({
                title: t('connectedApps.confirm.title') || 'Revoke access',
                description:
                    t('connectedApps.confirm.message', { name: app.name })
                    || `Revoke ${app.name}'s access to your Oxy account?`,
                confirmLabel: t('common.revoke') || 'Revoke',
                cancelLabel: t('common.cancel') || 'Cancel',
                destructive: true,
            });
            if (!confirmed) {
                return;
            }
            setRevokingAppId(app.applicationId);
            try {
                await revokeMutation.mutateAsync(app.applicationId);
                toast.success(
                    t('connectedApps.toasts.revoked', { name: app.name })
                    || `Revoked access for ${app.name}`,
                );
            } catch (error) {
                loggerUtil.warn(
                    'Revoke connected app failed',
                    { component: 'ConnectedAppsScreen' },
                    error,
                );
                toast.error(
                    t('connectedApps.toasts.revokeFailed')
                    || 'Failed to revoke access',
                );
            } finally {
                setRevokingAppId(null);
            }
        },
        [revokeMutation, t],
    );

    const renderEmpty = useCallback(
        () => (
            <View className="flex-1 items-center justify-center py-space-32">
                <Text className="text-text-secondary text-center p-space-40">
                    {t('connectedApps.empty.subtitle')
                        || 'Apps you authorize to sign in with your Oxy account will appear here'}
                </Text>
            </View>
        ),
        [t],
    );

    const renderItem = useCallback(
        ({ item }: { item: ConnectedApp }) => {
            const isRevoking = revokingAppId === item.applicationId;
            return (
                <SettingsListGroup>
                    <SettingsListItem
                        icon={<Avatar name={item.name} size={APP_ICON_SIZE} />}
                        title={item.name}
                        description={
                            t('connectedApps.item.granted', {
                                relative: formatRelative(item.firstGrantedAt),
                            })
                        }
                        onPress={isRevoking ? undefined : () => confirmRevoke(item)}
                        disabled={isRevoking}
                        destructive
                        showChevron={false}
                        rightElement={
                            isRevoking ? (
                                <ActivityIndicator
                                    color={bloomTheme.colors.error}
                                    size="small"
                                />
                            ) : undefined
                        }
                    />
                </SettingsListGroup>
            );
        },
        [bloomTheme.colors.error, confirmRevoke, revokingAppId, t],
    );

    return (
        <View className="flex-1 bg-bg">
            {isLoading && !apps ? (
                <Loading size="large" color={bloomTheme.colors.primary} />
            ) : (
                <FlatList
                    data={apps ?? []}
                    keyExtractor={(item) => item.applicationId}
                    renderItem={renderItem}
                    contentContainerClassName="px-screen-margin py-space-16"
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={renderEmpty}
                    refreshControl={
                        <RefreshControl
                            refreshing={isRefetching}
                            onRefresh={refetch}
                            tintColor={bloomTheme.colors.primary}
                        />
                    }
                />
            )}
        </View>
    );
};

// Layout-only style: `flexGrow` lets the FlatList content fill the viewport so
// the empty state centers vertically. Not expressible as a Bloom token class —
// all colors, spacing, radius, and typography live on token classes + Bloom
// components.
const styles = StyleSheet.create({
    listContent: {
        flexGrow: 1,
    },
});

export default React.memo(ConnectedAppsScreen);
