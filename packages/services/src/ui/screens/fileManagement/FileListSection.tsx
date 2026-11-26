import { SpinnerIcon } from '@oxy.so/bloom/loading';
import type React from 'react';
import { View, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import Ionicons from '../../icons/Ionicons';
import type { FileMetadata } from '@oxy.so/core';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { useTheme } from '@oxy.so/bloom/theme';

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
  scrollViewRef: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
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
      style={[styles.fill, { flex: 1 }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
      onScroll={({ nativeEvent }) => {
        const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
        const distanceFromBottom =
          contentSize.height - (contentOffset.y + layoutMeasurement.height);
        if (distanceFromBottom < 200 && !paging.loadingMore && paging.hasMore) {
          onLoadMore();
        }
      }}
      scrollEventThrottle={250}
    >
      {filteredFiles.length === 0 && searchQuery.length > 0 ? (
        <View style={styles.container}>
          <Ionicons name="search" size={64} color={colors.textTertiary} />
          <Text style={[styles.title, { color: colors.text }]}>
            {t('fileManagement.noResults.title')}
          </Text>
          <Text style={[styles.text, { color: colors.textSecondary }]}>
            {t('fileManagement.noResults.description', { query: searchQuery })}
          </Text>
          <Button onPress={onClearSearch}>{t('fileManagement.clearSearch')}</Button>
        </View>
      ) : filteredFiles.length === 0 ? (
        renderEmptyState()
      ) : (
        <>
          <GroupedSection>
            {items.map((item) => (
              <GroupedSectionItem
                key={item.id}
                icon={item.icon}
                title={item.title}
                description={item.description}
                onPress={item.onPress}
                showChevron={false}
                rightElement={item.rightElement}
              />
            ))}
          </GroupedSection>
          {paging.loadingMore && (
            <View style={styles.row}>
              <SpinnerIcon size={16} color={colors.primary} />
              <Text style={[styles.text2, { color: colors.text }]}>
                {t('fileManagement.loadingMore')}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
};

export default FileListSection;

const styles = StyleSheet.create({
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  content: { paddingHorizontal: 12, paddingTop: 0, paddingBottom: 12 },
  container: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 40 },
  title: { marginTop: 16, marginBottom: 8, fontSize: 24, fontWeight: 700 },
  text: { marginBottom: 32, textAlign: 'center', fontSize: 16, lineHeight: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  text2: { fontSize: 13, fontWeight: 500 },
});
