import type React from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    RefreshControl,
    ActivityIndicator,
} from 'react-native';
import Ionicons from '../../icons/Ionicons';
import type { FileMetadata } from '@oxyhq/core';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import type { useTheme } from '@oxyhq/bloom/theme';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

/** A pre-built list row descriptor (produced by the orchestrator's memo). */
export interface FileListItem {
    id: string;
    icon?: React.ReactNode;
    title: string;
    description?: string;
    onPress: () => void;
    rightElement?: React.ReactNode;
}

export interface FileListSectionProps {
    scrollViewRef: React.RefObject<ScrollView | null>;
    filteredFiles: FileMetadata[];
    searchQuery: string;
    items: FileListItem[];
    paging: { loadingMore: boolean; hasMore: boolean };
    refreshing: boolean;
    colors: ThemeColors;
    t: (key: string, vars?: Record<string, string | number>) => string;
    onRefresh: () => void;
    onLoadMore: () => void;
    onClearSearch: () => void;
    /** Rendered when there are no files at all (not a search miss). */
    renderEmptyState: () => React.ReactNode;
}

/**
 * The non-photo file list (list-style `all`/`videos`/`documents`/`audio`
 * views). Extracted verbatim from FileManagementScreen — the orchestrator
 * still owns the item construction and pagination logic and threads them in.
 */
const FileListSection: React.FC<FileListSectionProps> = ({
    scrollViewRef,
    filteredFiles,
    searchQuery,
    items,
    paging,
    refreshing,
    colors,
    t,
    onRefresh,
    onLoadMore,
    onClearSearch,
    renderEmptyState,
}) => {
    return (
        <ScrollView
            ref={scrollViewRef}
            className="flex-1"
            style={{ flex: 1 }}
            contentContainerClassName="px-space-12 pt-0 pb-space-12"
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={colors.primary}
                />
            }
            onScroll={({ nativeEvent }) => {
                const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                if (distanceFromBottom < 200 && !paging.loadingMore && paging.hasMore) {
                    onLoadMore();
                }
            }}
            scrollEventThrottle={250}
        >
            {filteredFiles.length === 0 && searchQuery.length > 0 ? (
                <View className="items-center py-10 px-space-24">
                    <Ionicons name="search" size={64} color={colors.textTertiary} />
                    <Text className="text-[24px] font-bold mt-space-16 mb-space-8" style={{ color: colors.text }}>{t('fileManagement.noResults.title')}</Text>
                    <Text className="text-[16px] text-center leading-[24px] mb-space-32" style={{ color: colors.textSecondary }}>
                        {t('fileManagement.noResults.description', { query: searchQuery })}
                    </Text>
                    <TouchableOpacity
                        className="flex-row items-center px-space-24 py-space-12 rounded-[24px] gap-space-8"
                        style={{ backgroundColor: colors.primary }}
                        onPress={onClearSearch}
                    >
                        <Ionicons name="refresh" size={20} color="#FFFFFF" />
                        <Text className="text-white text-[16px] font-semibold">{t('fileManagement.clearSearch')}</Text>
                    </TouchableOpacity>
                </View>
            ) : filteredFiles.length === 0 ? renderEmptyState() : (
                <>
                    <SettingsListGroup>
                        {items.map(item => (
                            <SettingsListItem
                                key={item.id}
                                icon={item.icon}
                                title={item.title}
                                description={item.description}
                                onPress={item.onPress}
                                showChevron={false}
                                rightElement={item.rightElement}
                            />
                        ))}
                    </SettingsListGroup>
                    {paging.loadingMore && (
                        <View className="flex-row items-center justify-center py-space-12 gap-space-8">
                            <ActivityIndicator size="small" color={colors.primary} />
                            <Text className="text-[13px] font-medium" style={{ color: colors.text }}>{t('fileManagement.loadingMore')}</Text>
                        </View>
                    )}
                </>
            )}
        </ScrollView>
    );
};

export default FileListSection;
