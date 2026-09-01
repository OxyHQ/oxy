import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom/toast';
import type { AssetUploadInput, FileMetadata } from '@oxyhq/core';
import type { useUploadFile } from '../../../hooks/mutations/useAccountMutations';
import { queryKeys } from '../../../hooks/queries/queryKeys';
import {
    prependFileToCache,
    removeFileFromCache,
    replaceFileInCache,
} from '../../../hooks/queries/useFileQueries';
import { convertDocumentPickerAssetToFile, formatFileSize } from '../../../utils/fileManagement';
import {
    createPendingUploadFile,
    type PendingUploadFile,
    type UploadCandidate,
    candidateName,
    candidateSize,
    candidateType,
    candidateUri,
    getErrorMessage,
    loadDocumentPicker,
} from '../shared';

/** Aggregate progress across a multi-file upload. */
export interface FileUploadAggregateProgress {
    current: number;
    total: number;
}

/** Minimum time the "Uploading…" indicator stays visible (anti-flash). */
const MIN_BANNER_MS = 600;

function revokePreviewUrl(preview: string | undefined): void {
    if (preview?.startsWith('blob:')) {
        URL.revokeObjectURL(preview);
    }
}

/**
 * Optimistic-entry metadata. `uploading` flags the placeholder so no asset URL
 * is ever built from its client-minted `temp-…` id; `localPreviewUri` lets the
 * grid render the locally-picked image while the real upload is in flight (a
 * bare guard would leave an empty tile). See `useResolvedFileUrls`.
 */
type OptimisticFileMetadata = NonNullable<FileMetadata['metadata']> & {
    uploading?: boolean;
    localPreviewUri?: string;
};

/** Dependencies threaded into the upload-state hook from the orchestrator. */
export interface UseFileUploadStateParams {
    targetUserId?: string;
    uploadFileMutation: ReturnType<typeof useUploadFile>;
    defaultVisibility: 'private' | 'public' | 'unlisted';
    selectMode: boolean;
    multiSelect: boolean;
    afterSelect: 'close' | 'back' | 'none';
    onSelect?: (file: FileMetadata) => void;
    /** Forward-navigation picker: see {@link FileManagementScreenProps.onPicked}. */
    onPicked?: (file: FileMetadata) => void;
    goBack?: () => void;
    onClose?: () => void;
    /** When true, the document picker and pre-upload validation accept images only. */
    imagesOnly?: boolean;
    selectedIds: Set<string>;
    setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Public surface returned to the orchestrator. */
export interface UseFileUploadStateResult {
    isPickingDocument: boolean;
    pendingFiles: PendingUploadFile[];
    showUploadPreview: boolean;
    /** Whether an upload is in flight (drives the "Uploading…" banner). */
    uploading: boolean;
    /** Aggregate progress across the current upload, or null. */
    uploadProgress: FileUploadAggregateProgress | null;
    handleFileUpload: () => Promise<void>;
    handleConfirmUpload: () => Promise<void>;
    handleCancelUpload: () => void;
    removePendingFile: (id: string) => void;
}

/**
 * Owns the self-contained document-picking + upload-preview state and handlers
 * extracted from FileManagementScreen. Behaviour is preserved verbatim — the
 * orchestrator simply threads in the values these handlers depend on and
 * consumes the returned state/handlers.
 */
export const useFileUploadState = ({
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
    imagesOnly = false,
    selectedIds,
    setSelectedIds,
    t,
}: UseFileUploadStateParams): UseFileUploadStateResult => {
    const [isPickingDocument, setIsPickingDocument] = useState(false);
    const [pendingFiles, setPendingFiles] = useState<PendingUploadFile[]>([]);
    const [showUploadPreview, setShowUploadPreview] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<FileUploadAggregateProgress | null>(null);

    const queryClient = useQueryClient();
    const uploadStartRef = useRef<number | null>(null);
    const postSelectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const endUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isActiveRef = useRef(true);

    const clearPostSelectTimer = useCallback(() => {
        if (postSelectTimerRef.current) {
            clearTimeout(postSelectTimerRef.current);
            postSelectTimerRef.current = null;
        }
    }, []);

    const clearEndUploadTimer = useCallback(() => {
        if (endUploadTimerRef.current) {
            clearTimeout(endUploadTimerRef.current);
            endUploadTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        isActiveRef.current = true;
        return () => {
            isActiveRef.current = false;
            clearPostSelectTimer();
            clearEndUploadTimer();
        };
    }, [clearPostSelectTimer, clearEndUploadTimer]);

    const endUpload = useCallback(() => {
        const started = uploadStartRef.current;
        const elapsed = started ? Date.now() - started : MIN_BANNER_MS;
        const remaining = elapsed < MIN_BANNER_MS ? MIN_BANNER_MS - elapsed : 0;
        clearEndUploadTimer();
        endUploadTimerRef.current = setTimeout(() => {
            endUploadTimerRef.current = null;
            if (!isActiveRef.current) return;
            setUploading(false);
            uploadStartRef.current = null;
        }, remaining);
    }, [clearEndUploadTimer]);

    const processFileUploads = async (selectedFiles: UploadCandidate[]): Promise<FileMetadata[]> => {
        if (selectedFiles.length === 0) return [];
        if (!targetUserId) return []; // Guard clause to ensure userId is defined
        const uploadedFiles: FileMetadata[] = [];
        try {
            setUploadProgress({ current: 0, total: selectedFiles.length });
            const maxSize = 50 * 1024 * 1024; // 50MB
            const oversizedFiles = selectedFiles.filter(file => candidateSize(file) > maxSize);
            if (oversizedFiles.length > 0) {
                const fileList = oversizedFiles.map(f => candidateName(f, 'file')).join(', ');
                toast.error(t('fileManagement.toasts.filesTooLarge', { files: fileList }));
                return [];
            }
            let successCount = 0;
            let failureCount = 0;
            const errors: string[] = [];
            for (let i = 0; i < selectedFiles.length; i++) {
                setUploadProgress({ current: i + 1, total: selectedFiles.length });
                const raw = selectedFiles[i];
                const fileName = candidateName(raw, `file-${i + 1}`);
                const fileSize = candidateSize(raw);
                const fileType = candidateType(raw);
                const optimisticId = `temp-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 11)}`; // Unique ID per file

                try {
                    // Validate file before upload
                    if (!raw || !fileName || fileSize <= 0) {
                        failureCount++;
                        errors.push(`${fileName}: Invalid file (missing name or size)`);
                        continue;
                    }

                    // Preserve the locally-picked uri so the optimistic tile
                    // shows the real image (not an empty placeholder) while the
                    // upload is in flight. Never an asset URL — the id is a
                    // client-minted `temp-…`.
                    const previewUri = candidateUri(raw);
                    const optimisticMetadata: OptimisticFileMetadata = {
                        uploading: true,
                        ...(previewUri ? { localPreviewUri: previewUri } : {}),
                    };
                    const optimisticFile: FileMetadata = {
                        id: optimisticId,
                        filename: fileName,
                        contentType: fileType,
                        length: fileSize,
                        chunkSize: 0,
                        uploadDate: new Date().toISOString(),
                        metadata: optimisticMetadata,
                        variants: [],
                    };
                    prependFileToCache(queryClient, targetUserId, optimisticFile);

                    // Use the mutation hook with authentication handling
                    const result = await uploadFileMutation.mutateAsync({
                        file: raw as AssetUploadInput,
                        visibility: defaultVisibility,
                    });

                    // Attempt to refresh file list incrementally – fetch single file metadata if API allows
                    const f = result?.file ?? result?.files?.[0];
                    if (f) {
                        const merged: FileMetadata = {
                            id: f.id,
                            filename: f.originalName || f.sha256 || fileName,
                            contentType: f.mime || fileType,
                            length: f.size || fileSize,
                            chunkSize: 0,
                            uploadDate: f.createdAt || new Date().toISOString(),
                            metadata: f.metadata || {},
                            variants: f.variants || [],
                        };
                        // Swap the optimistic temp entry for the persisted record.
                        replaceFileInCache(queryClient, targetUserId, optimisticId, merged);
                        uploadedFiles.push(merged);
                        successCount++;
                    } else {
                        // Upload succeeded but the API returned no file payload,
                        // so we cannot build a real entry. Drop the optimistic
                        // placeholder instead of stranding a `temp-…` id (which
                        // would leak into asset URLs); the reconcile invalidation
                        // below re-fetches the persisted record.
                        removeFileFromCache(queryClient, targetUserId, optimisticId);
                        // Still count as success if upload didn't throw
                        successCount++;
                    }
                } catch (error: unknown) {
                    failureCount++;
                    const errorMessage = getErrorMessage(error) || 'Upload failed';
                    errors.push(`${fileName}: ${errorMessage}`);
                    // Remove optimistic file on error (use the same optimisticId from above)
                    removeFileFromCache(queryClient, targetUserId, optimisticId);
                }
            }

            // Show success/error messages
            if (successCount > 0) {
                toast.success(t('fileManagement.toasts.uploadSuccess', { count: successCount }));
            }
            if (failureCount > 0) {
                // Show detailed error message with first few errors
                const errorDetails = errors.length > 0
                    ? `\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? `\n...and ${errors.length - 3} more` : ''}`
                    : '';
                toast.error(`${t('fileManagement.toasts.uploadFailed', { count: failureCount })}${errorDetails}`);
            }
            // Reconcile against the server (picks up generated variants / metadata)
            // — replaces the old silent-reload timer.
            if (successCount > 0) {
                queryClient.invalidateQueries({ queryKey: queryKeys.files.list(targetUserId) });
            }
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.uploadError'));
        } finally {
            setUploadProgress(null);
        }
        return uploadedFiles;
    };

    const handleFileSelection = useCallback(async (selectedFiles: UploadCandidate[]) => {
        const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
        const processedFiles: PendingUploadFile[] = [];

        for (const file of selectedFiles) {
            // Validate file has required properties
            if (!file) {
                toast.error(t('fileManagement.toasts.invalidFileMissing'));
                continue;
            }

            const name = candidateName(file, '');
            if (!name) {
                toast.error(t('fileManagement.toasts.invalidFileName'));
                continue;
            }

            const size = (file as { size?: number }).size;
            if (size === undefined || size === null || Number.isNaN(size)) {
                toast.error(t('fileManagement.toasts.invalidFileSize', { name }));
                continue;
            }

            if (size <= 0) {
                toast.error(t('fileManagement.toasts.fileEmpty', { name }));
                continue;
            }

            // Validate file size
            if (size > MAX_FILE_SIZE) {
                toast.error(t('fileManagement.toasts.fileTooLarge', { name, maxSize: formatFileSize(MAX_FILE_SIZE) }));
                continue;
            }

            const fileType = candidateType(file);

            if (imagesOnly && !fileType.startsWith('image/')) {
                toast.error(t('fileManagement.toasts.imagesOnlyRequired'));
                continue;
            }

            // Generate preview for images - unified approach
            let preview: string | undefined;
            if (fileType.startsWith('image/')) {
                // Try to use file URI from expo-document-picker if available (works on all platforms)
                const fileUri = candidateUri(file);
                if (fileUri &&
                    (fileUri.startsWith('file://') || fileUri.startsWith('content://') ||
                        fileUri.startsWith('http://') || fileUri.startsWith('https://') ||
                        fileUri.startsWith('blob:'))) {
                    preview = fileUri;
                } else {
                    // Fallback: create blob URL if possible (works on web only)
                    try {
                        if ((typeof File !== 'undefined' && file instanceof File) ||
                            (typeof Blob !== 'undefined' && file instanceof Blob)) {
                            preview = URL.createObjectURL(file as Blob);
                        }
                    } catch {
                        // Preview is optional — continue without it.
                    }
                }
            }

            processedFiles.push(createPendingUploadFile(file, preview, size, name, fileType));
        }

        if (processedFiles.length === 0) {
            toast.error(t('fileManagement.toasts.noValidFiles'));
            return;
        }

        // Show preview modal for user to review files before upload
        setPendingFiles(processedFiles);
        setShowUploadPreview(true);
    }, [imagesOnly, t]);

    const handleConfirmUpload = async () => {
        if (pendingFiles.length === 0) return;

        setShowUploadPreview(false);
        uploadStartRef.current = Date.now();
        setUploading(true);
        setUploadProgress(null);

        try {
            const filesToUpload = pendingFiles.map(pf => pf.file);
            setUploadProgress({ current: 0, total: filesToUpload.length });
            const uploadedFiles = await processFileUploads(filesToUpload);

            // Cleanup preview URLs
            for (const pf of pendingFiles) {
                revokePreviewUrl(pf.preview);
            }
            setPendingFiles([]);

            // If in selectMode, automatically select the uploaded file(s)
            if (selectMode && uploadedFiles.length > 0) {
                // Defer one tick so the query cache has settled before selecting.
                clearPostSelectTimer();
                postSelectTimerRef.current = setTimeout(() => {
                    postSelectTimerRef.current = null;
                    if (!isActiveRef.current) return;

                    const fileToSelect = uploadedFiles[0];
                    if (!multiSelect && fileToSelect) {
                        if (onPicked) {
                            // Forward-navigation picker (avatar flow): hand the
                            // freshly-uploaded file onward (to the cropper). No
                            // dismiss/close — the picker frame stays below.
                            onPicked(fileToSelect);
                        } else {
                            // Single select mode - directly call onSelect callback
                            onSelect?.(fileToSelect);
                            if (afterSelect === 'back') {
                                goBack?.();
                            } else if (afterSelect === 'close') {
                                onClose?.();
                            }
                        }
                    } else if (multiSelect) {
                        // Multi-select mode - add all uploaded files to selection
                        for (const file of uploadedFiles) {
                            if (!selectedIds.has(file.id)) {
                                setSelectedIds(prev => new Set(prev).add(file.id));
                            }
                        }
                    }
                }, 500);
            }

            endUpload();
        } catch (error: unknown) {
            toast.error(getErrorMessage(error) || t('fileManagement.toasts.uploadError'));
            endUpload();
        }
    };

    // Memoized because the orchestrator builds the upload-preview header's back
    // NODE from it (`fmHeaderBack`): a node can only be compared by identity, so
    // a fresh closure here re-creates the node every render and thrashes the
    // surface-header bridge into an unbounded update loop (React error #185).
    const handleCancelUpload = useCallback(() => {
        clearPostSelectTimer();

        // Cleanup preview URLs
        for (const pf of pendingFiles) {
            revokePreviewUrl(pf.preview);
        }
        setPendingFiles([]);
        setShowUploadPreview(false);
    }, [clearPostSelectTimer, pendingFiles]);

    const removePendingFile = (id: string) => {
        const file = pendingFiles.find((pf) => pf.id === id);
        if (!file) return;
        if (file.preview) {
            revokePreviewUrl(file.preview);
        }
        const updated = pendingFiles.filter((pf) => pf.id !== id);
        setPendingFiles(updated);
        if (updated.length === 0) {
            setShowUploadPreview(false);
        }
    };

    /**
     * Handle file upload - opens document picker and processes selected files
     * Expo 54 compatible - works on web, iOS, and Android
     *
     * Memoized because the orchestrator feeds it to the picker header's
     * `primaryAction` (the Upload CTA) through a `useMemo`: a fresh closure each
     * render invalidates that memo every render, which is the input the
     * surface-header bridge is guarding against.
     */
    const handleFileUpload = useCallback(async () => {
        // Prevent concurrent document picker calls
        if (isPickingDocument) {
            toast.error(t('fileManagement.toasts.waitForSelection'));
            return;
        }

        try {
            setIsPickingDocument(true);

            // Lazy load expo-document-picker
            const picker = await loadDocumentPicker();

            // Use expo-document-picker (works on all platforms including web)
            // On web, it uses the native file input and provides File objects directly
            const result = await picker.getDocumentAsync({
                type: imagesOnly ? 'image/*' : '*/*',
                multiple: true,
                copyToCacheDirectory: true,
            });

            if (result.canceled) {
                setIsPickingDocument(false);
                return;
            }

            if (!result.assets || result.assets.length === 0) {
                setIsPickingDocument(false);
                toast.error(t('fileManagement.toasts.noFilesSelected'));
                return;
            }

            // Convert expo document picker results to File-like objects
            // According to Expo 54 docs, expo-document-picker returns assets with:
            // - uri: file URI (file://, content://, or blob URL)
            // - name: file name
            // - size: file size in bytes
            // - mimeType: MIME type of the file
            // - file: (optional) native File object (usually only on web)
            const files: UploadCandidate[] = [];
            const errors: string[] = [];

            // Process files in parallel for better performance
            // This allows multiple files to be converted simultaneously
            const conversionPromises = result.assets.map((doc, index) =>
                convertDocumentPickerAssetToFile(doc, index)
                    .then((file): UploadCandidate | null => {
                        if (file) {
                            // Validate file has required properties before adding
                            if (!file.name || (file as { size?: number }).size === undefined) {
                                errors.push(`File "${doc.name || 'file'}" is invalid: missing required properties`);
                                return null;
                            }
                            return file;
                        }
                        return null;
                    })
                    .catch((error: unknown) => {
                        errors.push(`File "${doc.name || 'file'}": ${getErrorMessage(error) || 'Failed to process'}`);
                        return null;
                    })
            );

            const convertedFiles = await Promise.all(conversionPromises);

            // Filter out null values
            for (const file of convertedFiles) {
                if (file) {
                    files.push(file);
                }
            }

            // Show errors if any
            if (errors.length > 0) {
                const errorMessage = errors.slice(0, 3).join('\n') + (errors.length > 3 ? `\n...and ${errors.length - 3} more` : '');
                toast.error(t('fileManagement.toasts.loadSomeFailed', { errors: errorMessage }));
            }

            // Process successfully converted files
            if (files.length > 0) {
                await handleFileSelection(files);
            } else {
                // Files were selected but none could be converted
                toast.error(t('fileManagement.toasts.noFilesProcessed'));
            }
        } catch (error: unknown) {
            if (getErrorMessage(error)?.includes('expo-document-picker') || getErrorMessage(error)?.includes('Different document picking in progress')) {
                if (getErrorMessage(error)?.includes('Different document picking in progress')) {
                    toast.error(t('fileManagement.toasts.waitForSelection'));
                } else {
                    toast.error(t('fileManagement.toasts.filePickerNotAvailable'));
                }
            } else {
                toast.error(getErrorMessage(error) || t('fileManagement.toasts.selectFilesFailed'));
            }
        } finally {
            // Always reset the picking state, even if there was an error
            setIsPickingDocument(false);
        }
    }, [isPickingDocument, imagesOnly, handleFileSelection, t]);

    return {
        isPickingDocument,
        pendingFiles,
        showUploadPreview,
        uploading,
        uploadProgress,
        handleFileUpload,
        handleConfirmUpload,
        handleCancelUpload,
        removePendingFile,
    };
};

export default useFileUploadState;
