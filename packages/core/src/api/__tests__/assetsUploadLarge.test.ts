/**
 * `oxy.assets.initUpload` / `completeUpload` (the single presigned PUT
 * primitives) and `uploadLarge` — the presigned MULTIPART upload straight to
 * storage (ADR 0047), with no byte passing through the API.
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
      // Bounded like an upload: a public file's bytes are copied before it answers.
      { cache: false, timeout: 10 * 60 * 1000 },
    );
  });
});

const PART = 'https://oxy-files.acct.r2.cloudflarestorage.com/staging?partNumber=';

/** A session as the API answers it, with URLs for `parts`. */
function session(
  overrides: Partial<Record<string, unknown>> & { parts?: number[]; uploadedParts?: number[] },
  partSize: number,
  size: number,
) {
  const partCount = Math.ceil(size / partSize);
  const length = (n: number) => (n < partCount ? partSize : size - partSize * (partCount - 1));
  const { parts, uploadedParts, ...rest } = overrides;
  return {
    uploadId: 'up-1',
    status: 'uploading',
    size,
    partSize,
    partCount,
    ...(parts
      ? { parts: parts.map((n) => ({ partNumber: n, url: `${PART}${n}`, size: length(n) })) }
      : {}),
    ...(uploadedParts
      ? { uploadedParts: uploadedParts.map((n) => ({ partNumber: n, size: length(n) })) }
      : {}),
    ...rest,
  };
}

const record = { ...completed.file, ext: '.mp4', visibility: 'private' };

/**
 * The upload-session routes, by path. `onOpen` answers the open; the rest
 * answer the usual way; PUTs go through `global.fetch`.
 */
function multipartApi(
  open: (body: Record<string, unknown>) => unknown,
  options: {
    complete?: () => unknown;
    describe?: () => unknown;
    parts?: (numbers: number[]) => unknown;
    put?: (url: string, body: Blob) => { ok: boolean; status: number };
  } = {},
) {
  const { oxy, request } = stubbedClient('user-1');
  const calls: string[] = [];
  const puts: { url: string; bytes: number }[] = [];
  request.mockImplementation(async (method: string, url: string, body?: unknown) => {
    calls.push(`${method} ${url}`);
    if (url === '/assets/uploads' && method === 'POST')
      return open(body as Record<string, unknown>);
    if (url.endsWith('/parts'))
      return options.parts?.((body as { partNumbers: number[] }).partNumbers);
    if (url.endsWith('/complete'))
      return options.complete
        ? options.complete()
        : { uploadId: 'up-1', status: 'completed', size: 3, file: { id: 'asset-1' } };
    if (url === '/assets/uploads/up-1' && method === 'GET') return options.describe?.();
    if (url === '/assets/asset-1') return { assetId: 'asset-1', file: record };
    throw new Error(`unexpected ${method} ${url}`);
  });
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as Blob;
    puts.push({ url: String(url), bytes: body.size });
    const answer = options.put?.(String(url), body) ?? { ok: true, status: 200 };
    return new Response(null, { status: answer.status });
  }) as unknown as typeof fetch;
  return { oxy, request, calls, puts };
}

describe('assets.uploadLarge', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('hashes first, opens with the real digest, PUTs every part straight to storage, then completes', async () => {
    // Just over two hash chunks, so the digest is checked across boundaries.
    const bytes = new Uint8Array(16 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    const partSize = 8 * 1024 * 1024;
    let opened: Record<string, unknown> | undefined;
    const { oxy, calls, puts } = multipartApi((body) => {
      opened = body;
      return session({ parts: [1, 2, 3] }, partSize, bytes.length);
    });

    const result = await oxy.assets.uploadLarge(new Blob([bytes], { type: 'video/mp4' }), {
      name: 'clip.mp4',
      visibility: 'public',
    });

    expect(opened).toEqual({
      sha256: sha256Hex(bytes),
      size: bytes.length,
      mime: 'video/mp4',
      filename: 'clip.mp4',
      visibility: 'public',
    });
    expect(puts.map((put) => [put.url, put.bytes])).toEqual([
      [`${PART}1`, partSize],
      [`${PART}2`, partSize],
      [`${PART}3`, 7],
    ]);
    expect(calls).toEqual([
      'POST /assets/uploads',
      'POST /assets/uploads/up-1/complete',
      'GET /assets/asset-1',
    ]);
    expect(result).toMatchObject({ assetId: 'asset-1', deduplicated: false });
  });

  it('sends nothing when the bytes are already yours', async () => {
    const { oxy, calls, puts } = multipartApi(() => ({
      uploadId: null,
      status: 'completed',
      size: 3,
      file: { id: 'asset-1' },
      deduplicated: true,
    }));
    const result = await oxy.assets.uploadLarge(new Blob(['abc'], { type: 'video/mp4' }));
    expect(puts).toEqual([]);
    expect(calls).toEqual(['POST /assets/uploads', 'GET /assets/asset-1']);
    expect(result.deduplicated).toBe(true);
  });

  it('resumes: only the parts storage does not hold are sent again', async () => {
    const { oxy, puts } = multipartApi(() => session({ parts: [3], uploadedParts: [1, 2] }, 4, 10));
    await oxy.assets.uploadLarge(new Blob(['0123456789'], { type: 'video/mp4' }), {
      partConcurrency: 1,
    });
    expect(puts.map((put) => put.url)).toEqual([`${PART}3`]);
  });

  it('retries a failed part, and asks for a fresh URL when storage refuses the old one', async () => {
    let refused = 0;
    let asked: number[] = [];
    const { oxy, puts } = multipartApi(() => session({ parts: [1, 2] }, 4, 8), {
      put: (url) =>
        url === `${PART}1` && refused++ === 0
          ? { ok: false, status: 403 }
          : { ok: true, status: 200 },
      parts: (numbers) => {
        asked = numbers;
        return session({ parts: numbers }, 4, 8);
      },
    });
    await oxy.assets.uploadLarge(new Blob(['01234567'], { type: 'video/mp4' }), {
      partConcurrency: 1,
      partAttempts: 2,
    });
    expect(asked).toEqual([1, 2]);
    expect(puts.filter((put) => put.url === `${PART}1`)).toHaveLength(2);
  });

  it('stops resumably when a part keeps failing: no complete, and the upload id to resume or abort', async () => {
    const { oxy, calls } = multipartApi(() => session({ parts: [1] }, 4, 3), {
      put: () => ({ ok: false, status: 0 }),
    });
    await expect(
      oxy.assets.uploadLarge(new Blob(['abc'], { type: 'video/mp4' }), { partAttempts: 1 }),
    ).rejects.toMatchObject({ name: 'DirectUploadInterruptedError', uploadId: 'up-1' });
    expect(calls).toEqual(['POST /assets/uploads']);
  });

  it('waits while Oxy verifies a big file, reporting every phase', async () => {
    let polls = 0;
    const phases = new Set<string>();
    const { oxy } = multipartApi(() => session({ parts: [1] }, 4, 3), {
      complete: () => ({ uploadId: 'up-1', status: 'verifying', size: 3 }),
      describe: () =>
        polls++ === 0
          ? { uploadId: 'up-1', status: 'verifying', size: 3 }
          : { uploadId: 'up-1', status: 'completed', size: 3, file: { id: 'asset-1' } },
    });
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const done = oxy.assets.uploadLarge(new Blob(['abc'], { type: 'video/mp4' }), {
      onProgress: (progress) => phases.add(progress.phase),
    });
    for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(2_000);
    jest.useRealTimers();
    await expect(done).resolves.toMatchObject({ assetId: 'asset-1' });
    expect([...phases]).toEqual(['hash', 'upload', 'verify']);
  });

  it('refuses an empty file, a missing MIME type or more than 8 GiB before any request', async () => {
    const { oxy, request } = multipartApi(() => {
      throw new Error('no');
    });
    await expect(oxy.assets.uploadLarge(new Blob([]), { mime: 'video/mp4' })).rejects.toThrow(
      'empty',
    );
    await expect(oxy.assets.uploadLarge(new Blob(['a']))).rejects.toThrow('MIME');
    const huge = {
      size: 8 * 1024 ** 3 + 1,
      type: 'video/mp4',
      slice: () => new Blob([]),
    } as unknown as Blob;
    await expect(oxy.assets.uploadLarge(huge)).rejects.toThrow('8 GiB');
    expect(request).not.toHaveBeenCalled();
  });
});
