/**
 * Covers the file library's bloom-data layer (`data/files.ts`):
 *
 *  - Paging: `useUserFilesInfinite` walks the offset cursor and appends pages
 *    on `more`.
 *  - The listing helpers (prepend / remove / replace / patch) that back
 *    optimistic upload, delete, and visibility changes.
 *  - The optimistic-upload lifecycle in `useFileUploadState`, pinning the
 *    `temp-` id contract against the HELD LIBRARY:
 *      · in flight, the optimistic entry carries the picked uri + `uploading`
 *        flag so the grid never builds an asset URL from a `temp-…` id;
 *      · on success WITH a payload, the temp entry is replaced by the real file;
 *      · on success WITHOUT a payload, the temp entry is removed (not stranded);
 *      · on failure, the temp entry is removed;
 *      · a successful upload reads the library again (the reconcile).
 *
 * The document picker is stubbed; every other helper is the real module.
 */

import { renderHook, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Platform } from 'react-native';
import { type Store, withStore } from '@oxy.so/bloom-data';
import type { FileMetadata } from '@oxy.so/core';
import { fileThumbSource } from '../../src/ui/hooks/useResolvedFileUrls';
import FileLibraryError from '../../src/ui/screens/fileManagement/FileLibraryError';
import { useUserFilesInfinite } from '../../src/ui/hooks/queries/useFileQueries';
import {
  patchUserFileMetadata,
  prependUserFile,
  type RawUserFile,
  removeUserFile,
  replaceUserFile,
  UserFile,
  UserFiles,
  userFilesKey,
} from '../../src/ui/data/files';
import type { useUploadFile } from '../../src/ui/hooks/mutations/useAccountMutations';
import { dataWrapper, openTestStore } from '../helpers/dataStore';

// Stub only the lazy document-picker loader; keep every other helper real.
const getDocumentAsync = jest.fn();
jest.mock('../../src/ui/screens/fileManagement/shared', () => {
  const actual = jest.requireActual('../../src/ui/screens/fileManagement/shared');
  return {
    __esModule: true,
    ...actual,
    loadDocumentPicker: () => Promise.resolve({ getDocumentAsync }),
  };
});

// `useUserFilesInfinite` reads oxyServices from context; the upload hook does not.
const listUserFiles = jest.fn();
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ oxyServices: { assets: { list: listUserFiles } }, activeSessionId: 's1' }),
}));

// Vector icons are stubbed globally via jest.config.js moduleNameMapper.

import { useFileUploadState } from '../../src/ui/screens/fileManagement/hooks/useFileUploadState';

const OWNER = 'u1';
const KEY = userFilesKey(OWNER, 'library');
const PICKED_URI = 'file:///picked-photo.png';

type UploadMutation = ReturnType<typeof useUploadFile>;

const makeClient = (): Store => openTestStore();
const wrapper = dataWrapper;

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

// Hold a library (optionally populated) as if its first page had been read,
// so optimistic prepends have somewhere to land.
const seedCache = (store: Store, files: FileMetadata[] = []) =>
  withStore(store, () => {
    UserFile.put(files);
    UserFiles.set(KEY, () => ({
      ids: files.map((f) => f.id),
      extra: undefined,
      next: undefined,
      hasMore: false,
      visited: [],
      updatedAt: Date.now(),
      origin: 'network',
    }));
  });

const cachedFiles = (store: Store): FileMetadata[] =>
  withStore(store, () =>
    (UserFiles.get(KEY)?.ids ?? []).flatMap((id) => {
      const held = UserFile.get(id);
      return held ? [held] : [];
    }),
  );

const tempEntries = (store: Store) => cachedFiles(store).filter((f) => f.id.startsWith('temp-'));

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

describe('file listing helpers', () => {
  it('prepend adds to the top; remove drops by id', () => {
    const store = makeClient();
    seedCache(store, [file('a'), file('b')]);
    withStore(store, () => prependUserFile(OWNER, file('new')));
    expect(cachedFiles(store).map((f) => f.id)).toEqual(['new', 'a', 'b']);
    withStore(store, () => removeUserFile(OWNER, 'a'));
    expect(cachedFiles(store).map((f) => f.id)).toEqual(['new', 'b']);
  });

  it('replace swaps one file for another; patch merges metadata', () => {
    const store = makeClient();
    seedCache(store, [file('a'), file('b')]);
    withStore(store, () => replaceUserFile(OWNER, 'a', { ...file('real'), filename: 'real.jpg' }));
    expect(cachedFiles(store).map((f) => f.id)).toEqual(['real', 'b']);
    withStore(store, () => patchUserFileMetadata('b', { visibility: 'public' }));
    const b = cachedFiles(store).find((f) => f.id === 'b');
    expect((b?.metadata as { visibility?: string } | undefined)?.visibility).toBe('public');
  });

  it('helpers leave no listing behind when none was read (upload before the first page)', () => {
    const store = makeClient();
    withStore(store, () => prependUserFile(OWNER, file('x')));
    expect(withStore(store, () => UserFiles.get(KEY))).toBeUndefined();
  });
});

describe('useUserFilesInfinite paging', () => {
  it('reads nothing until there is an owner (a gated read)', async () => {
    listUserFiles.mockReset();
    const client = makeClient();
    const { result } = renderHook(() => useUserFilesInfinite(undefined), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listUserFiles).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.files).toEqual([]);
  });

  beforeEach(() => {
    listUserFiles.mockReset();
  });

  it('walks the offset cursor across pages via getNextPageParam', async () => {
    listUserFiles.mockImplementation(async ({ offset }: { limit: number; offset: number }) =>
      offset === 0
        ? { files: [raw('a'), raw('b')], total: 3, hasMore: true }
        : { files: [raw('c')], total: 3, hasMore: false },
    );
    const client = makeClient();
    const { result } = renderHook(() => useUserFilesInfinite(OWNER), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(['a', 'b']));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.more();
    });

    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.files.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(listUserFiles).toHaveBeenCalledTimes(2);
    expect(listUserFiles).toHaveBeenLastCalledWith({ limit: 40, offset: 40 });
  });
});

describe('load error state (distinct from empty)', () => {
  beforeEach(() => {
    listUserFiles.mockReset();
  });

  it('a rejected fetch yields isError with no data — a resolved-empty fetch does not', async () => {
    // Rejecting fetch → terminal error, no data (the render branches on this).
    // A refusal another attempt cannot change is not retried (`sdkRead`).
    listUserFiles.mockRejectedValue(Object.assign(new Error('refused'), { status: 403 }));
    const failClient = makeClient();
    const { result: failed } = renderHook(() => useUserFilesInfinite(OWNER), {
      wrapper: wrapper(failClient),
    });
    await waitFor(() => expect(failed.current.isError).toBe(true));
    expect(failed.current.files).toEqual([]);

    // Resolving empty → NOT an error; an empty (but present) first page.
    listUserFiles.mockResolvedValue({ files: [], total: 0, hasMore: false });
    const emptyClient = makeClient();
    const { result: empty } = renderHook(() => useUserFilesInfinite(OWNER), {
      wrapper: wrapper(emptyClient),
    });
    await waitFor(() => expect(empty.current.isLoading).toBe(false));
    expect(empty.current.isError).toBe(false);
    expect(empty.current.files).toEqual([]);
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

describe('useFileUploadState optimistic lifecycle (held library)', () => {
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

  it('keeps the header-facing handlers referentially stable across re-renders', () => {
    // FileManagementScreen feeds `handleFileUpload` into the picker header's
    // `primaryAction` memo and `handleCancelUpload` into the upload-preview
    // header's back NODE (`fmHeaderBack`). A node can only be compared by
    // identity, so a handler re-created every render re-creates the node every
    // render, which drives the surface-header bridge into an unbounded update
    // loop (React error #185 — the profile-banner black screen).
    const client = makeClient();
    seedCache(client);
    // Stable params, as the real screen supplies them (`t` from `useTranslation`).
    const params = makeParams(jest.fn());

    const { result, rerender } = renderHook(() => useFileUploadState(params), {
      wrapper: wrapper(client),
    });

    const first = result.current;
    rerender();
    rerender();

    expect(result.current.handleFileUpload).toBe(first.handleFileUpload);
    expect(result.current.handleCancelUpload).toBe(first.handleCancelUpload);
  });

  it('shows the picked uri (never a temp asset URL) while uploading, then removes the temp entry when the response has no file payload', async () => {
    const client = makeClient();
    seedCache(client);

    let resolveUpload: (value: unknown) => void = () => undefined;
    const mutateAsync = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

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

    // In flight: exactly one optimistic entry in the library, flagged + carrying the picked uri.
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

    // Reconciled: no stranded temp- entry remains in the library.
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

  it('reads the held library again after a successful upload (the reconcile)', async () => {
    listUserFiles.mockReset();
    listUserFiles.mockResolvedValue({ files: [raw('real-7')], total: 1, hasMore: false });
    const client = makeClient();
    seedCache(client);
    const mutateAsync = jest.fn(async () => ({ file: { id: 'real-7', originalName: 'a.png' } }));

    const { result } = renderHook(() => useFileUploadState(makeParams(mutateAsync)), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.handleFileUpload();
    });
    await act(async () => {
      await result.current.handleConfirmUpload();
    });

    await waitFor(() => expect(listUserFiles).toHaveBeenCalledWith({ limit: 40, offset: 0 }));
    await waitFor(() => expect(cachedFiles(client).map((f) => f.id)).toEqual(['real-7']));
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
