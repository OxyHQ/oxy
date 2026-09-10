import type { RNFileDescriptor } from '@oxy.so/core';
import { getErrorMessage as getOxyErrorMessage } from '@oxy.so/core';

// Lazy load expo-document-picker (optional dependency).
// This allows the screen to work even if expo-document-picker is not installed.
let DocumentPicker: typeof import('expo-document-picker') | null = null;
export const loadDocumentPicker = async () => {
    if (DocumentPicker) return DocumentPicker;
    try {
        DocumentPicker = await import('expo-document-picker');
        return DocumentPicker;
    } catch (error) {
        throw new Error('expo-document-picker is not installed. Please install it: npx expo install expo-document-picker');
    }
};

/**
 * Extract error message from unknown error type.
 * Delegates to the canonical `getErrorMessage` in `@oxy.so/core` and returns
 * `undefined` for empty results (so callers can fall back to a translated
 * message via `||`).
 */
export const getErrorMessage = (error: unknown): string | undefined => {
    if (error == null) return undefined;
    const message = getOxyErrorMessage(error, '');
    return message ? message : undefined;
};

/**
 * A picker-produced file ready to upload. On web this is a real `File`
 * (carrying an optional `uri` for preview). On native, it's an
 * {@link RNFileDescriptor} — passed straight to FormData by `assetUpload`.
 */
export type UploadCandidate = (File & { uri?: string }) | RNFileDescriptor;

/** Returns the display name for either a web File or an RN descriptor. */
export const candidateName = (candidate: UploadCandidate, fallback: string): string =>
    (candidate.name && typeof candidate.name === 'string' ? candidate.name : fallback);

/** Returns the byte size for either a web File or an RN descriptor (0 if unknown). */
export const candidateSize = (candidate: UploadCandidate): number => {
    const size = (candidate as { size?: number }).size;
    return typeof size === 'number' && Number.isFinite(size) ? size : 0;
};

/** Returns the mime type for either a web File or an RN descriptor. */
export const candidateType = (candidate: UploadCandidate): string => {
    const value = (candidate as { type?: string }).type;
    return typeof value === 'string' && value.length > 0 ? value : 'application/octet-stream';
};

/** Returns the preview URI for an upload candidate, if available. */
export const candidateUri = (candidate: UploadCandidate): string | undefined => {
    const uri = (candidate as { uri?: string }).uri;
    return typeof uri === 'string' && uri.length > 0 ? uri : undefined;
};

/** A processed file ready for review in the upload preview modal. */
export interface PendingUploadFile {
    /** Stable row identity for React keys and removal — survives reorder/filter. */
    id: string;
    file: UploadCandidate;
    preview?: string;
    size: number;
    name: string;
    type: string;
}

const createPendingUploadId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Mint a {@link PendingUploadFile} row from a validated upload candidate. */
export const createPendingUploadFile = (
    file: UploadCandidate,
    preview: string | undefined,
    size: number,
    name: string,
    type: string,
): PendingUploadFile => ({
    id: createPendingUploadId(),
    file,
    preview,
    size,
    name,
    type,
});
