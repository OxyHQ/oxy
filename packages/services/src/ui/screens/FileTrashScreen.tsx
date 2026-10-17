import type React from 'react';
import { type ComponentRef, useCallback, useMemo, useRef, useState } from 'react';
import { View, type ScrollView } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { toast } from '@oxy.so/bloom/toast';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { useQueryClient } from '@tanstack/react-query';
import type { BaseScreenProps } from '../types/navigation';
import Ionicons from '../icons/Ionicons';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { queryKeys } from '../hooks/queries/queryKeys';
import { removeFileFromCache, useUserFilesInfinite } from '../hooks/queries/useFileQueries';
import { formatFileSize, getFileIcon } from '../utils/fileManagement';
import FileListSection, { type FileListItem } from './fileManagement/FileListSection';
import FileLibraryError from './fileManagement/FileLibraryError';
import { getErrorMessage } from './fileManagement/shared';
import { deletePermanently, restoreFromTrash } from './fileManagement/trashActions';

/**
 * The person's Trash (ADR 0043 D5): the files they moved to trash, most
 * recently trashed first. Each can be restored — served again, back in the
 * library — or deleted permanently, after a confirmation (and a second one when
 * an app still uses it). An account's trash never expires, so nothing here
 * disappears on its own; it still counts toward the account's storage.
 */
const FileTrashScreen: React.FC<BaseScreenProps & { userId?: string }> = ({ userId }) => {
  const { user, oxyServices } = useOxy();
  const { t } = useI18n();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const ownerId = userId || user?.id;

  const trashQuery = useUserFilesInfinite(ownerId, 'trash');
  const files = useMemo(
    () => trashQuery.data?.pages.flatMap((page) => page.files) ?? [],
    [trashQuery.data],
  );
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // The file an action is in flight for: its buttons show progress.
  const [busy, setBusy] = useState<{ id: string; restoring: boolean } | null>(null);

  // Both lists change: a restored file returns to the library, a deleted one
  // leaves the trash. `files.all` covers both keys.
  const refreshFiles = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
  }, [queryClient]);

  const handleRestore = useCallback(
    async (fileId: string) => {
      setBusy({ id: fileId, restoring: true });
      try {
        const outcome = await restoreFromTrash(oxyServices.assets, fileId);
        if (outcome === 'restored') {
          toast.success(t('fileManagement.toasts.restored'));
        } else {
          toast.error(t('fileManagement.toasts.notInTrash'));
        }
        removeFileFromCache(queryClient, ownerId, fileId, 'trash');
        refreshFiles();
      } catch (error: unknown) {
        toast.error(getErrorMessage(error) || t('fileManagement.toasts.restoreFailed'));
      } finally {
        setBusy(null);
      }
    },
    [oxyServices, queryClient, ownerId, refreshFiles, t],
  );

  const handleDeleteForever = useCallback(
    async (fileId: string, filename: string) => {
      const confirmed = await surfaces.confirm({
        title: t('fileManagement.trashView.deleteForever'),
        description: t('fileManagement.confirms.deleteForever', { filename }),
        confirmLabel: t('fileManagement.trashView.deleteForever'),
        cancelLabel: t('common.cancel') || 'Cancel',
        destructive: true,
      });
      if (!confirmed) return;

      setBusy({ id: fileId, restoring: false });
      try {
        const outcome = await deletePermanently(oxyServices.assets, fileId, (uses) =>
          surfaces.confirm({
            title: t('fileManagement.trashView.deleteForever'),
            description: t('fileManagement.confirms.deleteForeverInUse', {
              filename,
              count: uses,
            }),
            confirmLabel: t('fileManagement.trashView.deleteForever'),
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
          }),
        );
        if (outcome === 'cancelled') return;
        if (outcome === 'deleted') toast.success(t('fileManagement.toasts.deletedForever'));
        removeFileFromCache(queryClient, ownerId, fileId, 'trash');
        refreshFiles();
      } catch (error: unknown) {
        toast.error(getErrorMessage(error) || t('fileManagement.toasts.deleteFailed'));
      } finally {
        setBusy(null);
      }
    },
    [oxyServices, queryClient, ownerId, refreshFiles, t],
  );

  const items = useMemo<FileListItem[]>(
    () =>
      files.map((file) => {
        const trashedOn = file.trashedAt ? new Date(file.trashedAt).toLocaleDateString() : null;
        return {
          id: file.id,
          icon: <Ionicons name={getFileIcon(file.contentType)} size={20} color={colors.primary} />,
          title: file.filename,
          description: trashedOn
            ? `${formatFileSize(file.length)} • ${t('fileManagement.trashView.trashedOn', { date: trashedOn })}`
            : formatFileSize(file.length),
          // A trashed file is not served, so there is nothing to open.
          onPress: () => {},
          rightElement: (
            <View className="flex-row items-center gap-1.5 ml-3">
              <Button
                appearance="subtle"
                tone="neutral"
                size="sm"
                iconOnly
                stopPropagation
                disabled={busy !== null && busy.id !== file.id}
                loading={busy?.id === file.id && busy.restoring}
                accessibilityLabel={t('fileManagement.trashView.a11y.restore', {
                  name: file.filename,
                })}
                onPress={() => handleRestore(file.id)}
                icon={<Ionicons name="arrow-undo" size={18} color={colors.text} />}
              />
              <Button
                appearance="subtle"
                tone="danger"
                size="sm"
                iconOnly
                stopPropagation
                disabled={busy !== null && busy.id !== file.id}
                loading={busy?.id === file.id && !busy.restoring}
                accessibilityLabel={t('fileManagement.trashView.a11y.deleteForever', {
                  name: file.filename,
                })}
                onPress={() => handleDeleteForever(file.id, file.filename)}
                icon={<Ionicons name="trash" size={18} color={colors.error} />}
              />
            </View>
          ),
        };
      }),
    [files, colors, busy, handleRestore, handleDeleteForever, t],
  );

  useSurfaceHeader({
    title: t('fileManagement.trashView.title'),
    subtitle: t('fileManagement.trashView.subtitle'),
    largeTitle: false,
  });

  const hasLoadError = trashQuery.isError && files.length === 0;
  const renderEmptyState = () =>
    hasLoadError ? (
      <FileLibraryError
        title={t('fileManagement.trashView.loadError')}
        description={t('fileManagement.loadError.description')}
        retryLabel={t('fileManagement.retry')}
        onRetry={() => trashQuery.refetch()}
        iconColor={colors.error}
        titleColor={colors.text}
        descriptionColor={colors.textSecondary}
      />
    ) : trashQuery.isLoading || !ownerId ? null : (
      <View className="items-center py-[40px] px-[24px]">
        <Ionicons name="trash-outline" size={64} color={colors.textTertiary} />
        <Text
          className="text-[24px] font-bold mt-[16px] mb-[8px] text-center"
          style={{ color: colors.text }}
        >
          {t('fileManagement.trashView.emptyTitle')}
        </Text>
        <Text
          className="text-[16px] text-center leading-[24px]"
          style={{ color: colors.textSecondary }}
        >
          {t('fileManagement.trashView.emptyDescription')}
        </Text>
      </View>
    );

  return (
    <View className="flex-1">
      {files.length > 0 && (
        <Text
          className="text-[13px] leading-[18px] mx-[16px] mt-[4px] mb-[12px]"
          style={{ color: colors.textSecondary }}
        >
          {t('fileManagement.trashView.notice')}
        </Text>
      )}
      <FileListSection
        scrollViewRef={scrollViewRef}
        filteredFiles={files}
        searchQuery=""
        items={items}
        paging={{
          loadingMore: trashQuery.isFetchingNextPage,
          hasMore: trashQuery.hasNextPage ?? false,
        }}
        refreshing={trashQuery.isRefetching}
        colors={colors}
        t={t}
        onRefresh={() => trashQuery.refetch()}
        onLoadMore={() => trashQuery.fetchNextPage()}
        onClearSearch={() => {}}
        renderEmptyState={renderEmptyState}
      />
    </View>
  );
};

export default FileTrashScreen;
