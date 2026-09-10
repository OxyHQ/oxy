import type { BaseScreenProps } from './navigation';
import type { FileMetadata } from '@oxy.so/core';

// Exporting props & callback types so external callers (e.g. showBottomSheet config objects) can annotate
export type OnConfirmFileSelection = (files: FileMetadata[]) => void;

export interface FileManagementScreenProps extends BaseScreenProps {
    userId?: string;
    // Container width for responsive layout calculations
    containerWidth?: number;
    // Enable selection mode (acts like a picker). When true, opening a file selects it instead of showing viewer
    selectMode?: boolean;
    // Allow selecting multiple files; only used if selectMode is true
    multiSelect?: boolean;
    // Callback when a file is selected (single select mode)
    onSelect?: (file: FileMetadata) => void;
    /**
     * Forward-navigation picker: called with the picked file in single-select
     * mode when the picker is one FRAME of a larger in-surface flow. Unlike
     * {@link onSelect}, the caller is expected to NAVIGATE the surface onward
     * (e.g. the avatar flow pushes the cropper on top of this picker) — so on
     * select the picker neither dismisses nor closes the session, and its
     * Cancel/back pops THIS frame (returning to the frame that opened the picker)
     * rather than closing. Takes precedence over `onSelect`/`dismiss` when set.
     */
    onPicked?: (file: FileMetadata) => void;
    // Callback when confirm pressed in multi-select mode
    onConfirmSelection?: OnConfirmFileSelection;
    // Initial selected file IDs for multi-select
    initialSelectedIds?: string[];
    maxSelection?: number;
    disabledMimeTypes?: string[];
    /**
     * What to do after a single selection (non-multiSelect) is made.
     * 'close' (default) will dismiss the bottom sheet via onClose.
     * 'back' will navigate back to the previous screen (e.g., return to AccountSettings without closing sheet).
     * 'none' will keep the picker open (caller can manually close or navigate).
     */
    afterSelect?: 'close' | 'back' | 'none';
    allowUploadInSelectMode?: boolean;
    /**
     * Default visibility for uploaded files in this screen
     * Useful for third-party apps that want files to be public (e.g., GIF selector)
     */
    defaultVisibility?: 'private' | 'public' | 'unlisted';
    /**
     * Link context for tracking file usage by third-party apps
     * When provided, selected files will be linked to this entity
     */
    linkContext?: {
        app: string;           // App identifier (e.g., 'chat-app', 'post-composer')
        entityType: string;    // Type of entity (e.g., 'message', 'post', 'profile')
        entityId: string;      // Unique ID of the entity using this file
        webhookUrl?: string;   // Optional webhook URL to receive file events
    };
}

export type ViewMode = 'all' | 'photos' | 'videos' | 'documents' | 'audio';
export type SortBy = 'date' | 'size' | 'name' | 'type';
export type SortOrder = 'asc' | 'desc';

