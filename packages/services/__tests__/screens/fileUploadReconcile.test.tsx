/**
 * Covers the file library's React Query data layer (the zustand `fileStore` was
 * retired — server pages live in the query cache):
 *
 *  - Infinite paging: `useUserFilesInfinite` walks the offset cursor via
 *    `getNextPageParam` and appends pages on `fetchNextPage`.
 *  - The pure cache helpers (prepend / remove / replace / patch) that back
 *    optimistic upload, delete, and visibility changes.
 *  - The optimistic-upload lifecycle in `useFileUploadState`, pinning the
 *    `temp-` id contract against the QUERY CACHE:
 *      · in flight, the optimistic entry carries the picked uri + `uploading`
 *        flag so the grid never builds an asset URL from a `temp-…` id;
 *      · on success WITH a payload, the temp entry is replaced by the real file;
 *      · on success WITHOUT a payload, the temp entry is removed (not stranded);
 *      · on failure, the temp entry is removed.
 *
 * The document picker is stubbed; every other helper is the real module.
 */

import { renderHook, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileMetadata } from '@oxyhq/core';
import { fileThumbSource } from '../../src/ui/hooks/useResolvedFileUrls';
import FileLibraryError from '../../src/ui/screens/fileManagement/FileLibraryError';
import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';
import {
  useUserFilesInfinite,
  prependFileToCache,
  removeFileFromCache,
  replaceFileInCache,
  patchFileMetadataInCache,
  type UserFilesInfinite,
  type RawUserFile,
} from '../../src/ui/hooks/queries/useFileQueries';
import type { useUploadFile } from '../../src/ui/hooks/mutations/useAccountMutations';

// Stub only the lazy document-picker loader; keep every other helper real.
const getDocumentAsync = jest.fn();
jest.mock('../../src/ui/screens/fileManagement/shared', () => {
  const actual = jest.requireActual('../../src/ui/screens/fileManagement/shared');
  return { __esModule: true, ...actual, loadDocumentPicker: () => Promise.resolve({ getDocumentAsync }) };
});

// `useUserFilesInfinite` reads oxyServices from context; the upload hook does not.
const listUserFiles = jest.fn();
jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ({ oxyServices: { listUserFiles }, activeSessionId: 's1' }),
}));

// The error state renders vector icons, which don't parse under ts-jest.
jest.mock('@expo/vector-icons/Ionicons', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  __esModule: true,
  default: () => null,
}));

import { useFileUploadState } from '../../src/ui/screens/fileManagement/hooks/useFileUploadState';

const OWNER = 'u1';
const KEY = queryKeys.files.list(OWNER);
const PICKED_URI = 'file:///picked-photo.png';

type UploadMutation = ReturnType<typeof useUploadFile>;

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } } });

const wrapper = (client: QueryClient) => {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return Wrapper;
};

const raw = (id: string): RawUserFile => ({
  id,
  originalName: `${id}.jpg`,
  mime: 'image/jpeg',
  size: 1024,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const file = (id: string): FileMetadata => ({
  id,
  filename: `${id}.jpg`,
  contentType: 'image/jpeg',
  length: 1024,
  chunkSize: 0,
  uploadDate: '2026-01-01T00:00:00.000Z',
  metadata: {},
  variants: [],
});

// Seed the cache with a single (optionally populated) first page so optimistic
// prepends have somewhere to land.
const seedCache = (client: QueryClient, files: FileMetadata[] = []) => {
  const data: UserFilesInfinite = {
    pageParams: [0],
    pages: [{ files, total: files.length, hasMore: false, nextOffset: 40 }],
  };
  client.setQueryData(KEY, data);
};

const cachedFiles = (client: QueryClient): FileMetadata[] =>
  (client.getQueryData(KEY) as UserFilesInfinite | undefined)?.pages.flatMap((p) => p.files) ?? [];

const tempEntries = (client: QueryClient) => cachedFiles(client).filter((f) => f.id.startsWith('temp-'));

const makeParams = (mutateAsync: jest.Mock) => ({
  targetUserId: OWNER,
  uploadFileMutation: { mutateAsync } as unknown as UploadMutation,
  defaultVisibility: 'private' as const,
  selectMode: false,
  multiSelect: false,
  afterSelect: 'none' as const,
  onSelect: jest.fn(),
  goBack: jest.fn(),
  onClose: jest.fn(),
  selectedIds: new Set<string>(),
  setSelectedIds: jest.fn(),
  t: (key: string) => key,
});

const primePicker = () => {
  getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: PICKED_URI, name: 'picked-photo.png', mimeType: 'image/png', size: 2048 }],
  });
};

describe('file query cache helpers', () => {
  const base = (): UserFilesInfinite => ({
    pageParams: [0],
    pages: [{ files: [file('a'), file('b')], total: 2, hasMore: false, nextOffset: 40 }],
  });

  it('prepend adds to the first page; remove drops by id', () => {
    const client = makeClient();
    client.setQueryData(KEY, base());
    prependFileToCache(client, OWNER, file('new'));
    expect(cachedFiles(client).map((f) => f.id)).toEqual(['new', 'a', 'b']);
    removeFileFromCache(client, OWNER, 'a');
    expect(cachedFiles(client).map((f) => f.id)).toEqual(['new', 'b']);
  });

  it('replace swaps one file for another; patch merges metadata', () => {
    const client = makeClient();
    client.setQueryData(KEY, base());
    replaceFileInCache(client, OWNER, 'a', { ...file('real'), filename: 'real.jpg' });
    expect(cachedFiles(client).map((f) => f.id)).toEqual(['real', 'b']);
    patchFileMetadataInCache(client, OWNER, 'b', { visibility: 'public' });
    const b = cachedFiles(client).find((f) => f.id === 'b');
    expect((b?.metadata as { visibility?: string } | undefined)?.visibility).toBe('public');
  });

  it('helpers no-op when nothing is cached (upload before first page load)', () => {
    const client = makeClient();
    prependFileToCache(client, OWNER, file('x'));
    expect(client.getQueryData(KEY)).toBeUndefined();
  });
});

describe('useUserFilesInfinite paging', () => {
  beforeEach(() => {
    listUserFiles.mockReset();
  });

  it('walks the offset cursor across pages via getNextPageParam', async () => {
    listUserFiles.mockImplementation(async (_limit: number, offset: number) =>
      offset === 0
        ? { files: [raw('a'), raw('b')], total: 3, hasMore: true }
        : { files: [raw('c')], total: 3, hasMore: false },
    );
    const client = makeClient();
    const { result } = renderHook(() => useUserFilesInfinite(OWNER), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    const all = result.current.data?.pages.flatMap((p) => p.files).map((f) => f.id);
    expect(all).toEqual(['a', 'b', 'c']);
    expect(listUserFiles).toHaveBeenCalledTimes(2);
  });
});

describe('load error state (distinct from empty)', () => {
  beforeEach(() => {
    listUserFiles.mockReset();
  });

  it('a rejected fetch yields isError with no data — a resolved-empty fetch does not', async () => {
    // Rejecting fetch → terminal error, no data (the render branches on this).
    listUserFiles.mockRejectedValue(new Error('offline'));
    const failClient = makeClient();
    const { result: failed } = renderHook(() => useUserFilesInfinite(OWNER), {
      wrapper: wrapper(failClient),
    });
    await waitFor(() => expect(failed.current.isError).toBe(true));
    expect(failed.current.data).toBeUndefined();

    // Resolving empty → NOT an error; an empty (but present) first page.
    listUserFiles.mockResolvedValue({ files: [], total: 0, hasMore: false });
    const emptyClient = makeClient();
    const { result: empty } = renderHook(() => useUserFilesInfinite(OWNER), {
      wrapper: wrapper(emptyClient),
    });
    await waitFor(() => expect(empty.current.isSuccess).toBe(true));
    expect(empty.current.isError).toBe(false);
    expect(empty.current.data?.pages[0].files).toEqual([]);
  });

  it('FileLibraryError renders the error copy and retries on press', () => {
    const onRetry = jest.fn();
    render(
      createElement(FileLibraryError, {
        title: 'Could not load files',
        description: 'Check your connection.',
        retryLabel: 'Try again',
        onRetry,
        iconColor: '#ff0000',
        titleColor: '#000000',
        descriptionColor: '#666666',
        buttonColor: '#0000ff',
      }),
    );
    // The error surface shows its own copy — not the "no files yet" empty text.
    expect(screen.getByText('Could not load files')).toBeTruthy();
    expect(screen.getByText('Check your connection.')).toBeTruthy();
    expect(screen.queryByText(/no files/i)).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('useFileUploadState optimistic lifecycle (query cache)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    // Native path in convertDocumentPickerAssetToFile returns the descriptor
    // directly (no web fetch/Blob), which keeps this test hermetic.
    Platform.OS = 'ios';
    getDocumentAsync.mockReset();
    primePicker();
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('shows the picked uri (never a temp asset URL) while uploading, then removes the temp entry when the response has no file payload', async () => {
    const client = makeClient();
    seedCache(client);

    let resolveUpload: (value: unknown) => void = () => undefined;
    const mutateAsync = jest.fn(() => new Promise((resolve) => { resolveUpload = resolve; }));

    const { result } = renderHook(() => useFileUploadState(makeParams(mutateAsync)), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleFileUpload();
    });

    let confirmPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      confirmPromise = result.current.handleConfirmUpload();
      // let the optimistic prepend + mutateAsync call run up to the await
      await Promise.resolve();
    });

    // In flight: exactly one optimistic entry in the cache, flagged + carrying the picked uri.
    const inFlight = tempEntries(client);
    expect(inFlight).toHaveLength(1);
    const optimistic = inFlight[0];
    expect(optimistic.metadata?.uploading).toBe(true);
    expect((optimistic.metadata as { localPreviewUri?: string }).localPreviewUri).toBe(PICKED_URI);
    // The grid source for the optimistic entry is the picked uri — NOT an asset
    // URL built from its temp- id (the resolved map is intentionally empty).
    expect(fileThumbSource(optimistic, new Map())).toBe(PICKED_URI);

    // Upload succeeds but returns no file payload.
    await act(async () => {
      resolveUpload({});
      await confirmPromise;
    });

    // Reconciled: no stranded temp- entry remains in the cache.
    expect(tempEntries(client)).toHaveLength(0);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('replaces the optimistic entry with the persisted file on success', async () => {
    const client = makeClient();
    seedCache(client);

    const mutateAsync = jest.fn(async () => ({
      file: {
        id: 'real-42',
        originalName: 'picked-photo.png',
        mime: 'image/png',
        size: 2048,
        createdAt: '2026-01-02T00:00:00.000Z',
        metadata: {},
        variants: [],
      },
    }));

    const { result } = renderHook(() => useFileUploadState(makeParams(mutateAsync)), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleFileUpload();
    });
    await act(async () => {
      await result.current.handleConfirmUpload();
    });

    const ids = cachedFiles(client).map((f) => f.id);
    expect(ids.some((id) => id.startsWith('temp-'))).toBe(false);
    expect(ids).toContain('real-42');
  });

  it('removes the optimistic entry when the upload throws', async () => {
    const client = makeClient();
    seedCache(client);

    const mutateAsync = jest.fn(async () => {
      throw new Error('network');
    });

    const { result } = renderHook(() => useFileUploadState(makeParams(mutateAsync)), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleFileUpload();
    });
    await act(async () => {
      await result.current.handleConfirmUpload();
    });

    expect(tempEntries(client)).toHaveLength(0);
  });

  it('does not call onPicked after unmount during the post-upload defer', async () => {
    jest.useFakeTimers();
    const client = makeClient();
    seedCache(client);
    const onPicked = jest.fn();
    const mutateAsync = jest.fn(async () => ({
      file: {
        id: 'real-99',
        originalName: 'picked-photo.png',
        mime: 'image/png',
        size: 2048,
        createdAt: '2026-01-02T00:00:00.000Z',
        metadata: {},
        variants: [],
      },
    }));

    const { result, unmount } = renderHook(
      () => useFileUploadState({ ...makeParams(mutateAsync), selectMode: true, onPicked }),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleFileUpload();
    });
    await act(async () => {
      await result.current.handleConfirmUpload();
    });

    unmount();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(onPicked).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not clear the upload banner after unmount when endUpload delay is still pending', async () => {
    jest.useFakeTimers();
    const client = makeClient();
    seedCache(client);

    const mutateAsync = jest.fn(async () => ({
      file: {
        id: 'real-55',
        originalName: 'picked-photo.png',
        mime: 'image/png',
        size: 2048,
        createdAt: '2026-01-02T00:00:00.000Z',
        metadata: {},
        variants: [],
      },
    }));

    const { result, unmount } = renderHook(() => useFileUploadState(makeParams(mutateAsync)), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleFileUpload();
    });
    await act(async () => {
      await result.current.handleConfirmUpload();
    });

    expect(result.current.uploading).toBe(true);

    unmount();

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    jest.useRealTimers();
  });

  it('restricts the document picker to images when imagesOnly is true', async () => {
    const client = makeClient();
    seedCache(client);
    const mutateAsync = jest.fn(async () => ({ file: file('real-1') }));

    const { result } = renderHook(
      () => useFileUploadState({ ...makeParams(mutateAsync), imagesOnly: true }),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleFileUpload();
    });

    expect(getDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/*' }));
  });
});
