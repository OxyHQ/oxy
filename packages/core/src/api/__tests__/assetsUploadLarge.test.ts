/**
 * `oxy.assets.initUpload` / `completeUpload` / `uploadLarge`: the direct-to-
 * storage upload, with no byte passing through the API.
 *
 * What is guarded is the ORDER and the two branches, because each mistake has a
 * real cost:
 *
 *   - hashing after `init` would spend the presigned URL's short expiry (a
 *     minute where storage is metered) reading the file, so a large file would
 *     always PUT to a dead URL;
 *   - PUTting on the dedupe answer (empty `uploadUrl`) would throw on `new URL('')`
 *     for every file the account already holds, and skipping `complete` there
 *     would leave the row uncommitted;
 *   - the digest has to be the file's real SHA-256, across chunk boundaries,
 *     because the server signs the PUT for it.
 */

import { createHash } from 'node:crypto';
import type { AssetInitResponse } from '../../models/interfaces';
import { stubbedClient } from './helpers';

const PRESIGNED = 'https://bucket.s3.amazonaws.com/object?X-Amz-Signature=synthetic';

const completed = {
  assetId: 'asset-1',
  file: {
    id: 'asset-1',
    sha256: 'a'.repeat(64),
    size: 3,
    mime: 'video/mp4',
    status: 'active',
    usageCount: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    links: [],
    variants: [],
  },
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Routes `oxy.request` by path, recording the order of every call. */
function stubApi(init: AssetInitResponse) {
  const { oxy, request } = stubbedClient('user-1');
  const order: string[] = [];
  request.mockImplementation(async (_method: string, url: string) => {
    order.push(url);
    if (url === '/assets/init') return init;
    if (url === '/assets/complete') return completed;
    throw new Error(`unexpected ${url}`);
  });
  return { oxy, request, order };
}

describe('assets.initUpload / completeUpload', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POST the two steps of the upload, uncached', async () => {
    const { oxy, request } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'a' });

    await oxy.assets.initUpload({ sha256: 'a'.repeat(64), size: 3, mime: 'video/mp4' });
    await oxy.assets.completeUpload({
      fileId: 'f1',
      originalName: 'clip.mp4',
      size: 3,
      mime: 'video/mp4',
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/assets/init',
      { sha256: 'a'.repeat(64), size: 3, mime: 'video/mp4' },
      { cache: false },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/assets/complete',
      { fileId: 'f1', originalName: 'clip.mp4', size: 3, mime: 'video/mp4' },
      { cache: false },
    );
  });
});

describe('assets.uploadLarge', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
    jest.restoreAllMocks();
  });

  it('hashes, then inits, then PUTs, then completes — and the digest is the real one', async () => {
    // Just over two hash chunks, so the digest is checked across boundaries.
    const bytes = new Uint8Array(16 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const { oxy, request, order } = stubApi({
      uploadUrl: PRESIGNED,
      fileId: 'f1',
      sha256: sha256Hex(bytes),
      requiredHeaders: { 'If-None-Match': '*' },
    });
    const fetcher = jest.fn(async (url: string) => {
      order.push(url);
      return { ok: true, status: 200 } as Response;
    });
    global.fetch = fetcher as unknown as typeof fetch;
    const phases: string[] = [];

    const result = await oxy.assets.uploadLarge(blob, {
      name: 'clip.mp4',
      visibility: 'public',
      onProgress: ({ phase }) => phases.push(phase),
    });

    expect(order).toEqual(['/assets/init', PRESIGNED, '/assets/complete']);
    // Every hash report precedes the first upload report: no byte was read
    // after the presigned URL's clock started.
    expect(phases.lastIndexOf('hash')).toBeLessThan(phases.indexOf('upload'));
    expect(request.mock.calls[0][2]).toEqual({
      sha256: sha256Hex(bytes),
      size: bytes.length,
      mime: 'video/mp4',
    });
    const put = fetcher.mock.calls[0][1] as unknown as RequestInit & { headers: Headers };
    expect(put.method).toBe('PUT');
    expect(put.body).toBe(blob);
    expect(put.headers.get('If-None-Match')).toBe('*');
    expect(put.headers.get('Content-Type')).toBe('video/mp4');
    expect(put.headers.has('Authorization')).toBe(false);
    expect(put.credentials).toBe('omit');
    expect(request.mock.calls[1][2]).toEqual({
      fileId: 'f1',
      originalName: 'clip.mp4',
      size: bytes.length,
      mime: 'video/mp4',
      visibility: 'public',
    });
    expect(result).toEqual({ ...completed, deduplicated: false });
  });

  it('skips the PUT when the bytes are already stored, and still completes', async () => {
    const { oxy, order } = stubApi({ uploadUrl: '', fileId: 'existing', sha256: 'x' });
    const fetcher = jest.fn();
    global.fetch = fetcher;
    const uploads: number[] = [];

    const result = await oxy.assets.uploadLarge(new Blob(['abc'], { type: 'text/plain' }), {
      onProgress: ({ phase, loaded }) => phase === 'upload' && uploads.push(loaded),
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(order).toEqual(['/assets/init', '/assets/complete']);
    expect(uploads).toEqual([3]);
    expect(result.deduplicated).toBe(true);
  });

  it('reports hash and upload progress as bytes of the file, through XHR on the web', async () => {
    const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown } =
      { headers: {} };
    class FakeXhr {
      upload: { onprogress?: (event: { loaded: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      status = 0;
      responseURL = '';
      withCredentials = true;
      open(method: string, url: string) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader(name: string, value: string) {
        sent.headers[name.toLowerCase()] = value;
      }
      send(body: unknown) {
        sent.body = body;
        this.upload.onprogress?.({ loaded: 1 });
        this.upload.onprogress?.({ loaded: 3 });
        this.status = 200;
        this.responseURL = sent.url ?? '';
        this.onload?.();
      }
    }
    Reflect.set(globalThis, 'XMLHttpRequest', FakeXhr);
    const fetcher = jest.fn();
    global.fetch = fetcher;
    const { oxy } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
    const events: Array<[string, number, number]> = [];

    await oxy.assets.uploadLarge(new Blob(['abc']), {
      mime: 'audio/ogg',
      onProgress: ({ phase, loaded, total }) => events.push([phase, loaded, total]),
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(PRESIGNED);
    // A Blob with no type is re-typed to the MIME the URL was signed for.
    expect(sent.headers['content-type']).toBe('audio/ogg');
    expect(sent.headers.authorization).toBeUndefined();
    expect(events).toEqual([
      ['hash', 0, 3],
      ['hash', 3, 3],
      ['upload', 0, 3],
      ['upload', 1, 3],
      ['upload', 3, 3],
      ['upload', 3, 3],
    ]);
  });

  it('fails without completing when the PUT is refused', async () => {
    const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

    await expect(oxy.assets.uploadLarge(new Blob(['abc'], { type: 'text/plain' }))).rejects.toThrow(
      '403',
    );
    expect(order).toEqual(['/assets/init']);
  });

  it('refuses an empty file or a missing MIME type before any request', async () => {
    const { oxy, request } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });

    await expect(oxy.assets.uploadLarge(new Blob([], { type: 'text/plain' }))).rejects.toThrow(
      'empty',
    );
    await expect(oxy.assets.uploadLarge(new Blob(['abc']))).rejects.toThrow('MIME');
    expect(request).not.toHaveBeenCalled();
  });
});
