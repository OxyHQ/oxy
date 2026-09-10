/**
 * User file-library queries + cache helpers.
 *
 * The file list is owned by React Query (`useInfiniteQuery`), NOT a zustand
 * store: server pages live in the query cache, and every optimistic mutation
 * (upload / delete / visibility) edits that cache via the pure `*InCache`
 * helpers below. The `queryFn` is side-effect-free — it only fetches and maps a
 * page. This is what lets the file manager stay effect-free while preserving
 * infinite scroll, pull-to-refresh, and optimistic upload reconciliation.
 */

import {
    useInfiniteQuery,
    type InfiniteData,
    type QueryClient,
} from '@tanstack/react-query';
import type { FileMetadata } from '@oxy.so/core';
import { useOxy } from '../../context/OxyContext';
import { queryKeys } from './queryKeys';

/** Files fetched per page. */
export const FILES_PAGE_SIZE = 40;

/** Raw file record as returned by `oxyServices.listUserFiles` / `assetUpload`. */
export interface RawUserFile {
    id: string;
    originalName?: string;
    sha256?: string;
    mime?: string;
    size?: number;
    createdAt?: string;
    metadata?: Record<string, unknown>;
    variants?: unknown[];
}

/** One page of the infinite file list. */
export interface UserFilesPage {
    files: FileMetadata[];
    total: number;
    hasMore: boolean;
    nextOffset: number;
}

export type UserFilesInfinite = InfiniteData<UserFilesPage>;

/** Normalize a raw API file record into the client `FileMetadata` shape. */
export function mapRawFileToMetadata(raw: RawUserFile): FileMetadata {
    return {
        id: raw.id,
        filename: raw.originalName ?? raw.sha256 ?? '',
        contentType: raw.mime ?? '',
        length: raw.size ?? 0,
        chunkSize: 0,
        uploadDate: raw.createdAt ?? '',
        metadata: raw.metadata ?? {},
        variants: (raw.variants ?? []) as FileMetadata['variants'],
    };
}

/**
 * Infinite-paginated list of the owner's files. Fires on mount and whenever
 * `ownerId` changes (a new key); `staleTime: 0` reloads on every open. The
 * rendered list is `data.pages.flatMap(p => p.files)`.
 */
export const useUserFilesInfinite = (ownerId?: string) => {
    const { oxyServices } = useOxy();
    return useInfiniteQuery<UserFilesPage, Error>({
        queryKey: queryKeys.files.list(ownerId),
        queryFn: async ({ pageParam }) => {
            const offset = typeof pageParam === 'number' ? pageParam : 0;
            const response = await oxyServices.listUserFiles(FILES_PAGE_SIZE, offset);
            const raw = (response.files ?? []) as RawUserFile[];
            const files = raw.map(mapRawFileToMetadata);
            return {
                files,
                total: response.total ?? offset + files.length,
                hasMore: Boolean(response.hasMore),
                nextOffset: offset + FILES_PAGE_SIZE,
            };
        },
        initialPageParam: 0,
        getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextOffset : undefined),
        enabled: Boolean(ownerId),
        staleTime: 0,
        refetchOnWindowFocus: false,
    });
};

// --- Pure cache transforms (optimistic updates) -----------------------------
// Each edits the cached `InfiniteData` for one owner. All no-op when nothing is
// cached yet (e.g. an upload before the first page loads) — the subsequent
// `invalidateQueries` reconcile then brings the authoritative record.

const fileListKey = (ownerId?: string) => queryKeys.files.list(ownerId);

const mapPages = (
    data: UserFilesInfinite,
    fn: (files: FileMetadata[]) => FileMetadata[],
): UserFilesInfinite => ({
    ...data,
    pages: data.pages.map((page) => ({ ...page, files: fn(page.files) })),
});

/** Prepend an (optimistic) file to the first page. */
export function prependFileToCache(
    queryClient: QueryClient,
    ownerId: string | undefined,
    file: FileMetadata,
): void {
    queryClient.setQueryData<UserFilesInfinite>(fileListKey(ownerId), (data) => {
        if (!data || data.pages.length === 0) return data;
        return {
            ...data,
            pages: data.pages.map((page, index) =>
                index === 0 ? { ...page, files: [file, ...page.files] } : page,
            ),
        };
    });
}

/** Remove a file (by id) from every page. */
export function removeFileFromCache(
    queryClient: QueryClient,
    ownerId: string | undefined,
    fileId: string,
): void {
    queryClient.setQueryData<UserFilesInfinite>(fileListKey(ownerId), (data) =>
        data ? mapPages(data, (files) => files.filter((f) => f.id !== fileId)) : data,
    );
}

/** Swap an optimistic file (by id) for its persisted counterpart. */
export function replaceFileInCache(
    queryClient: QueryClient,
    ownerId: string | undefined,
    oldId: string,
    newFile: FileMetadata,
): void {
    queryClient.setQueryData<UserFilesInfinite>(fileListKey(ownerId), (data) =>
        data ? mapPages(data, (files) => files.map((f) => (f.id === oldId ? newFile : f))) : data,
    );
}

/** Shallow-merge a metadata patch into a cached file (e.g. visibility change). */
export function patchFileMetadataInCache(
    queryClient: QueryClient,
    ownerId: string | undefined,
    fileId: string,
    metadataPatch: Record<string, unknown>,
): void {
    queryClient.setQueryData<UserFilesInfinite>(fileListKey(ownerId), (data) =>
        data
            ? mapPages(data, (files) =>
                files.map((f) =>
                    f.id === fileId
                        ? { ...f, metadata: { ...f.metadata, ...metadataPatch } as FileMetadata['metadata'] }
                        : f,
                ),
            )
            : data,
    );
}
