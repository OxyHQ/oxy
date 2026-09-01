import type Ionicons from '@expo/vector-icons/Ionicons';
import type { AssetUploadInput, RNFileDescriptor } from '@oxyhq/core';
import type { ComponentProps } from 'react';
import { Platform } from 'react-native';

/**
 * Extended File interface that includes a `uri` property for mobile preview support.
 * React Native file pickers return URI-based references that need to be preserved
 * on the File object for preview rendering.
 */
interface FileWithUri extends File {
  uri?: string;
}

/**
 * Picker descriptor as returned by expo-document-picker / expo-image-picker.
 * Carries enough info to either build a web `File` from the URI or pass the
 * descriptor straight to FormData on React Native.
 */
export interface PickerAsset {
  file?: File | Blob;
  uri?: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

/**
 * Type guard — returns true if the input is a React Native file descriptor
 * (carries a URI but is not a real DOM `File` / `Blob` instance).
 */
export function isRNFileDescriptor(input: unknown): input is RNFileDescriptor {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.uri !== 'string') return false;
  if (typeof File !== 'undefined' && input instanceof File) return false;
  if (typeof Blob !== 'undefined' && input instanceof Blob) return false;
  return true;
}

/**
 * Format file size in bytes to human-readable string
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

/**
 * Get icon name for file based on content type
 */
export function getFileIcon(contentType: string): ComponentProps<typeof Ionicons>['name'] {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'videocam';
    if (contentType.startsWith('audio/')) return 'musical-notes';
    if (contentType.includes('pdf')) return 'document-text';
    if (contentType.includes('word') || contentType.includes('doc')) return 'document';
    if (contentType.includes('excel') || contentType.includes('sheet')) return 'grid';
    if (contentType.includes('zip') || contentType.includes('archive')) return 'archive';
    return 'document-outline';
}

/**
 * Convert a document/image picker asset into a value that
 * `OxyServices.assetUpload` can accept.
 *
 * - On the web, builds a real `File` (with the `uri` field preserved for
 *   preview rendering) by fetching the asset as a Blob.
 * - On React Native (iOS/Android), returns the picker descriptor directly
 *   ({ uri, type, name, size }). RN's `FormData` reads the file from disk
 *   during the multipart upload — no in-JS Blob conversion needed. Attempting
 *   to wrap an ArrayBuffer in a Blob fails on Hermes ("Creating blobs from
 *   'ArrayBuffer' and 'ArrayBufferView' are not supported").
 */
export async function convertDocumentPickerAssetToFile(
    doc: PickerAsset,
    index: number
): Promise<FileWithUri | RNFileDescriptor | null> {
    const fileName = doc.name || `file-${index + 1}`;
    const fileType = doc.mimeType || 'application/octet-stream';

    // React Native path — return the descriptor as-is. FormData handles it.
    if (Platform.OS !== 'web') {
        if (!doc.uri) {
            throw new Error('Missing file data (no uri property)');
        }
        return {
            uri: doc.uri,
            type: fileType,
            name: fileName,
            size: typeof doc.size === 'number' ? doc.size : undefined,
        };
    }

    try {
        let file: FileWithUri | null = null;

        // Priority 1: Use doc.file if available (web native File API).
        // This is the most efficient path as it doesn't require fetching.
        if (doc.file && typeof globalThis.File !== 'undefined' && doc.file instanceof globalThis.File) {
            file = doc.file as FileWithUri;
            // Ensure file has required properties
            if (!file.name && doc.name) {
                // Create new File with proper name if missing
                file = new globalThis.File([file], doc.name, { type: file.type || fileType });
            }
            // Preserve URI for preview if available
            if (doc.uri) {
                file.uri = doc.uri;
            }
            return file;
        }

        // Priority 2: Build File from URI (web blob URLs or http(s) URLs).
        if (doc.uri) {
            try {
                const response = await fetch(doc.uri);
                if (!response.ok) {
                    throw new Error(`Failed to fetch file: ${response.statusText}`);
                }
                const blob = await response.blob();
                const resolvedType = doc.mimeType || blob.type || 'application/octet-stream';
                file = new globalThis.File([blob], fileName, { type: resolvedType }) as FileWithUri;
                file.uri = doc.uri;
                return file;
            } catch (error: unknown) {
                console.error('Failed to read file from URI:', error);
                throw new Error(`Failed to load file: ${(error instanceof Error ? error.message : null) || 'Unknown error'}`);
            }
        }

        // No file or URI available - this shouldn't happen with Expo 54
        throw new Error('Missing file data (no file or uri property)');
    } catch (error: unknown) {
        console.error('Error converting document to file:', error);
        throw error;
    }
}

/**
 * Upload file raw - helper function for file uploads
 */
export async function uploadFileRaw(
    file: AssetUploadInput,
    userId: string,
    // biome-ignore lint/suspicious/noExplicitAny: OxyServices type cannot be fully resolved due to mixin composition pattern
    oxyServices: any,
    visibility?: 'private' | 'public' | 'unlisted'
) {
    return await oxyServices.uploadRawFile(file, visibility);
}
