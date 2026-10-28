/**
 * `oxy.assets.upload()` never sends a request body the API's proxy refuses.
 *
 * api.oxy.so sits behind a proxy that answers 413 to any body over 100 MB, so a
 * file over {@link ASSET_MULTIPART_UPLOAD_MAX_BYTES} must go straight to storage
 * (hash → `/assets/uploads` → presigned MULTIPART parts → complete, ADR 0047) —
 * on the web AND on React Native — and come back in exactly the shape
 * `/assets/upload` gives,
 * because callers read `file.visibility`, `file.metadata`, `file.variants`…
 * without knowing which path the file took.
 *
 * What is guarded, and why each would break silently:
 *
 *   - the boundary: a file AT the cap is one multipart request, one byte over
 *     is not; an SVG of any size stays on the API path (only it sanitizes);
 *   - the answer: every field `/assets/upload` returns is mapped, none invented;
 *   - React Native: metadata and bounded file ranges come from the SDK adapter,
 *     never a whole-file Blob allocation. Known-small descriptors remain native
 *     FormData; missing/unreadable adapters cannot fall back to oversized bodies.
 */

import { createHash } from 'node:crypto';
import { ASSET_MULTIPART_UPLOAD_MAX_BYTES } from '../assets';
import { stubbedClient } from './helpers';

const PART = 'https://oxy-files.acct.r2.cloudflarestorage.com/staging?partNumber=';
const OVER = ASSET_MULTIPART_UPLOAD_MAX_BYTES + 1;
const PART_SIZE = 8 * 1024 * 1024;
const PART_COUNT = Math.ceil(OVER / PART_SIZE);
const PUTS = Array.from({ length: PART_COUNT }, (_, i) => `PUT ${PART}${i + 1}`);

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

/** An open session for `size` bytes with URLs for every part (one call's worth). */
function openSession(size: number) {
  const count = Math.ceil(size / PART_SIZE);
  return {
    uploadId: 'up-1',
    status: 'uploading',
    size,
    partSize: PART_SIZE,
    partCount: count,
    parts: Array.from({ length: count }, (_, i) => ({
      partNumber: i + 1,
      url: `${PART}${i + 1}`,
      size: i + 1 < count ? PART_SIZE : size - PART_SIZE * (count - 1),
    })),
  };
}

/** The upload-session routes; `open` answers `POST /assets/uploads`. */
function stubApi(open: (body: Record<string, unknown>) => unknown) {
  const { oxy, request } = stubbedClient('user-1');
  const order: string[] = [];
  request.mockImplementation(async (_method: string, url: string, body?: unknown) => {
    order.push(url);
    if (url === '/assets/uploads') return open(body as Record<string, unknown>);
    if (url === '/assets/uploads/up-1/complete') {
      return { uploadId: 'up-1', status: 'completed', size: OVER, file: { id: 'asset-1' } };
    }
    if (url === '/assets/asset-1') return committed;
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
    onloadend?: () => void;
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
      this.onloadend?.();
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

    it('goes straight to storage, part by part, and answers in /assets/upload’s shape', async () => {
      const bytes = bytesOf(OVER);
      const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
      const { oxy, request, order } = stubApi(() => openSession(OVER));
      const sent: SentXhr[] = [];
      installXhr(() => null, sent, order);
      const progress: number[] = [];

      const result = await oxy.assets.upload(file, {
        visibility: 'public',
        metadata: { source: 'camera' },
        onProgress: (value) => progress.push(value),
      });

      expect(order).toEqual([
        '/assets/uploads',
        ...PUTS,
        '/assets/uploads/up-1/complete',
        '/assets/asset-1',
      ]);
      expect(request.mock.calls[0][2]).toEqual({
        sha256: sha256Hex(bytes),
        size: OVER,
        mime: 'video/mp4',
        filename: 'clip.mp4',
        visibility: 'public',
        metadata: { source: 'camera' },
      });
      // Every part is a slice of the file, its exact signed length, with nothing
      // of the caller's riding along.
      expect(sent.map((put) => (put.body as Blob).size)).toEqual([
        ...Array(PART_COUNT - 1).fill(PART_SIZE),
        OVER - PART_SIZE * (PART_COUNT - 1),
      ]);
      expect(sent.every((put) => put.headers.authorization === undefined)).toBe(true);
      expect(result).toEqual({ file: uploadedShape });
      expect(progress.at(-1)).toBe(100);
    });

    it('a file AT the cap is still one multipart request', async () => {
      const { oxy, order } = stubApi(() => openSession(OVER));
      const blob = new Blob([new Uint8Array(ASSET_MULTIPART_UPLOAD_MAX_BYTES)], {
        type: 'video/mp4',
      });

      const result = await oxy.assets.upload(blob);

      expect(order).toEqual(['/assets/upload']);
      expect(result).toEqual({ file: { id: 'via-api' } });
    });

    it('an SVG of any size stays on the API path, which sanitizes it', async () => {
      const { oxy, order } = stubApi(() => openSession(OVER));
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
      const { oxy, order } = stubApi(() => ({
        uploadId: null,
        status: 'completed',
        size: OVER,
        file: { id: 'asset-1' },
        deduplicated: true,
      }));

      const result = await oxy.assets.upload({
        uri: 'blob:https://app.test/clip',
        type: 'video/mp4',
        name: 'clip.mp4',
      });

      // Already yours: nothing sent, the file answered.
      expect(order).toEqual(['/assets/uploads', '/assets/asset-1']);
      expect(result.file).toEqual(uploadedShape);
    });

    it('a part storage keeps refusing stops the upload, resumably, without completing', async () => {
      const { oxy, order } = stubApi(() => openSession(OVER));
      class RefusingXhr {
        upload = {};
        onload?: () => void;
        onloadend?: () => void;
        status = 500;
        responseURL = '';
        open(_method: string, url: string) {
          this.responseURL = url;
        }
        setRequestHeader() {}
        send() {
          this.onload?.();
          this.onloadend?.();
        }
      }
      Reflect.set(globalThis, 'XMLHttpRequest', RefusingXhr);

      await expect(
        oxy.assets.uploadLarge(new Blob([new Uint8Array(OVER)], { type: 'video/mp4' }), {
          partAttempts: 1,
        }),
      ).rejects.toMatchObject({ name: 'DirectUploadInterruptedError', uploadId: 'up-1' });
      expect(order).toEqual(['/assets/uploads']);
    });
  });

  describe('React Native', () => {
    beforeEach(() => {
      (globalThis as { navigator?: unknown }).navigator = { product: 'ReactNative' };
      Reflect.set(globalThis, 'FileReader', NativeFileReader);
    });

    it('still hashes an explicitly supplied native Blob through bounded FileReader slices', async () => {
      const bytes = bytesOf(OVER);
      const native = new NativeBlob(bytes);
      const { oxy, request, order } = stubApi(() => openSession(OVER));
      const sent: SentXhr[] = [];
      installXhr(
        () => {
          throw new Error('Unexpected file materialization');
        },
        sent,
        order,
      );
      const result = await oxy.assets.uploadLarge(native as unknown as Blob, {
        mime: 'video/mp4',
        name: 'clip.mp4',
      });
      expect(order).toEqual([
        '/assets/uploads',
        ...PUTS,
        '/assets/uploads/up-1/complete',
        '/assets/asset-1',
      ]);
      expect(request.mock.calls[0][2]).toMatchObject({ sha256: sha256Hex(bytes), size: OVER });
      expect(result.file.id).toBe('asset-1');
      expect(native.closed).toBe(false); // Explicit Blob inputs remain caller-owned.
    });

    it('uses the installed file adapter for a large native descriptor without creating a Blob', async () => {
      const bytes = bytesOf(OVER);
      const { oxy, request } = stubApi(() => openSession(OVER));
      const readRange = jest.fn(async (start: number, end: number) => bytes.slice(start, end));
      const putPart = jest.fn(
        async ({
          start,
          end,
          onProgress,
        }: {
          start: number;
          end: number;
          onProgress: (loaded: number) => void;
        }) => {
          onProgress(end - start);
          return { ok: true as const };
        },
      );
      const stale = oxy.assets.installFileAdapter(async () => {
        throw new Error('stale adapter');
      });
      const adapter = jest.fn(async () => ({ size: OVER, readRange, putPart }));
      oxy.assets.installFileAdapter(adapter);
      stale();
      class ForbiddenBlobRead {
        constructor() {
          throw new Error('Whole-file Blob allocation');
        }
      }
      Reflect.set(globalThis, 'XMLHttpRequest', ForbiddenBlobRead);
      const progress = jest.fn();
      const result = await oxy.assets.upload(
        { uri: 'file:///data/large.mp4', type: 'video/mp4' },
        { visibility: 'private', onStageProgress: progress },
      );
      expect(adapter).toHaveBeenCalledWith('file:///data/large.mp4');
      expect(readRange.mock.calls.every(([start, end]) => end - start <= 8 * 1024 * 1024)).toBe(
        true,
      );
      expect(readRange.mock.calls.reduce((total, [start, end]) => total + end - start, 0)).toBe(
        OVER,
      );
      expect(putPart.mock.calls.reduce((total, [part]) => total + part.end - part.start, 0)).toBe(
        OVER,
      );
      expect(request.mock.calls[0][2]).toMatchObject({
        sha256: sha256Hex(bytes),
        size: OVER,
        visibility: 'private',
      });
      expect(progress).toHaveBeenCalledWith({ phase: 'hash', loaded: OVER, total: OVER });
      expect(result).toEqual({ file: uploadedShape });
    });

    it('uses a native digest without transporting hash bytes through JavaScript', async () => {
      const { oxy, request } = stubApi(() => openSession(OVER));
      const digest = 'ab'.repeat(32);
      const readRange = jest.fn();
      const hash = jest.fn(async (progress?: (loaded: number) => void) => {
        progress?.(OVER);
        return digest;
      });
      oxy.assets.installFileAdapter(async () => ({
        size: OVER,
        hash,
        readRange,
        putPart: async () => ({ ok: true as const }),
      }));
      const result = await oxy.assets.upload({ uri: 'file:///large.mp4', type: 'video/mp4' });
      expect(hash).toHaveBeenCalledTimes(1);
      expect(readRange).not.toHaveBeenCalled();
      expect(request.mock.calls[0][2]).toMatchObject({ sha256: digest, size: OVER });
      expect(result).toEqual({ file: uploadedShape });
    });

    it('native metadata proves an unknown-size file small before streaming multipart', async () => {
      const { oxy, order } = stubApi(() => openSession(OVER));
      oxy.assets.installFileAdapter(async () => ({
        size: 1024,
        readRange: jest.fn(),
        putPart: jest.fn(),
      }));
      const appended: unknown[] = [];
      jest.spyOn(FormData.prototype, 'append').mockImplementation((name, value) => {
        if (name === 'file') appended.push(value);
      });
      const descriptor = { uri: 'file:///data/photo.jpg', type: 'image/jpeg', name: 'photo.jpg' };

      await oxy.assets.upload(descriptor);

      expect(order).toEqual(['/assets/upload']);
      expect(appended).toEqual([descriptor]);
    });

    it.each([undefined, OVER])(
      'requires an adapter before allocating an unknown/large native file (%s)',
      async (size) => {
        const { oxy, request } = stubApi(() => openSession(OVER));
        class ForbiddenRead {
          constructor() {
            throw new Error('Whole-file allocation');
          }
        }
        Reflect.set(globalThis, 'XMLHttpRequest', ForbiddenRead);
        await expect(
          oxy.assets.upload({ uri: 'file:///data/clip.mp4', type: 'video/mp4', size }),
        ).rejects.toThrow('require a file adapter');
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('does not fall back to multipart if native metadata cannot be read', async () => {
      const { oxy, request } = stubApi(() => openSession(OVER));
      oxy.assets.installFileAdapter(async () => {
        throw new Error('File unavailable');
      });
      await expect(
        oxy.assets.upload({ uri: 'file:///data/missing.mp4', type: 'video/mp4' }),
      ).rejects.toThrow('File unavailable');
      expect(request).not.toHaveBeenCalled();
    });

    it('a descriptor whose size says small is never read in JS at all', async () => {
      const { oxy, order } = stubApi(() => openSession(OVER));
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

    it('empty native metadata is refused before any request', async () => {
      const { oxy, request } = stubApi(() => openSession(OVER));
      oxy.assets.installFileAdapter(async () => ({
        size: 0,
        readRange: jest.fn(),
        putPart: jest.fn(),
      }));

      await expect(
        oxy.assets.upload({ uri: 'file:///data/empty.mp4', type: 'video/mp4' }),
      ).rejects.toThrow('Cannot upload an empty or invalid file');
      expect(request).not.toHaveBeenCalled();
    });
  });
});
