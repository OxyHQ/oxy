/**
 * Tests for the private-safe file-URL resolver used by FileManagementScreen.
 *
 * Pins the two bug fixes this hook exists for:
 *  - Bug 1 (private thumbnails): image/video files resolve their thumbnail URL
 *    through the authenticated BATCH endpoint (one call per page, per-file
 *    variant), never the synchronous public-CDN URL that 404s for private
 *    assets. Public assets flow through the same batch and get the CDN URL.
 *  - Bug 2 (`temp-` leak): an optimistic `temp-…`/`uploading` entry is NEVER
 *    included in the batch request and NEVER yields an asset URL — its preview
 *    is the locally-picked uri.
 */

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileMetadata } from '@oxy.so/core';
import {
  isOptimisticFile,
  fileThumbSource,
  useResolvedFileUrls,
  type AssetUrlBatchResolver,
} from '../../src/ui/hooks/useResolvedFileUrls';

const makeFile = (over: Partial<FileMetadata> & Pick<FileMetadata, 'id' | 'contentType'>): FileMetadata => ({
  filename: 'file',
  length: 1,
  chunkSize: 0,
  uploadDate: '2026-01-01T00:00:00.000Z',
  metadata: {},
  variants: [],
  ...over,
});

const makeWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('isOptimisticFile', () => {
  it('is true for a client-minted temp- id', () => {
    expect(isOptimisticFile({ id: 'temp-123-0-abc', metadata: {} })).toBe(true);
  });

  it('is true for an uploading flag even with a non-temp id', () => {
    expect(isOptimisticFile({ id: 'real123', metadata: { uploading: true } })).toBe(true);
  });

  it('is false for a persisted file', () => {
    expect(isOptimisticFile({ id: 'real123', metadata: {} })).toBe(false);
    expect(isOptimisticFile({ id: 'real123', metadata: undefined })).toBe(false);
  });
});

describe('fileThumbSource', () => {
  const resolved = new Map<string, string>([
    ['real123', 'https://api.oxy.so/assets/real123/stream?variant=thumb&mt=tok'],
  ]);

  it('uses the local preview uri for an optimistic entry (never an asset URL)', () => {
    const file = makeFile({
      id: 'temp-1-0-x',
      contentType: 'image/png',
      metadata: { uploading: true, localPreviewUri: 'file:///picked.png' },
    });
    expect(fileThumbSource(file, resolved)).toBe('file:///picked.png');
  });

  it('returns undefined for an optimistic entry with no local preview', () => {
    const file = makeFile({
      id: 'temp-2-0-y',
      contentType: 'image/png',
      metadata: { uploading: true },
    });
    // Critically: it does NOT fall back to any asset URL for the temp id.
    expect(fileThumbSource(file, resolved)).toBeUndefined();
  });

  it('returns the resolved private-safe URL for a persisted file', () => {
    const file = makeFile({ id: 'real123', contentType: 'image/png' });
    expect(fileThumbSource(file, resolved)).toBe(
      'https://api.oxy.so/assets/real123/stream?variant=thumb&mt=tok',
    );
  });

  it('returns undefined while a persisted file is still resolving', () => {
    const file = makeFile({ id: 'notyet', contentType: 'image/png' });
    expect(fileThumbSource(file, resolved)).toBeUndefined();
  });
});

describe('useResolvedFileUrls', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('resolves image/video files via one batch call with per-file variants, excluding temp- and documents', async () => {
    const getFileDownloadUrls = jest.fn(async () => ({
      privImg: 'https://api.oxy.so/assets/privImg/stream?variant=thumb&mt=tok',
      pubImg: 'https://cloud.oxy.so/pubImg?variant=thumb',
      vid: 'https://api.oxy.so/assets/vid/stream?variant=poster&mt=tok',
    }));
    const oxyServices: AssetUrlBatchResolver = { getFileDownloadUrls };

    const files: FileMetadata[] = [
      makeFile({ id: 'privImg', contentType: 'image/png' }),
      makeFile({ id: 'pubImg', contentType: 'image/jpeg' }),
      makeFile({ id: 'vid', contentType: 'video/mp4' }),
      makeFile({ id: 'doc', contentType: 'application/pdf' }),
      makeFile({ id: 'temp-9-0-z', contentType: 'image/png', metadata: { uploading: true } }),
    ];

    const { result } = renderHook(() => useResolvedFileUrls(oxyServices, files, 'viewer-a'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(getFileDownloadUrls).toHaveBeenCalledTimes(1));

    const [requests, options] = getFileDownloadUrls.mock.calls[0];
    // Only real image/video files; per-file variant; NO temp- id, NO document.
    expect(requests).toEqual([
      { fileId: 'privImg', variant: 'thumb' },
      { fileId: 'pubImg', variant: 'thumb' },
      { fileId: 'vid', variant: 'poster' },
    ]);
    expect((requests as Array<{ fileId: string }>).some((r) => r.fileId.startsWith('temp-'))).toBe(false);
    // Token TTL is passed so the URL carries a valid scoped media token.
    expect(options).toEqual({ expiresIn: 600 });

    await waitFor(() => expect(result.current.get('privImg')).toBeDefined());
    // Private image resolves through the batch (authenticated stream URL)...
    expect(result.current.get('privImg')).toContain('/stream?');
    expect(result.current.get('privImg')).toContain('mt=');
    // ...and a public image still gets the plain CDN URL through the same batch.
    expect(result.current.get('pubImg')).toBe('https://cloud.oxy.so/pubImg?variant=thumb');
    expect(result.current.get('vid')).toContain('variant=poster');
  });

  it('does not call the resolver when there are no resolvable files', () => {
    const getFileDownloadUrls = jest.fn(async () => ({}));
    const oxyServices: AssetUrlBatchResolver = { getFileDownloadUrls };
    const files: FileMetadata[] = [
      makeFile({ id: 'doc', contentType: 'application/pdf' }),
      makeFile({ id: 'temp-1-0-a', contentType: 'image/png', metadata: { uploading: true } }),
    ];

    renderHook(() => useResolvedFileUrls(oxyServices, files), {
      wrapper: makeWrapper(queryClient),
    });

    expect(getFileDownloadUrls).not.toHaveBeenCalled();
  });

  it('omits denied/missing ids from the map (no fallback URL)', async () => {
    // Server allowed only one of the two requested files.
    const getFileDownloadUrls = jest.fn(async () => ({
      okImg: 'https://api.oxy.so/assets/okImg/stream?variant=thumb&mt=tok',
    }));
    const oxyServices: AssetUrlBatchResolver = { getFileDownloadUrls };
    const files: FileMetadata[] = [
      makeFile({ id: 'okImg', contentType: 'image/png' }),
      makeFile({ id: 'deniedImg', contentType: 'image/png' }),
    ];

    const { result } = renderHook(() => useResolvedFileUrls(oxyServices, files, 'viewer-a'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.get('okImg')).toBeDefined());
    expect(result.current.get('deniedImg')).toBeUndefined();
  });

  it('scopes the React Query cache to the active viewer id', async () => {
    const getFileDownloadUrls = jest
      .fn()
      .mockResolvedValueOnce({
        privImg: 'https://api.oxy.so/assets/privImg/stream?variant=thumb&mt=token-a',
      })
      .mockResolvedValueOnce({
        privImg: 'https://api.oxy.so/assets/privImg/stream?variant=thumb&mt=token-b',
      });
    const oxyServices: AssetUrlBatchResolver = { getFileDownloadUrls };
    const files: FileMetadata[] = [makeFile({ id: 'privImg', contentType: 'image/png' })];

    const { result, rerender } = renderHook(
      ({ viewerId }: { viewerId: string }) => useResolvedFileUrls(oxyServices, files, viewerId),
      {
        wrapper: makeWrapper(queryClient),
        initialProps: { viewerId: 'viewer-a' },
      },
    );

    await waitFor(() => expect(result.current.get('privImg')).toBeDefined());
    expect(result.current.get('privImg')).toContain('mt=token-a');

    rerender({ viewerId: 'viewer-b' });

    await waitFor(() => expect(getFileDownloadUrls).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.get('privImg')).toContain('mt=token-b'));
    expect(result.current.get('privImg')).not.toContain('mt=token-a');
  });
});
