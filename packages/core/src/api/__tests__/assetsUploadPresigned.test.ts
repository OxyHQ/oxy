/**
 * `oxy.assets.upload()` never sends a request body the API's proxy refuses.
 *
 * api.oxy.so sits behind a proxy that answers 413 to any body over 100 MB, so a
 * file over {@link ASSET_MULTIPART_UPLOAD_MAX_BYTES} must go straight to storage
 * (hash → `/assets/init` → presigned PUT → `/assets/complete`) — on the web AND
 * on React Native — and come back in exactly the shape `/assets/upload` gives,
 * because callers read `file.visibility`, `file.metadata`, `file.variants`…
 * without knowing which path the file took.
 *
 * What is guarded, and why each would break silently:
 *
 *   - the boundary: a file AT the cap is one multipart request, one byte over
 *     is not; an SVG of any size stays on the API path (only it sanitizes);
 *   - the answer: every field `/assets/upload` returns is mapped, none invented;
 *   - React Native: a descriptor without a `size` is read into a NATIVE Blob
 *     through RN's XMLHttpRequest (Expo's `fetch` would copy it into the JS
 *     heap), hashed through `FileReader` (RN's Blob has no `arrayBuffer`), PUT
 *     through XMLHttpRequest, and its native bytes released afterwards.
 */

import { createHash } from 'node:crypto';
import { ASSET_MULTIPART_UPLOAD_MAX_BYTES } from '../assets';
import type { AssetInitResponse } from '../../models/interfaces';
import { stubbedClient } from './helpers';

const PRESIGNED = 'https://bucket.s3.amazonaws.com/object?X-Amz-Signature=synthetic';
const OVER = ASSET_MULTIPART_UPLOAD_MAX_BYTES + 1;

const committed = {
  assetId: 'asset-1',
  file: {
    id: 'asset-1',
    sha256: 'a'.repeat(64),
    size: OVER,
    mime: 'video/mp4',
    ext: 'mp4',
    originalName: 'clip.mp4',
    visibility: 'public',
    metadata: { source: 'camera' },
    status: 'active',
    usageCount: 0,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    links: [],
    variants: [{ type: 'poster', key: 'public/poster.jpg', width: 640, height: 360 }],
  },
};

/** `/assets/upload`'s answer for the same file, field for field. */
const uploadedShape = {
  id: 'asset-1',
  sha256: 'a'.repeat(64),
  size: OVER,
  mime: 'video/mp4',
  ext: 'mp4',
  originalName: 'clip.mp4',
  visibility: 'public',
  metadata: { source: 'camera' },
  links: [],
  variants: [{ type: 'poster', key: 'public/poster.jpg', width: 640, height: 360 }],
};

function bytesOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4093) bytes[i] = i % 251;
  return bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stubApi(init: AssetInitResponse) {
  const { oxy, request } = stubbedClient('user-1');
  const order: string[] = [];
  request.mockImplementation(async (_method: string, url: string) => {
    order.push(url);
    if (url === '/assets/init') return init;
    if (url === '/assets/complete') return committed;
    if (url === '/assets/upload') return { file: { id: 'via-api' } };
    throw new Error(`unexpected ${url}`);
  });
  return { oxy, request, order };
}

interface SentXhr {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

/**
 * An XMLHttpRequest that answers a GET of a local uri with `blobFor(uri)` (as
 * RN's networking does for `responseType: 'blob'`) and a PUT with 200.
 */
function installXhr(blobFor: (uri: string) => unknown, sent: SentXhr[], order: string[]) {
  class FakeXhr {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    status = 0;
    response: unknown = null;
    responseType = '';
    responseURL = '';
    withCredentials = true;
    timeout = 0;
    private record: SentXhr = { headers: {} };
    open(method: string, url: string) {
      this.record = { method, url, headers: {} };
    }
    setRequestHeader(name: string, value: string) {
      this.record.headers[name.toLowerCase()] = value;
    }
    send(body?: unknown) {
      this.record.body = body;
      this.record.timeout = this.timeout;
      sent.push(this.record);
      order.push(`${this.record.method} ${this.record.url}`);
      if (this.record.method === 'GET') {
        this.status = 200;
        this.response = blobFor(this.record.url ?? '');
      } else {
        this.upload.onprogress?.({ loaded: 1 });
        this.status = 200;
        this.responseURL = this.record.url ?? '';
      }
      this.onload?.();
    }
  }
  Reflect.set(globalThis, 'XMLHttpRequest', FakeXhr);
}

/**
 * React Native's Blob as RN 0.86 ships it: `size`, `type`, `slice` (a view onto
 * the same native bytes), `close` — and NO `arrayBuffer`.
 */
class NativeBlob {
  closed = false;
  constructor(
    readonly bytes: Uint8Array,
    readonly type = '',
    private readonly root?: NativeBlob,
  ) {}
  get size(): number {
    return this.bytes.length;
  }
  slice(start = 0, end = this.size, type = ''): NativeBlob {
    return new NativeBlob(this.bytes.subarray(start, end), type, this.root ?? this);
  }
  close(): void {
    (this.root ?? this).closed = true;
  }
}

/** RN's FileReader: reads one Blob's own range, then fires `load`. */
class NativeFileReader {
  result: ArrayBuffer | null = null;
  error: Error | null = null;
  onload?: () => void;
  onerror?: () => void;
  readAsArrayBuffer(blob: NativeBlob) {
    const copy = new Uint8Array(blob.bytes.length);
    copy.set(blob.bytes);
    this.result = copy.buffer;
    queueMicrotask(() => this.onload?.());
  }
}

describe('oxy.assets.upload — a file over the multipart cap', () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalFileReader = globalThis.FileReader;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
    if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
    else (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    if (originalFileReader === undefined) Reflect.deleteProperty(globalThis, 'FileReader');
    else globalThis.FileReader = originalFileReader;
    jest.restoreAllMocks();
  });

  describe('web', () => {
    beforeEach(() => Reflect.deleteProperty(globalThis, 'navigator'));

    it('goes straight to storage and answers in /assets/upload’s shape', async () => {
      const bytes = bytesOf(OVER);
      const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
      const { oxy, request, order } = stubApi({
        uploadUrl: PRESIGNED,
        fileId: 'f1',
        sha256: sha256Hex(bytes),
      });
      const sent: SentXhr[] = [];
      installXhr(() => null, sent, order);
      const progress: number[] = [];

      const result = await oxy.assets.upload(file, {
        visibility: 'public',
        metadata: { source: 'camera' },
        onProgress: (value) => progress.push(value),
      });

      expect(order).toEqual(['/assets/init', `PUT ${PRESIGNED}`, '/assets/complete']);
      expect(request.mock.calls[0][2]).toEqual({
        sha256: sha256Hex(bytes),
        size: OVER,
        mime: 'video/mp4',
      });
      expect(sent[0].body).toBe(file);
      expect(sent[0].headers['content-type']).toBe('video/mp4');
      expect(sent[0].headers.authorization).toBeUndefined();
      // The caller's bound reaches the PUT, as it bounded the multipart POST.
      expect(sent[0].timeout).toBe(10 * 60 * 1000);
      expect(request.mock.calls[1][2]).toEqual({
        fileId: 'f1',
        originalName: 'clip.mp4',
        size: OVER,
        mime: 'video/mp4',
        visibility: 'public',
        metadata: { source: 'camera' },
      });
      expect(request.mock.calls[1][3]).toEqual({ cache: false, timeout: 10 * 60 * 1000 });
      expect(result).toEqual({ file: uploadedShape });
      // Same contract as the multipart path: one call, with 100, at the end.
      expect(progress).toEqual([100]);
    });

    it('a file AT the cap is still one multipart request', async () => {
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      const blob = new Blob([new Uint8Array(ASSET_MULTIPART_UPLOAD_MAX_BYTES)], {
        type: 'video/mp4',
      });

      const result = await oxy.assets.upload(blob);

      expect(order).toEqual(['/assets/upload']);
      expect(result).toEqual({ file: { id: 'via-api' } });
    });

    it('an SVG of any size stays on the API path, which sanitizes it', async () => {
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      const svg = new Blob([new Uint8Array(OVER)], { type: 'image/svg+xml' });

      await oxy.assets.upload(svg);

      expect(order).toEqual(['/assets/upload']);
    });

    it('a large { uri } descriptor is materialised once and goes straight to storage', async () => {
      const bytes = bytesOf(OVER);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => new Blob([bytes]),
      }) as unknown as typeof fetch;
      const { oxy, order } = stubApi({ uploadUrl: '', fileId: 'f1', sha256: sha256Hex(bytes) });

      const result = await oxy.assets.upload({
        uri: 'blob:https://app.test/clip',
        type: 'video/mp4',
        name: 'clip.mp4',
      });

      // Already stored for this account: no PUT, still committed.
      expect(order).toEqual(['/assets/init', '/assets/complete']);
      expect(result.file).toEqual(uploadedShape);
    });

    it('a refused PUT fails the upload without committing anything', async () => {
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      class RefusingXhr {
        upload = {};
        onload?: () => void;
        status = 403;
        responseURL = PRESIGNED;
        open() {}
        setRequestHeader() {}
        send() {
          this.onload?.();
        }
      }
      Reflect.set(globalThis, 'XMLHttpRequest', RefusingXhr);

      await expect(
        oxy.assets.upload(new Blob([new Uint8Array(OVER)], { type: 'video/mp4' })),
      ).rejects.toThrow('403');
      expect(order).toEqual(['/assets/init']);
    });
  });

  describe('React Native', () => {
    beforeEach(() => {
      (globalThis as { navigator?: unknown }).navigator = { product: 'ReactNative' };
      Reflect.set(globalThis, 'FileReader', NativeFileReader);
    });

    it('reads a size-less descriptor natively, hashes it via FileReader, PUTs it, releases it', async () => {
      const bytes = bytesOf(OVER);
      const native = new NativeBlob(bytes);
      const fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const { oxy, request, order } = stubApi({
        uploadUrl: PRESIGNED,
        fileId: 'f1',
        sha256: sha256Hex(bytes),
      });
      const sent: SentXhr[] = [];
      installXhr(() => native, sent, order);

      const result = await oxy.assets.upload(
        { uri: 'file:///data/clip.mp4', type: 'video/mp4', name: 'clip.mp4' },
        { visibility: 'public', metadata: { source: 'camera' } },
      );

      // Never Expo's fetch, which would copy the video into the JS heap.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(order).toEqual([
        'GET file:///data/clip.mp4',
        '/assets/init',
        `PUT ${PRESIGNED}`,
        '/assets/complete',
      ]);
      expect(sent[0].body).toBeUndefined();
      // The digest is the file's real SHA-256, read across 8 MiB chunks.
      expect(request.mock.calls[0][2]).toEqual({
        sha256: sha256Hex(bytes),
        size: OVER,
        mime: 'video/mp4',
      });
      const put = sent[1];
      expect(put.body).toBeInstanceOf(NativeBlob);
      expect((put.body as NativeBlob).size).toBe(OVER);
      expect(put.headers['content-type']).toBe('video/mp4');
      expect(result).toEqual({ file: uploadedShape });
      expect(native.closed).toBe(true);
    });

    it('a size-less descriptor that turns out small goes multipart as-is, its read released', async () => {
      const native = new NativeBlob(bytesOf(1024), 'image/jpeg');
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      installXhr(() => native, [], order);
      const appended: unknown[] = [];
      jest.spyOn(FormData.prototype, 'append').mockImplementation((name, value) => {
        if (name === 'file') appended.push(value);
      });
      const descriptor = { uri: 'file:///data/photo.jpg', type: 'image/jpeg', name: 'photo.jpg' };

      await oxy.assets.upload(descriptor);

      expect(order).toEqual(['GET file:///data/photo.jpg', '/assets/upload']);
      expect(appended).toEqual([descriptor]);
      expect(native.closed).toBe(true);
    });

    it('a uri only RN’s FormData can open still uploads multipart, as before', async () => {
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      class UnreadableXhr {
        onerror?: () => void;
        open() {}
        send() {
          order.push('GET (refused)');
          this.onerror?.();
        }
      }
      Reflect.set(globalThis, 'XMLHttpRequest', UnreadableXhr);
      const appended: unknown[] = [];
      jest.spyOn(FormData.prototype, 'append').mockImplementation((name, value) => {
        if (name === 'file') appended.push(value);
      });
      const descriptor = { uri: 'ph://library/asset', type: 'image/heic', name: 'photo.heic' };

      await oxy.assets.upload(descriptor);

      expect(order).toEqual(['GET (refused)', '/assets/upload']);
      expect(appended).toEqual([descriptor]);
    });

    it('a descriptor whose size says small is never read in JS at all', async () => {
      const { oxy, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      installXhr(
        () => {
          throw new Error('read');
        },
        [],
        order,
      );
      jest.spyOn(FormData.prototype, 'append').mockImplementation(() => undefined);

      await oxy.assets.upload({
        uri: 'file:///data/photo.jpg',
        type: 'image/jpeg',
        name: 'photo.jpg',
        size: 2048,
      });

      expect(order).toEqual(['/assets/upload']);
    });

    it('an empty file is refused before any request, its read released', async () => {
      const native = new NativeBlob(new Uint8Array(0));
      const { oxy, request, order } = stubApi({ uploadUrl: PRESIGNED, fileId: 'f1', sha256: 'x' });
      installXhr(() => native, [], order);

      await expect(
        oxy.assets.upload({ uri: 'file:///data/empty.mp4', type: 'video/mp4' }),
      ).rejects.toThrow('Cannot upload an empty file');
      expect(request).not.toHaveBeenCalled();
      expect(native.closed).toBe(true);
    });
  });
});
