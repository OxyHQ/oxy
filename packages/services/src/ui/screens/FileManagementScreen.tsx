import type React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    RefreshControl,
    TextInput,
    useWindowDimensions,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import type { FileManagementScreenProps } from '../types/fileManagement';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable } from 'react-native';
import type { FileMetadata } from '@oxyhq/core';
import { queryKeys } from '../hooks/queries/queryKeys';
import { useUserFilesInfinite, removeFileFromCache, patchFileMetadataInCache } from '../hooks/queries/useFileQueries';
import { useSurfaceHeader, type SurfaceHeaderContent } from '../hooks/useSurfaceHeader';
import { SurfaceHeaderAction } from '../components/SurfaceHeaderAction';
import JustifiedPhotoGrid from '../components/photogrid/JustifiedPhotoGrid';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useUploadFile } from '../hooks/mutations/useAccountMutations';
import {
    formatFileSize,
    getFileIcon,
} from '../utils/fileManagement';
import { useResolvedFileUrls, fileThumbSource } from '../hooks/useResolvedFileUrls';
import { FileViewer } from '../components/fileManagement/FileViewer';
import { presentFileDetails } from '../components/fileManagement/FileDetailsModal';
import { UploadPreview } from '../components/fileManagement/UploadPreview';
import { presentActionSheet } from '../components/surfaces/ActionSheetSurface';
import { getErrorMessage } from './fileManagement/shared';
import { useFileUploadState } from './fileManagement/hooks/useFileUploadState';
import PhotoPickerView from './fileManagement/PhotoPickerSection';
import FileListSection, { type FileListItem } from './fileManagement/FileListSection';
import FileLibraryError from './fileManagement/FileLibraryError';
import UploadBar from './fileManagement/UploadBar';
import { AnimatedButton } from '../components/fileManagement/AnimatedButton';

// Genuinely-inline-only styles: `viewModeButton` is spread into an Animated.View
// style array (interpolated backgroundColor), and the photo tiles are
// `expo-image` (no className remap). Everything else uses NativeWind classNames.
// Nav-header slot layout for this screen's action row + review-mode back button.
const fmHeaderStyles = StyleSheet.create({
    actionsRow: {
        flexDirection: 'row',
        gap: 8,
    },
    backButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

const screenStyles = StyleSheet.create({
    viewModeButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        minWidth: 36,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 1,
    },
    justifiedPhotoImage: { width: '100%', height: '100%', borderRadius: 6 },
});

const FileManagementScreen: React.FC<FileManagementScreenProps> = ({
    onClose,
    goBack,
    navigate,
    dismiss,
    userId,
    containerWidth,
    selectMode = false,
    multiSelect = false,
    onSelect,
    onPicked,
    onConfirmSelection,
    initialSelectedIds = [],
    maxSelection,
    disabledMimeTypes = [],
    afterSelect = 'close',
    allowUploadInSelectMode = true,
    defaultVisibility = 'private',
    linkContext,
}) => {
    // Use useOxy() hook for OxyContext values. Files are owned by the ACTIVE
    // account (the org/project/bot when switched, else the personal user): the
    // default file owner and every "is this mine?" ownership check resolve
    // against `user`, so switching shows/manages that account's files.
    const { user, oxyServices } = useOxy();
    const { t } = useI18n();
    const queryClient = useQueryClient();
    const uploadFileMutation = useUploadFile();

    // Files are owned by the ACTIVE account. `targetUserId` scopes the query key,
    // so switching accounts (or an explicit `userId` prop) shows that account's
    // library with no manual reset.
    const targetUserId = userId || user?.id;

    // The file list is React Query's, NOT a store: infinite-paginated, fetched on
    // mount + on owner change, edited optimistically via cache helpers. The
    // rendered list is the flattened pages.
    const filesQuery = useUserFilesInfinite(targetUserId);
    const files = useMemo(
        () => filesQuery.data?.pages.flatMap((page) => page.files) ?? [],
        [filesQuery.data],
    );
    // No owner resolved yet reads as "loading" (matches the old skeleton-until-
    // first-load behaviour); `isLoading` is the first-page fetch only.
    const isLoadingFiles = !targetUserId || filesQuery.isLoading;
    const isRefreshingFiles = filesQuery.isRefetching;
    const isFetchingMore = filesQuery.isFetchingNextPage;
    const hasMoreFiles = filesQuery.hasNextPage ?? false;
    // Terminal load failure with nothing cached — render a DISTINCT error state
    // (not the empty state) so a failed load never looks like an empty library.
    const hasLoadError = filesQuery.isError && files.length === 0;
    const invalidateFiles = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.files.list(targetUserId) });
    }, [queryClient, targetUserId]);

    const { width: windowWidth } = useWindowDimensions();
    // Prefer an explicit sheet width from the router; fall back to the window
    // so photo grids never size against a hardcoded 400px default.
    const safeContainerWidth: number =
        typeof containerWidth === 'number' && containerWidth > 0
            ? containerWidth
            : windowWidth;
    // In-flight delete target (local UI state — was in the file store).
    const [deletingId, setDeletingId] = useState<string | null>(null);
    // In selectMode we never open the detailed viewer
    const [openedFile, setOpenedFile] = useState<FileMetadata | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [loadingFileContent, setLoadingFileContent] = useState(false);
    const [showFileDetailsInViewer, setShowFileDetailsInViewer] = useState(false);
    // Reduce-motion preference, read as an external store (no effect). Passed to
    // `PhotoPickerView` to skip cell stagger animations.
    const reduceMotion = useReduceMotion();

    // Image-only picker mode: when the consumer restricts to image MIME types
    // (e.g. avatar picker), photos grid is the more useful default view.
    const isImageOnlyPicker = useMemo(() => {
        if (!selectMode) return false;
        if (disabledMimeTypes.length === 0) return false;
        const blocksVideos = disabledMimeTypes.some(mt => mt === 'video/' || mt.startsWith('video/'));
        const blocksAudio = disabledMimeTypes.some(mt => mt === 'audio/' || mt.startsWith('audio/'));
        const blocksDocs = disabledMimeTypes.some(mt =>
            mt === 'application/pdf' ||
            mt === 'application/' ||
            mt.startsWith('application/')
        );
        return blocksVideos && blocksAudio && blocksDocs;
    }, [disabledMimeTypes, selectMode]);

    const [viewMode, setViewMode] = useState<'all' | 'photos' | 'videos' | 'documents' | 'audio'>(
        isImageOnlyPicker ? 'photos' : 'all',
    );
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'date' | 'size' | 'name' | 'type'>('date');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    // Derived filtered and sorted files (avoid setState loops)
    const filteredFiles = useMemo(() => {
        let filteredByMode = files;
        if (viewMode === 'photos') {
            filteredByMode = files.filter(file => file.contentType.startsWith('image/'));
        } else if (viewMode === 'videos') {
            filteredByMode = files.filter(file => file.contentType.startsWith('video/'));
        } else if (viewMode === 'documents') {
            filteredByMode = files.filter(file =>
                file.contentType.includes('pdf') ||
                file.contentType.includes('document') ||
                file.contentType.includes('text') ||
                file.contentType.includes('msword') ||
                file.contentType.includes('excel') ||
                file.contentType.includes('spreadsheet') ||
                file.contentType.includes('presentation') ||
                file.contentType.includes('powerpoint')
            );
        } else if (viewMode === 'audio') {
            filteredByMode = files.filter(file => file.contentType.startsWith('audio/'));
        }

        let filtered = filteredByMode;
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filteredByMode.filter(file =>
                file.filename.toLowerCase().includes(query) ||
                file.contentType.toLowerCase().includes(query) ||
                (file.metadata?.description?.toLowerCase().includes(query))
            );
        }

        // Sort files
        const sorted = [...filtered].sort((a, b) => {
            let comparison = 0;
            if (sortBy === 'date') {
                const dateA = new Date(a.uploadDate || 0).getTime();
                const dateB = new Date(b.uploadDate || 0).getTime();
                comparison = dateA - dateB;
            } else if (sortBy === 'size') {
                comparison = (a.length || 0) - (b.length || 0);
            } else if (sortBy === 'name') {
                comparison = (a.filename || '').localeCompare(b.filename || '');
            } else if (sortBy === 'type') {
                comparison = (a.contentType || '').localeCompare(b.contentType || '');
            }
            return sortOrder === 'asc' ? comparison : -comparison;
        });

        return sorted;
    }, [files, searchQuery, viewMode, sortBy, sortOrder]);
    // Selection state. `initialSelectedIds` is the INITIAL selection only (lazy
    // init) — there is no prop→state sync effect, since no caller mutates it
    // after mount.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds));
    const scrollViewRef = useRef<ScrollView>(null);
    const photoScrollViewRef = useRef<ScrollView>(null);

    // Scroll the browse list/grid to a just-selected file. Driven directly from
    // the selection event handler (double-rAF so the selection re-render has
    // committed first) — not an effect. No-ops in the image-only picker, whose
    // own FlatList is not either ScrollView ref.
    const scrollToSelectedFile = useCallback((fileId: string) => {
        if (viewMode === 'all' && scrollViewRef.current) {
            const itemIndex = filteredFiles.findIndex(file => file.id === fileId);
            if (itemIndex < 0) return;
            // GroupedItem dense rows are ~65px, +30px when a description wraps.
            const baseItemHeight = 65;
            const descriptionHeight = 30;
            let scrollPosition = 0;
            for (let i = 0; i <= itemIndex && i < filteredFiles.length; i++) {
                scrollPosition += baseItemHeight;
                if (filteredFiles[i].metadata?.description) scrollPosition += descriptionHeight;
            }
            // Offset for the header/controls/search/stats chrome (~250px) so the
            // item lands near the top, not under the chrome.
            const finalScrollPosition = 250 + scrollPosition - 150;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    scrollViewRef.current?.scrollTo({ y: Math.max(0, finalScrollPosition), animated: true });
                });
            });
        } else if (viewMode === 'photos' && photoScrollViewRef.current) {
            const photos = filteredFiles.filter(file => file.contentType.startsWith('image/'));
            const photoIndex = photos.findIndex(p => p.id === fileId);
            if (photoIndex < 0) return;
            // Rough estimate for the justified grid (3 photos/row, variable heights).
            const row = Math.floor(photoIndex / 3);
            const finalScrollPosition = row * (150 + 4) - 100;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    photoScrollViewRef.current?.scrollTo({ y: Math.max(0, finalScrollPosition), animated: true });
                });
            });
        }
    }, [viewMode, filteredFiles]);

    const toggleSelect = useCallback(async (file: FileMetadata) => {
        // Selection is allowed in regular mode too (for bulk operations).
        if (disabledMimeTypes.length) {
            const blocked = disabledMimeTypes.some(mt => file.contentType === mt || file.contentType.startsWith(mt.endsWith('/') ? mt : `${mt}/`));
            if (blocked) {
                toast.error(t('fileManagement.toasts.fileTypeBlocked'));
                return;
            }
        }

        // Update file visibility if it differs from defaultVisibility
        const fileVisibility = (file.metadata as Record<string, unknown> | undefined)?.visibility || 'private';
        if (fileVisibility !== defaultVisibility) {
            try {
                await oxyServices.assetUpdateVisibility(file.id, defaultVisibility);
            } catch (error) {
                // Continue anyway - selection shouldn't fail if visibility update fails
            }
        }

        // Link file to entity if linkContext is provided
        if (linkContext) {
            try {
                await oxyServices.assetLink(
                    file.id,
                    linkContext.app,
                    linkContext.entityType,
                    linkContext.entityId,
                    defaultVisibility,
                    linkContext.webhookUrl
                );
            } catch (error) {
                // Continue anyway - selection shouldn't fail if linking fails
            }
        }

        if (!multiSelect) {
            if (onPicked) {
                // Forward-navigation picker (e.g. the avatar flow): hand the file
                // to the caller, which pushes the NEXT frame (the cropper) on top
                // of this picker. The picker frame stays below so Back returns here
                // to re-pick — no dismiss, no session close.
                onPicked(file);
            } else if (onSelect) {
                // Legacy callback caller (inbox, WelcomeNewUser): keep the
                // callback + afterSelect behaviour unchanged.
                onSelect(file);
                if (afterSelect === 'back') {
                    goBack?.();
                } else if (afterSelect === 'close') {
                    onClose?.();
                }
            } else {
                // Promise-based picker: resolve the surface's present() promise
                // with the picked file.
                dismiss?.(file);
            }
            return;
        }
        setSelectedIds(prev => {
            const next = new Set(prev);
            const already = next.has(file.id);
            if (!already) {
                if (maxSelection && next.size >= maxSelection) {
                    toast.error(t('fileManagement.toasts.maxSelection', { max: maxSelection }));
                    return prev;
                }
                next.add(file.id);
            } else {
                next.delete(file.id);
            }
            return next;
        });
        scrollToSelectedFile(file.id);
    }, [multiSelect, onPicked, onSelect, onClose, goBack, dismiss, disabledMimeTypes, maxSelection, afterSelect, defaultVisibility, oxyServices, linkContext, t, scrollToSelectedFile]);

    const confirmMultiSelection = useCallback(async () => {
        if (!selectMode || !multiSelect) return;
        const map: Record<string, FileMetadata> = {};
        for (const f of files) { map[f.id] = f; }
        const chosen = Array.from(selectedIds).map(id => map[id]).filter(Boolean);

        // Update visibility and link files if needed
        const updatePromises = chosen.map(async (file) => {
            // Update visibility if needed
            const fileVisibility = (file.metadata as Record<string, unknown> | undefined)?.visibility || 'private';
            if (fileVisibility !== defaultVisibility) {
                try {
                    await oxyServices.assetUpdateVisibility(file.id, defaultVisibility);
                } catch (error) {
                    // Visibility update failed, continue with selection
                }
            }

            // Link file to entity if linkContext provided
            if (linkContext) {
                try {
                    await oxyServices.assetLink(
                        file.id,
                        linkContext.app,
                        linkContext.entityType,
                        linkContext.entityId,
                        defaultVisibility,
                        linkContext.webhookUrl
                    );
                } catch (error) {
                    // File linking failed, continue with selection
                }
            }
        });

        // Wait for all updates (but don't block on failures)
        await Promise.allSettled(updatePromises);

        if (onConfirmSelection) {
            // Legacy callback caller (inbox): keep the callback + close.
            onConfirmSelection(chosen);
            onClose?.();
        } else {
            // Promise-based picker: resolve the surface with the chosen files.
            dismiss?.(chosen);
        }
    }, [selectMode, multiSelect, selectedIds, files, onConfirmSelection, onClose, dismiss, defaultVisibility, oxyServices, linkContext]);

    // Private-safe thumbnail URLs for the currently-shown files, resolved in
    // ONE batch per page (not N per-tile) and cached by React Query. Uploads
    // default to private, so the synchronous public-CDN URL would 404 for
    // every private thumbnail.
    const resolvedThumbUrls = useResolvedFileUrls(oxyServices, filteredFiles, user?.id);

    // Image source for a grid tile: the resolved private-safe URL for a
    // persisted file, or the locally-picked preview for an in-flight optimistic
    // entry. Never builds an asset URL from a `temp-…`/uploading id.
    const thumbSourceFor = useCallback(
        (file: FileMetadata): string | undefined => fileThumbSource(file, resolvedThumbUrls),
        [resolvedThumbUrls],
    );

    const bloomTheme = useTheme();
    const { colors } = bloomTheme;
    // FileManagementScreen uses a slightly elevated page background.
    const backgroundColor = colors.backgroundSecondary;
    const borderColor = colors.border;

    // Self-contained document-picking + upload-preview state and handlers.
    // Optimistic uploads edit the file query cache directly (see
    // useFileQueries), so no loader is threaded in.
    const {
        isPickingDocument,
        pendingFiles,
        showUploadPreview,
        uploading,
        uploadProgress,
        handleFileUpload,
        handleConfirmUpload,
        handleCancelUpload,
        removePendingFile,
    } = useFileUploadState({
        targetUserId,
        uploadFileMutation,
        defaultVisibility,
        selectMode,
        multiSelect,
        afterSelect,
        onSelect,
        onPicked,
        goBack,
        onClose,
        imagesOnly: isImageOnlyPicker,
        selectedIds,
        setSelectedIds,
        t,
    });

    const confirmFileDelete = useCallback(async (fileId: string, filename: string) => {
        const confirmed = await surfaces.confirm({
            title: t('fileManagement.deleteFile') || 'Delete File',
            description: t('fileManagement.confirms.deleteFile', { filename }),
            confirmLabel: t('fileManagement.confirm') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) return;

        try {
            setDeletingId(fileId);
            await oxyServices.deleteFile(fileId);

            toast.success(t('fileManagement.toasts.deleteSuccess'));

            // Remove from the query cache, then reconcile against the server.
            removeFileFromCache(queryClient, targetUserId, fileId);
            invalidateFiles();
        } catch (error: unknown) {
            // Provide specific error messages
            if (getErrorMessage(error)?.includes('File not found') || getErrorMessage(error)?.includes('404')) {
                toast.error(t('fileManagement.toasts.fileNotFound'));
                // It's already gone server-side — reconcile the list.
                invalidateFiles();
            } else if (getErrorMessage(error)?.includes('permission') || getErrorMessage(error)?.includes('403')) {
                toast.error(t('fileManagement.toasts.noPermission'));
            } else {
                toast.error(getErrorMessage(error) || t('fileManagement.toasts.deleteFailed'));
            }
        } finally {
            setDeletingId(null);
        }
    }, [oxyServices, queryClient, targetUserId, invalidateFiles, t]);

    const confirmBulkDelete = useCallback(async () => {
        if (selectedIds.size === 0) return;

        const confirmed = await surfaces.confirm({
            title: t('fileManagement.deleteFiles') || 'Delete Files',
            description: t('fileManagement.confirms.deleteFiles', { count: selectedIds.size }),
            confirmLabel: t('fileManagement.confirm') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
            destructive: true,
        });
        if (!confirmed) return;

        try {
            const deletePromises = Array.from(selectedIds).map(async (fileId) => {
                try {
                    await oxyServices.deleteFile(fileId);
                    removeFileFromCache(queryClient, targetUserId, fileId);
                    return { success: true, fileId };
                } catch (error: unknown) {
                    return { success: false, fileId, error };
                }
            });

            const results = await Promise.allSettled(deletePromises);
            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.length - successful;

            if (successful > 0) {
                toast.success(t('fileManagement.toasts.bulkDeleteSuccess', { count: successful }));
            }
            if (failed > 0) {
                toast.error(t('fileManagement.toasts.bulkDeleteFailed', { count: failed }));
            }

            setSelectedIds(new Set());
            invalidateFiles();
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.bulkDeleteError'));
        }
    }, [selectedIds, oxyServices, queryClient, targetUserId, invalidateFiles, t]);

    const handleBulkVisibilityChange = useCallback(async (visibility: 'private' | 'public' | 'unlisted') => {
        if (selectedIds.size === 0) return;

        try {
            const updatePromises = Array.from(selectedIds).map(async (fileId) => {
                try {
                    await oxyServices.assetUpdateVisibility(fileId, visibility);
                    return { success: true, fileId };
                } catch (error: unknown) {
                    return { success: false, fileId, error };
                }
            });

            const results = await Promise.allSettled(updatePromises);
            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.length - successful;

            if (successful > 0) {
                toast.success(t('fileManagement.toasts.visibilitySuccess', { count: successful, visibility }));
                // Reflect the new visibility in the cached files.
                for (const fileId of selectedIds) {
                    patchFileMetadataInCache(queryClient, targetUserId, fileId, { visibility });
                }
            }
            if (failed > 0) {
                toast.error(t('fileManagement.toasts.visibilityFailed', { count: failed }));
            }

            invalidateFiles();
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.visibilityError'));
        }
    }, [selectedIds, oxyServices, queryClient, targetUserId, invalidateFiles, t]);

    const handleVisibilityChange = useCallback(async () => {
        if (selectedIds.size === 0) return;
        const visibility = await presentActionSheet<'private' | 'public' | 'unlisted'>({
            title: t('fileManagement.changeVisibility') || 'Change Visibility',
            message: t('fileManagement.changeVisibilityConfirm', { count: selectedIds.size }),
            options: [
                { label: t('fileManagement.private') || 'Private', value: 'private' },
                { label: t('fileManagement.public') || 'Public', value: 'public' },
                { label: t('fileManagement.unlisted') || 'Unlisted', value: 'unlisted' },
            ],
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (visibility) await handleBulkVisibilityChange(visibility);
    }, [selectedIds.size, handleBulkVisibilityChange, t]);

    // Unified download function - works on all platforms
    const handleFileDownload = useCallback(async (fileId: string, filename: string) => {
        try {
            // Resolve an authenticated, private-safe URL. The synchronous
            // `getFileDownloadUrl` yields the public CDN origin, which 404s for
            // private assets (the default visibility).
            const downloadUrl = await oxyServices.getFileDownloadUrlAsync(fileId);

            // For web platforms, use link download
            if (typeof window !== 'undefined' && window.document) {
                try {
                    // Try simple link download first
                    const link = document.createElement('a');
                    link.href = downloadUrl;
                    link.download = filename;
                    link.target = '_blank';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    toast.success(t('fileManagement.toasts.downloadStarted'));
                } catch (linkError) {
                    // Fallback to authenticated download
                    const blob = await oxyServices.getFileContentAsBlob(fileId);
                    const url = URL.createObjectURL(blob);

                    const link = document.createElement('a');
                    link.href = url;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    // Clean up the blob URL
                    URL.revokeObjectURL(url);
                    toast.success(t('fileManagement.toasts.downloadSuccess'));
                }
            } else {
                // For mobile, open the URL (user can save from browser)
                // Note: This is a simplified approach - for full mobile support,
                // consider using expo-file-system or react-native-fs
                toast.info(t('fileManagement.toasts.downloadMobile'));
            }
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.downloadFailed'));
        }
    }, [oxyServices, t]);

    const handleFileOpen = useCallback(async (file: FileMetadata) => {
        if (selectMode) {
            toggleSelect(file);
            return;
        }
        try {
            setLoadingFileContent(true);
            setOpenedFile(file);

            // For text files, images, and other viewable content, try to load the content
            if (file.contentType.startsWith('text/') ||
                file.contentType.includes('json') ||
                file.contentType.includes('xml') ||
                file.contentType.includes('javascript') ||
                file.contentType.includes('typescript') ||
                file.contentType.startsWith('image/') ||
                file.contentType.includes('pdf') ||
                file.contentType.startsWith('video/') ||
                file.contentType.startsWith('audio/')) {

                try {
                    if (file.contentType.startsWith('image/') ||
                        file.contentType.includes('pdf') ||
                        file.contentType.startsWith('video/') ||
                        file.contentType.startsWith('audio/')) {
                        // For images, PDFs, videos, and audio, we render the URL
                        // directly. Resolve the authenticated, private-safe URL —
                        // the synchronous public-CDN URL 404s for private assets.
                        const downloadUrl = await oxyServices.getFileDownloadUrlAsync(file.id);
                        setFileContent(downloadUrl);
                    } else {
                        // For text files, get the content using authenticated request
                        const content = await oxyServices.getFileContentAsText(file.id);
                        setFileContent(content);
                    }
                } catch (error: unknown) {
                    if (getErrorMessage(error)?.includes('404') || getErrorMessage(error)?.includes('not found')) {
                        toast.error(t('fileManagement.toasts.fileNotFoundContent'));
                    } else {
                        toast.error(t('fileManagement.toasts.loadContentFailed'));
                    }
                    setFileContent(null);
                }
            } else {
                // For non-viewable files, don't load content
                setFileContent(null);
            }
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.openFailed'));
        } finally {
            setLoadingFileContent(false);
        }
    }, [selectMode, toggleSelect, oxyServices, t]);

    const handleCloseFile = useCallback(() => {
        setOpenedFile(null);
        setFileContent(null);
        setShowFileDetailsInViewer(false);
        // Don't reset view mode when closing a file
    }, []);

    const showFileDetailsModal = useCallback((file: FileMetadata) => {
        presentFileDetails({
            file,
            onDownload: handleFileDownload,
            onDelete: confirmFileDelete,
            isOwner: user?.id === targetUserId,
        });
    }, [handleFileDownload, confirmFileDelete, user?.id, targetUserId]);

    const renderJustifiedPhotoItem = useCallback((photo: FileMetadata, width: number, height: number, isLast: boolean) => {
        const downloadUrl = thumbSourceFor(photo);

        return (
            <TouchableOpacity
                key={photo.id}
                className="rounded-[6px] overflow-hidden relative"
                style={{
                    width,
                    height,
                    ...(selectMode && selectedIds.has(photo.id) ? { borderWidth: 2, borderColor: colors.primary } : {}),
                    ...(selectMode && multiSelect && selectedIds.size > 0 && !selectedIds.has(photo.id) ? { opacity: 0.4 } : {}),
                }}
                onPress={() => handleFileOpen(photo)}
                activeOpacity={0.8}
            >
                <View className="w-full h-full relative rounded-[6px] overflow-hidden">
                    <ExpoImage
                        source={{ uri: downloadUrl }}
                        style={screenStyles.justifiedPhotoImage}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory-disk"
                        onError={() => {
                            // Photo failed to load, will show placeholder
                        }}
                        accessibilityLabel={photo.filename}
                    />
                    {selectMode && (
                        <View className="absolute top-[4px] right-[4px] rounded-[12px] p-[2px]" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
                            <Ionicons name={selectedIds.has(photo.id) ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={selectedIds.has(photo.id) ? colors.primary : colors.text} />
                        </View>
                    )}
                </View>
            </TouchableOpacity>
        );
    }, [thumbSourceFor, selectMode, selectedIds, multiSelect, colors.primary, colors.text, handleFileOpen]);

    // SettingsListItem-based file items (for 'all' view)
    const groupedFileItems: FileListItem[] = useMemo(() => {
        // filteredFiles is already sorted, so just use it directly
        const sortedFiles = filteredFiles;

        return sortedFiles.map((file) => {
            const isImage = file.contentType.startsWith('image/');
            const isPDF = file.contentType.includes('pdf');
            const isVideo = file.contentType.startsWith('video/');
            const hasPreview = isImage || isPDF || isVideo;
            const isSelected = selectedIds.has(file.id);

            // Create icon for preview thumbnails (36x36)
            let fileIcon: React.ReactNode | undefined;
            if (hasPreview) {
                if (isImage) {
                    fileIcon = (
                        <View style={{ width: 36, height: 36, borderRadius: 18, overflow: 'hidden' }}>
                            <ExpoImage
                                source={{ uri: thumbSourceFor(file) }}
                                style={{ width: 36, height: 36 }}
                                contentFit="cover"
                                transition={120}
                                cachePolicy="memory-disk"
                                onError={() => {
                                    // Image preview failed to load - will fallback to icon
                                }}
                                accessibilityLabel={file.filename}
                            />
                        </View>
                    );
                } else if (isVideo) {
                    fileIcon = (
                        <View style={{ width: 36, height: 36, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000000', position: 'relative' }}>
                            <ExpoImage
                                source={{ uri: thumbSourceFor(file) }}
                                style={{ width: 36, height: 36 }}
                                contentFit="cover"
                                transition={120}
                                cachePolicy="memory-disk"
                                onError={(_: unknown) => {
                                    // If thumbnail not available, we still show icon overlay
                                }}
                                accessibilityLabel={`${file.filename} video thumbnail`}
                            />
                            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' }}>
                                <Ionicons name="play" size={16} color="#FFFFFF" />
                            </View>
                        </View>
                    );
                } else if (isPDF) {
                    fileIcon = (
                        <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF6B6B20' }}>
                            <Ionicons name="document" size={20} color={colors.primary} />
                        </View>
                    );
                }
            }

            return {
                id: file.id,
                icon: fileIcon ?? (!hasPreview ? <Ionicons name={getFileIcon(file.contentType)} size={20} color={colors.primary} /> : undefined),
                title: file.filename,
                description: `${formatFileSize(file.length)} • ${new Date(file.uploadDate).toLocaleDateString()}`,
                onPress: () => {
                    // Support selection in regular mode with long press or if already selecting
                    if (!selectMode && selectedIds.size > 0) {
                        // If already in selection mode (some files selected), toggle selection
                        toggleSelect(file);
                    } else {
                        handleFileOpen(file);
                    }
                },
                // Hide action buttons when selecting (in selectMode or bulk operations mode)
                rightElement: (!selectMode && selectedIds.size === 0) ? (
                    <View className="flex-row items-center gap-[6px] ml-[12px]">
                        {(isImage || isVideo || file.contentType.includes('pdf')) && (
                            <TouchableOpacity
                                className="w-[34px] h-[34px] rounded-[8px] items-center justify-center"
                                style={{ backgroundColor: colors.backgroundSecondary }}
                                onPress={() => handleFileOpen(file)}
                            >
                                <Ionicons name="eye" size={18} color={colors.primary} />
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            className="w-[34px] h-[34px] rounded-[8px] items-center justify-center"
                            style={{ backgroundColor: colors.backgroundSecondary }}
                            onPress={() => handleFileDownload(file.id, file.filename)}
                        >
                            <Ionicons name="download" size={18} color={colors.primary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            className="w-[34px] h-[34px] rounded-[8px] items-center justify-center"
                            style={{ backgroundColor: colors.negativeSubtle }}
                            onPress={() => confirmFileDelete(file.id, file.filename)}
                            disabled={deletingId === file.id}
                        >
                            {deletingId === file.id ? (
                                <ActivityIndicator size="small" color={colors.error} />
                            ) : (
                                <Ionicons name="trash" size={18} color={colors.error} />
                            )}
                        </TouchableOpacity>
                    </View>
                ) : undefined,
            };
        });
    }, [filteredFiles, colors, deletingId, toggleSelect, handleFileDownload, confirmFileDelete, handleFileOpen, thumbSourceFor, selectMode, selectedIds]);

    // Browse-themed terminal load-failure state — DISTINCT from the empty state.
    const renderLoadError = () => (
        <FileLibraryError
            title={t('fileManagement.loadError.title')}
            description={t('fileManagement.loadError.description')}
            retryLabel={t('fileManagement.retry')}
            onRetry={() => filesQuery.refetch()}
            iconColor={colors.error}
            titleColor={colors.text}
            descriptionColor={colors.textSecondary}
            buttonColor={colors.primary}
        />
    );

    // Browse "photos" view. The justified grid owns its own dimension
    // measurement + reflow (see JustifiedPhotoGrid); this only supplies the
    // photo set, the private-safe URL resolver, and the tile renderer.
    const renderPhotoGrid = () => {
        const photos = filteredFiles.filter(file => file.contentType.startsWith('image/'));

        if (photos.length === 0) {
            if (hasLoadError) return renderLoadError();
            return (
                <View className="items-center py-[40px] px-[24px]">
                    <Ionicons name="images-outline" size={64} color={colors.textTertiary} />
                    <Text className="text-[24px] font-bold mt-[16px] mb-[8px]" style={{ color: colors.text }}>{t('fileManagement.emptyPhotos.title')}</Text>
                    <Text className="text-[16px] text-center leading-[24px] mb-[32px]" style={{ color: colors.textSecondary }}> {
                        user?.id === targetUserId
                            ? t('fileManagement.emptyPhotos.ownDescription')
                            : t('fileManagement.emptyPhotos.otherDescription')
                    } </Text>
                    {user?.id === targetUserId && (
                        <TouchableOpacity
                            className="flex-row items-center px-[24px] py-[12px] rounded-[24px] gap-[8px]"
                            style={{ backgroundColor: colors.primary }}
                            onPress={handleFileUpload}
                            disabled={uploading || isPickingDocument}
                        >
                            {(uploading || isPickingDocument) ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                            ) : (
                                <>
                                    <Ionicons name="cloud-upload" size={20} color="#FFFFFF" />
                                    <Text className="text-white text-[16px] font-semibold">{t('fileManagement.uploadPhotos')}</Text>
                                </>
                            )}
                        </TouchableOpacity>
                    )}
                </View>
            );
        }

        return (
            <ScrollView
                ref={photoScrollViewRef}
                className="flex-1"
                contentContainerClassName="p-[10px]"
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshingFiles}
                        onRefresh={() => filesQuery.refetch()}
                        tintColor={colors.primary}
                    />
                }
                showsVerticalScrollIndicator={false}
                onScroll={({ nativeEvent }) => {
                    const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                    if (distanceFromBottom < 200 && !isFetchingMore && hasMoreFiles) {
                        filesQuery.fetchNextPage();
                    }
                }}
                scrollEventThrottle={250}
            >
                <JustifiedPhotoGrid
                    photos={photos}
                    getThumbUrl={thumbSourceFor}
                    renderJustifiedPhotoItem={renderJustifiedPhotoItem}
                    textColor={colors.text}
                    containerWidth={
                        typeof containerWidth === 'number' && containerWidth > 0
                            ? containerWidth
                            : undefined
                    }
                />
            </ScrollView>
        );
    };

    const renderEmptyState = () => hasLoadError ? renderLoadError() : (
        <View className="items-center py-[40px] px-[24px]">
            <Ionicons name="folder-open-outline" size={64} color={colors.textTertiary} />
            <Text className="text-[24px] font-bold mt-[16px] mb-[8px]" style={{ color: colors.text }}>{t('fileManagement.emptyFiles.title')}</Text>
            <Text className="text-[16px] text-center leading-[24px] mb-[32px]" style={{ color: colors.textSecondary }}>
                {user?.id === targetUserId
                    ? t('fileManagement.emptyFiles.ownDescription')
                    : t('fileManagement.emptyFiles.otherDescription')
                }
            </Text>
            {user?.id === targetUserId && (
                <TouchableOpacity
                    className="flex-row items-center px-[24px] py-[12px] rounded-[24px] gap-[8px]"
                    style={{ backgroundColor: colors.primary }}
                    onPress={handleFileUpload}
                    disabled={uploading || isPickingDocument}
                >
                    {(uploading || isPickingDocument) ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                        <>
                            <Ionicons name="cloud-upload" size={20} color="#FFFFFF" />
                            <Text className="text-white text-[16px] font-semibold">{t('fileManagement.uploadFiles')}</Text>
                        </>
                    )}
                </TouchableOpacity>
            )}
        </View>
    );

    // Loading state — Bloom's shared `Skeleton` primitives own the shimmer, so
    // this is pure layout: the top chrome (header / controls / search) plus a
    // photo grid of shimmering tiles sized with the same 3-per-row geometry the
    // real photo grid uses. No hand-rolled `Animated` shimmer.
    //
    // The image-only picker owns its OWN loading skeleton (rendered by
    // `PhotoPickerView` when its photo list is still loading), so it inherits the
    // picker's placement-aware container width / columns / tile size and the
    // Dialog-vs-bottom-sheet sizing. Skipping the browse chrome here is what keeps
    // the picker from flashing the wrong (file-manager) skeleton inside the Dialog.
    // The Dialog owns the nav header; this screen contributes its state-dependent
    // title/subtitle + action slots. The image-only picker mode is headerless
    // (PhotoPickerView owns its own bar), so this config is simply ignored there.
    const fmHeaderRight = useMemo<React.ReactNode>(() => {
        const actions = selectMode && multiSelect
            ? [
                { key: 'clear', label: t('fileManagement.clear'), onPress: () => setSelectedIds(new Set()), disabled: selectedIds.size === 0 },
                { key: 'confirm', label: t('fileManagement.confirm'), onPress: confirmMultiSelection, disabled: selectedIds.size === 0 },
            ]
            : !selectMode && selectedIds.size > 0
                ? [
                    { key: 'clear', label: t('fileManagement.clear'), onPress: () => setSelectedIds(new Set()), disabled: false },
                    { key: 'delete', label: t('fileManagement.delete', { count: selectedIds.size }), onPress: confirmBulkDelete, disabled: false },
                    { key: 'visibility', label: t('fileManagement.visibility'), onPress: handleVisibilityChange, disabled: false },
                ]
                : [];
        if (actions.length === 0) return undefined;
        return (
            <View style={fmHeaderStyles.actionsRow}>
                {actions.map((a) => (
                    <SurfaceHeaderAction key={a.key} label={a.label} onPress={a.onPress} disabled={a.disabled} />
                ))}
            </View>
        );
    }, [selectMode, multiSelect, selectedIds, t, confirmMultiSelection, confirmBulkDelete, handleVisibilityChange]);

    const fmHeaderBack = useMemo<React.ReactNode>(() => (
        <Pressable
            onPress={handleCancelUpload}
            accessibilityRole="button"
            accessibilityLabel={t('common.back') || 'Back'}
            hitSlop={8}
            style={fmHeaderStyles.backButton}
        >
            <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
    ), [handleCancelUpload, colors.text, t]);

    // --- Image-only picker: shared-header chrome -----------------------------
    // The flagship photo picker now rides the SAME Dialog nav header as every
    // screen (Cancel / "Choose Photo" / Upload) instead of painting its own bar.
    // Ownership + upload permission gate the Upload action, mirroring the picker's
    // empty-state upload button.
    const isOwner = user?.id === targetUserId;
    const allowUpload = isOwner && allowUploadInSelectMode;

    // Cancel = the nav bar's back affordance. A forward-nav picker (`onPicked`,
    // e.g. the avatar flow) pops its own frame; legacy callback callers keep their
    // close/back behaviour; a promise-based picker dismisses its surface.
    const pickerCancel = useCallback(() => {
        if (onPicked) {
            // Forward-nav picker: Cancel/back pops THIS frame, returning to the
            // frame that opened the picker — never closes the whole session.
            goBack?.();
        } else if (onSelect || onConfirmSelection) {
            if (onClose) onClose();
            else goBack?.();
        } else {
            dismiss?.();
        }
    }, [onPicked, onSelect, onConfirmSelection, onClose, goBack, dismiss]);

    // The picker's ONE trailing CTA, declared through the Dialog header's
    // `primaryAction` (a proper Bloom Button with loading/disabled) — the
    // multi-select confirm ("Done (N)") or, single-select, the Upload action whose
    // loading state reflects an in-flight device upload. Memoized so the header
    // does not thrash.
    const pickerPrimaryAction = useMemo<SurfaceHeaderContent['primaryAction']>(() => {
        if (multiSelect) {
            return {
                label: t('fileManagement.doneWithCount', { count: selectedIds.size }),
                onPress: confirmMultiSelection,
                disabled: selectedIds.size === 0,
            };
        }
        if (isOwner && allowUpload) {
            return {
                label: t('fileManagement.upload'),
                onPress: handleFileUpload,
                loading: uploading || isPickingDocument,
            };
        }
        return undefined;
    }, [
        multiSelect, selectedIds.size, confirmMultiSelection, isOwner, allowUpload,
        t, handleFileUpload, uploading, isPickingDocument,
    ]);

    useSurfaceHeader(
        showUploadPreview
            ? {
                title: t('fileManagement.reviewFiles'),
                subtitle: t('fileManagement.readyToUpload', { count: pendingFiles.length }),
                left: fmHeaderBack,
                largeTitle: false,
            }
            : isImageOnlyPicker
                ? {
                    // ONE shared header — Cancel (back) / "Choose Photo" / Upload — in
                    // `onImage` tone so the chrome stays legible over the black grid.
                    title: t('fileManagement.choosePhoto'),
                    largeTitle: false,
                    onBack: pickerCancel,
                    primaryAction: pickerPrimaryAction,
                    tone: 'onImage',
                }
                : {
                    title: selectMode
                        ? (multiSelect ? (maxSelection ? t('fileManagement.selectedWithMax', { count: selectedIds.size, max: maxSelection }) : t('fileManagement.selected', { count: selectedIds.size })) : t('fileManagement.selectFile'))
                        : (viewMode === 'photos' ? t('fileManagement.photos') : t('fileManagement.title')),
                    subtitle: selectMode
                        ? (multiSelect ? t('fileManagement.available', { count: filteredFiles.length }) : t('fileManagement.tapToSelect'))
                        : (filteredFiles.length === 1 ? t('fileManagement.itemCount', { count: filteredFiles.length }) : t('fileManagement.itemCount_plural', { count: filteredFiles.length })),
                    right: fmHeaderRight,
                    largeTitle: false,
                },
    );

    if (isLoadingFiles && !isImageOnlyPicker) {
        const GRID_PADDING = 10;
        const TILE_GAP = 4;
        const GRID_COLUMNS = 3;
        const GRID_ROWS = 6;
        const tileSize = Math.floor(
            (safeContainerWidth - GRID_PADDING * 2 - TILE_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS,
        );

        return (
            <View className="flex-1" style={{ backgroundColor }}>
                {/* Header */}
                <View
                    className="flex-row items-center justify-between px-[16px] py-[12px]"
                    style={{ borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}
                >
                    <Skeleton.Box width={44} height={44} borderRadius={12} />
                    <Skeleton.Col style={{ alignItems: 'center', marginHorizontal: 16, gap: 6 }}>
                        <Skeleton.Box width={140} height={20} />
                        <Skeleton.Box width={100} height={14} />
                    </Skeleton.Col>
                    <Skeleton.Box width={44} height={44} borderRadius={12} />
                </View>

                {/* Controls bar */}
                <Skeleton.Row style={{ alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12 }}>
                    <Skeleton.Box width={100} height={36} borderRadius={18} />
                    <Skeleton.Box width={44} height={44} borderRadius={22} />
                </Skeleton.Row>

                {/* Search bar */}
                <View className="mx-[12px] mb-[12px]">
                    <Skeleton.Box width="100%" height={44} borderRadius={22} />
                </View>

                {/* Photo grid — static skeleton placeholders; index keys are stable */}
                <View style={{ padding: GRID_PADDING, gap: TILE_GAP }}>
                    {Array.from({ length: GRID_ROWS }, (_, row) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size skeleton grid, order never changes
                        <Skeleton.Row key={`skeleton-row-${row}`} style={{ gap: TILE_GAP }}>
                            {Array.from({ length: GRID_COLUMNS }, (_, col) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size skeleton grid, order never changes
                                <Skeleton.Box key={`skeleton-${row}-${col}`} width={tileSize} height={tileSize} borderRadius={6} />
                            ))}
                        </Skeleton.Row>
                    ))}
                </View>
            </View>
        );
    }

    // Dedicated flagship-style photo picker view used in the avatar-picker
    // context (selectMode + image-only filter). The picker is intentionally
    // minimal: black backdrop, edge-to-edge grid, translucent header. The
    // standalone file manager (non-picker browse) keeps the existing UI.
    if (isImageOnlyPicker && !showUploadPreview) {
        const photosOnly = filteredFiles.filter(
            (file) => file.contentType.startsWith('image/'),
        );

        // Chrome (Cancel / "Choose Photo" / Upload) lives on the shared Dialog nav
        // header (see the `useSurfaceHeader` call above); the picker owns only the
        // full-bleed photo grid as content.
        return (
            <PhotoPickerView
                photos={photosOnly}
                selectedIds={selectedIds}
                multiSelect={multiSelect}
                maxSelection={maxSelection}
                allowUpload={allowUpload}
                refreshing={isRefreshingFiles}
                uploading={uploading}
                isPickingDocument={isPickingDocument}
                hasMore={hasMoreFiles}
                loadingMore={isFetchingMore}
                loading={isLoadingFiles}
                loadError={hasLoadError}
                onRetry={() => filesQuery.refetch()}
                reduceMotion={reduceMotion}
                getThumbUrl={thumbSourceFor}
                primaryColor={colors.primary}
                isOwner={isOwner}
                onTogglePhoto={toggleSelect}
                // Long-press preview surfaces the file-detail panel on the stack.
                onPreviewPhoto={(file) => showFileDetailsModal(file)}
                onUpload={handleFileUpload}
                onRefresh={() => filesQuery.refetch()}
                onLoadMore={() => filesQuery.fetchNextPage()}
                t={t}
            />
        );
    }

    // If a file is opened, show the file viewer
    if (!selectMode && openedFile) {
        return (
            <FileViewer
                file={openedFile}
                fileContent={fileContent}
                loadingFileContent={loadingFileContent}
                showFileDetailsInViewer={showFileDetailsInViewer}
                onToggleDetails={() => setShowFileDetailsInViewer(!showFileDetailsInViewer)}
                onClose={handleCloseFile}
                onDownload={handleFileDownload}
                onDelete={confirmFileDelete}
                isOwner={user?.id === targetUserId}
            />
        );
    }

    // If upload preview is showing, render it inline instead of the file list
    if (showUploadPreview) {
        return (
            <View className="flex-1">
                <UploadPreview
                    pendingFiles={pendingFiles}
                    onConfirm={handleConfirmUpload}
                    onCancel={handleCancelUpload}
                    onRemoveFile={removePendingFile}
                    inline={true}
                />
            </View>
        );
    }

    return (
        <View className="flex-1">
            <View className="flex-row items-center justify-between px-[12px] py-[12px] gap-[12px]">
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    className="flex-1"
                    style={{ maxWidth: '80%' }}
                >
                    <View
                        className="flex-row rounded-full p-[2px] overflow-hidden"
                        style={{ backgroundColor: colors.card }}
                    >
                        <AnimatedButton
                            isSelected={viewMode === 'all'}
                            onPress={() => setViewMode('all')}
                            icon={viewMode === 'all' ? 'folder' : 'folder-outline'}
                            primaryColor={colors.primary}
                            textColor={colors.text}
                            style={screenStyles.viewModeButton}
                            accessibilityLabel={t('fileManagement.a11y.viewAll') || 'Show all files'}
                        />
                        <AnimatedButton
                            isSelected={viewMode === 'photos'}
                            onPress={() => setViewMode('photos')}
                            icon={viewMode === 'photos' ? 'image-multiple' : 'image-multiple-outline'}
                            primaryColor={colors.primary}
                            textColor={colors.text}
                            style={screenStyles.viewModeButton}
                            accessibilityLabel={t('fileManagement.a11y.viewPhotos') || 'Show photos only'}
                        />
                        <AnimatedButton
                            isSelected={viewMode === 'videos'}
                            onPress={() => setViewMode('videos')}
                            icon={viewMode === 'videos' ? 'video' : 'video-outline'}
                            primaryColor={colors.primary}
                            textColor={colors.text}
                            style={screenStyles.viewModeButton}
                            accessibilityLabel={t('fileManagement.a11y.viewVideos') || 'Show videos only'}
                        />
                        <AnimatedButton
                            isSelected={viewMode === 'documents'}
                            onPress={() => setViewMode('documents')}
                            icon={viewMode === 'documents' ? 'file-document' : 'file-document-outline'}
                            primaryColor={colors.primary}
                            textColor={colors.text}
                            style={screenStyles.viewModeButton}
                            accessibilityLabel={t('fileManagement.a11y.viewDocuments') || 'Show documents only'}
                        />
                        <AnimatedButton
                            isSelected={viewMode === 'audio'}
                            onPress={() => setViewMode('audio')}
                            icon={viewMode === 'audio' ? 'music-note' : 'music-note-outline'}
                            primaryColor={colors.primary}
                            textColor={colors.text}
                            style={screenStyles.viewModeButton}
                            accessibilityLabel={t('fileManagement.a11y.viewAudio') || 'Show audio only'}
                        />
                    </View>
                </ScrollView>
                <TouchableOpacity
                    className="flex-row items-center justify-center px-[10px] py-[6px] rounded-full min-w-[36px] gap-[4px]"
                    style={{ backgroundColor: colors.card }}
                    accessibilityRole="button"
                    accessibilityLabel={t('fileManagement.a11y.sortBy', {
                        field: sortBy,
                        order: sortOrder === 'asc' ? 'ascending' : 'descending',
                    }) || `Sort by ${sortBy}, ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}
                    onPress={() => {
                        // Cycle through sort options: date -> size -> name -> type -> date
                        const sortOrder: Array<'date' | 'size' | 'name' | 'type'> = ['date', 'size', 'name', 'type'];
                        const currentIndex = sortOrder.indexOf(sortBy);
                        const nextIndex = (currentIndex + 1) % sortOrder.length;
                        setSortBy(sortOrder[nextIndex]);
                        // Toggle order when cycling back to date
                        if (nextIndex === 0) {
                            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                        }
                    }}
                >
                    <MaterialCommunityIcons
                        name={
                            sortBy === 'date' ? 'calendar' :
                                sortBy === 'size' ? 'sort-numeric-variant' :
                                    sortBy === 'name' ? 'sort-alphabetical-variant' : 'file-document-outline'
                        }
                        size={16}
                        color={colors.text}
                    />
                    <MaterialCommunityIcons
                        name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'}
                        size={14}
                        color={colors.textSecondary}
                    />
                </TouchableOpacity>
                {user?.id === targetUserId && (!selectMode || allowUploadInSelectMode) && (
                    <TouchableOpacity
                        className="h-[44px] w-[44px] rounded-[22px] items-center justify-center"
                        style={{ backgroundColor: colors.primary }}
                        onPress={handleFileUpload}
                        disabled={uploading || isPickingDocument}
                        accessibilityRole="button"
                        accessibilityLabel={t('fileManagement.a11y.uploadFile') || 'Upload file'}
                        accessibilityState={{ busy: uploading || isPickingDocument }}
                    >
                        {uploading ? (
                            <View className="items-center justify-center">
                                <ActivityIndicator size="small" color="#FFFFFF" />
                                {uploadProgress && (
                                    <Text className="text-white text-[10px] font-semibold mt-[2px]">
                                        {uploadProgress.current}/{uploadProgress.total}
                                    </Text>
                                )}
                            </View>
                        ) : isPickingDocument ? (
                            <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                            <Ionicons name="add" size={22} color="#FFFFFF" />
                        )}
                    </TouchableOpacity>
                )}
            </View>

            {/* Search Bar */}
            {files.length > 0 && (viewMode === 'all' || files.some(f => f.contentType.startsWith('image/'))) && (
                <View
                    className="flex-row items-center px-[14px] py-[10px] mx-[12px] mb-[12px] rounded-full gap-[10px]"
                    style={{ backgroundColor: colors.card }}
                >
                    <Ionicons name="search" size={22} color={colors.icon} />
                    <TextInput
                        className="flex-1 text-[16px] leading-[20px]"
                        style={{ color: colors.text }}
                        placeholder={viewMode === 'photos' ? t('fileManagement.searchPhotos') : t('fileManagement.searchFiles')}
                        placeholderTextColor={colors.textSecondary}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                    />
                    {searchQuery.length > 0 && (
                        <TouchableOpacity
                            onPress={() => setSearchQuery('')}
                            className="p-[4px] rounded-[12px] items-center justify-center"
                        >
                            <Ionicons name="close-circle" size={22} color={colors.icon} />
                        </TouchableOpacity>
                    )}
                </View>
            )}

            {/* File Stats */}
            {files.length > 0 && (
                <View
                    className="flex-row px-[14px] py-[10px] mx-[12px] mb-[12px] rounded-[18px]"
                    style={{ backgroundColor: colors.card }}
                >
                    <View className="flex-1 items-center py-[4px]">
                        <Text className="text-[20px] font-extrabold leading-[24px]" style={{ color: colors.text, letterSpacing: -0.5 }}>{filteredFiles.length}</Text>
                        <Text className="text-[12px] font-medium mt-[2px]" style={{ color: colors.textSecondary, letterSpacing: 0.2 }}>
                            {searchQuery.length > 0 ? t('fileManagement.found') : (filteredFiles.length === 1 ? (viewMode === 'photos' ? t('fileManagement.photo') : t('fileManagement.file')) : (viewMode === 'photos' ? t('fileManagement.photos_stat') : t('fileManagement.files')))}
                        </Text>
                    </View>
                    <View className="flex-1 items-center py-[4px]">
                        <Text className="text-[20px] font-extrabold leading-[24px]" style={{ color: colors.text, letterSpacing: -0.5 }}>
                            {formatFileSize(filteredFiles.reduce((total, file) => total + file.length, 0))}
                        </Text>
                        <Text className="text-[12px] font-medium mt-[2px]" style={{ color: colors.textSecondary, letterSpacing: 0.2 }}>
                            {searchQuery.length > 0 ? t('fileManagement.size') : t('fileManagement.totalSize')}
                        </Text>
                    </View>
                    {searchQuery.length > 0 && (
                        <View className="flex-1 items-center py-[4px]">
                            <Text className="text-[20px] font-extrabold leading-[24px]" style={{ color: colors.text, letterSpacing: -0.5 }}>{files.length}</Text>
                            <Text className="text-[12px] font-medium mt-[2px]" style={{ color: colors.textSecondary, letterSpacing: 0.2 }}>
                                {t('fileManagement.total')}
                            </Text>
                        </View>
                    )}
                </View>
            )}

            {/* File List */}
            {viewMode === 'photos' ? (
                renderPhotoGrid()
            ) : (
                <FileListSection
                    scrollViewRef={scrollViewRef}
                    filteredFiles={filteredFiles}
                    searchQuery={searchQuery}
                    items={groupedFileItems}
                    paging={{ loadingMore: isFetchingMore, hasMore: hasMoreFiles }}
                    refreshing={isRefreshingFiles}
                    colors={colors}
                    t={t}
                    onRefresh={() => filesQuery.refetch()}
                    onLoadMore={() => filesQuery.fetchNextPage()}
                    onClearSearch={() => setSearchQuery('')}
                    renderEmptyState={renderEmptyState}
                />
            )}

            {/* Uploading banner overlay with progress */}
            {!selectMode && uploading && (
                <UploadBar
                    uploadProgress={uploadProgress}
                    isDark={bloomTheme.isDark}
                    colors={colors}
                    t={t}
                />
            )}
        </View>
    );
};

export default FileManagementScreen;
