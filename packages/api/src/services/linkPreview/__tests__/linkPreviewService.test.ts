/**
 * Link-preview SERVICE tests — the privacy invariant end to end and the batch
 * response shape.
 *
 * `link_previews` is a REAL Postgres table here, which is what makes the privacy
 * invariant checkable rather than merely asserted: the test reads the stored row
 * back and confirms the origin URL is BOTH persisted (so the next refresh can
 * re-host) and absent from the client DTO. Under the previous Mongo mock the
 * "stored" document was whatever the mock echoed back, so both halves of that
 * invariant were the same assertion twice.
 *
 * Mocked: the resolver (so no real network for metadata), the asset service
 * (re-host + CDN resolve), the warm queue, and `safeFetch` (the image download).
 * The Redis cache is the REAL module but degrades to a no-op with REDIS_URL
 * unset.
 */
import { Readable } from 'stream';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

delete process.env.REDIS_URL;

const mockResolveLinkMetadata = jest.fn();
const mockSafeFetch = jest.fn();
const mockUpload = jest.fn();
const mockGetPublicCdnUrl = jest.fn();
const mockEnqueueWarm = jest.fn();

jest.mock('../linkMetadataResolver', () => ({
  resolveLinkMetadata: (...args: unknown[]) => mockResolveLinkMetadata(...args),
  normalizeUrl: (url: string) => url, // identity — tests pass already-normalized URLs
}));

jest.mock('@oxyhq/core/server', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: class SsrfRejection extends Error {},
}));

jest.mock('../../assetServiceSingleton', () => ({
  assetService: {
    uploadLinkPreviewImageStream: (...args: unknown[]) => mockUpload(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
  },
}));

jest.mock('../../../queue/linkPreviewWarm.queue', () => ({
  enqueueLinkPreviewWarm: (...args: unknown[]) => mockEnqueueWarm(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { linkPreviews } from '../../../db/schema';
import { linkPreviewService } from '../linkPreviewService';
import {
  LINK_PREVIEW_MAX_URL_LENGTH,
  LINK_PREVIEW_RESOLVER_VERSION,
  LINK_PREVIEW_SYNC_MAX_CONCURRENCY,
} from '../constants';

const previewId = (url: string) => createHash('sha256').update(url).digest('hex');

function imageResponse(): unknown {
  return {
    response: Readable.from([Buffer.from('PNGDATA')]),
    status: 200,
    headers: { 'content-type': 'image/png' },
    finalUrl: 'https://cdn.evil.com/og.png',
  };
}

/**
 * The stored row INCLUDING the two server-only columns. Reading them takes an
 * explicit select, which is itself the point: `SerializableLinkPreview` cannot
 * name them, so no serializer can reach them.
 */
async function storedRow(url: string) {
  const [row] = await getDb()
    .select()
    .from(linkPreviews)
    .where(eq(linkPreviews.id, previewId(url)))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockResolveLinkMetadata.mockReset();
  mockSafeFetch.mockReset();
  mockUpload.mockReset();
  mockGetPublicCdnUrl.mockReset();
  mockEnqueueWarm.mockReset();
});

describe('resolveAndStore — privacy invariant', () => {
  it('OMITS image (never the origin URL) when re-host fails, and stores the origin server-side', async () => {
    const url = 'https://ex.com/rehost-fails';
    mockResolveLinkMetadata.mockResolvedValueOnce({
      url,
      title: 'Title',
      description: 'Desc',
      siteName: 'Ex',
      imageUrl: 'https://cdn.evil.com/og.png',
    });
    mockSafeFetch.mockResolvedValueOnce(imageResponse());
    // Re-host throws — but must drain the stream it was handed.
    mockUpload.mockImplementationOnce((src: Readable) => {
      src.resume();
      return Promise.reject(new Error('rehost boom'));
    });

    const dto = await linkPreviewService.resolveAndStore(url);

    // Usable (has title + description) → resolved, but with NO image this round.
    expect(dto.status).toBe('resolved');
    expect(dto.image).toBeUndefined();
    expect('image' in dto).toBe(false);
    // The origin image URL must never appear in the client DTO.
    expect(JSON.stringify(dto)).not.toContain('evil.com');

    // ...but it IS persisted server-side for re-host on the next refresh.
    const row = await storedRow(url);
    expect(row.originImageUrl).toBe('https://cdn.evil.com/og.png');
    expect(row.imageUrl).toBeNull();
  });

  it('returns a cloud.oxy.so by-id image URL when re-host succeeds', async () => {
    const url = 'https://ex.com/rehost-succeeds';
    mockResolveLinkMetadata.mockResolvedValueOnce({
      url,
      title: 'Title',
      imageUrl: 'https://cdn.evil.com/og.png',
    });
    mockSafeFetch.mockResolvedValueOnce(imageResponse());
    mockUpload.mockImplementationOnce((src: Readable) => {
      src.resume();
      return Promise.resolve({ id: 'file123' });
    });
    mockGetPublicCdnUrl.mockResolvedValueOnce('https://cloud.oxy.so/content/2026/01/abc.png');

    const dto = await linkPreviewService.resolveAndStore(url);

    expect(dto.status).toBe('resolved');
    expect(dto.image).toMatch(/\/file123$/);
    expect(dto.image?.startsWith('http')).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('evil.com');
  });

  it('stores empty + omits image when the resolver throws', async () => {
    const url = 'https://dead.example/x';
    mockResolveLinkMetadata.mockRejectedValueOnce(new Error('timeout'));

    const dto = await linkPreviewService.resolveAndStore(url);

    expect(dto.status).toBe('empty');
    expect(dto.image).toBeUndefined();
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect((await storedRow(url)).status).toBe('empty');
  });

  it('CLEARS a title the origin has dropped, rather than leaving the stale one', async () => {
    // The Mongo writer expressed this as `$unset`. A column write says it more
    // directly — and getting it wrong is invisible: omitting the key from the
    // upsert's `set` would silently keep serving the old title forever.
    const url = 'https://ex.com/loses-its-title';
    mockResolveLinkMetadata.mockResolvedValueOnce({ url, title: 'First', description: 'Desc' });
    expect((await linkPreviewService.resolveAndStore(url)).title).toBe('First');

    mockResolveLinkMetadata.mockResolvedValueOnce({ url, description: 'Desc' });
    const second = await linkPreviewService.resolveAndStore(url);

    expect(second.title).toBeUndefined();
    expect((await storedRow(url)).title).toBeNull();
  });
});

describe('getBatch — response shape', () => {
  it('keys by requested url and returns pending for misses (warming them)', async () => {
    const data = await linkPreviewService.getBatch(['https://a.com', 'https://b.com']);

    expect(Object.keys(data).sort()).toEqual(['https://a.com', 'https://b.com']);
    expect(data['https://a.com']).toEqual({ url: 'https://a.com', status: 'pending' });
    expect(data['https://b.com']).toEqual({ url: 'https://b.com', status: 'pending' });
    expect(mockEnqueueWarm).toHaveBeenCalledTimes(2);
  });

  it('returns a fresh stored doc without warming', async () => {
    const url = 'https://fresh.example/post';
    await getDb().insert(linkPreviews).values({
      id: previewId(url),
      requestedUrl: url,
      canonicalUrl: url,
      title: 'Fresh',
      imageUrl: 'https://cloud.oxy.so/file999',
      status: 'resolved',
      version: LINK_PREVIEW_RESOLVER_VERSION,
      resolvedAt: new Date(),
    });

    const data = await linkPreviewService.getBatch([url]);

    expect(data[url].status).toBe('resolved');
    expect(data[url].title).toBe('Fresh');
    expect(data[url].image).toBe('https://cloud.oxy.so/file999');
    expect(mockEnqueueWarm).not.toHaveBeenCalled();
  });

  // This is what makes a LINK_PREVIEW_RESOLVER_VERSION bump retroactively fix
  // already-stored previews: a doc below the current version is stale no matter
  // how recently it resolved, so it is re-warmed (and re-resolved) on next read.
  it('re-warms a stored doc written by an older resolver version', async () => {
    const url = 'https://stale.example/post';
    await getDb().insert(linkPreviews).values({
      id: previewId(url),
      requestedUrl: url,
      canonicalUrl: url,
      title: 'Stale title from an older resolver',
      status: 'resolved',
      version: LINK_PREVIEW_RESOLVER_VERSION - 1,
      resolvedAt: new Date(),
    });

    const data = await linkPreviewService.getBatch([url]);

    // The stale doc is still SERVED (stale-while-revalidate) …
    expect(data[url].title).toBe('Stale title from an older resolver');
    // … but a background re-resolve is queued.
    expect(mockEnqueueWarm).toHaveBeenCalledWith(url);
  });

  it('drops an oversized batch url to empty WITHOUT warming or fetching', async () => {
    const longUrl = `https://x.com/${'a'.repeat(LINK_PREVIEW_MAX_URL_LENGTH + 100)}`;

    const data = await linkPreviewService.getBatch([longUrl, 'https://ok.com/p']);

    expect(data[longUrl]).toEqual({ url: longUrl, status: 'empty' });
    expect(data['https://ok.com/p'].status).toBe('pending');
    // Only the valid url was warmed — the oversized one costs no resolve work.
    expect(mockEnqueueWarm).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWarm).toHaveBeenCalledWith('https://ok.com/p');
  });

  it('never carries the server-only origin columns into a batch DTO', async () => {
    const url = 'https://origin.example/leak-check';
    await getDb().insert(linkPreviews).values({
      id: previewId(url),
      requestedUrl: url,
      canonicalUrl: url,
      title: 'Has an origin image',
      imageUrl: 'https://cloud.oxy.so/file42',
      originImageUrl: 'https://cdn.evil.com/og.png',
      originFaviconUrl: 'https://cdn.evil.com/favicon.ico',
      status: 'resolved',
      version: LINK_PREVIEW_RESOLVER_VERSION,
      resolvedAt: new Date(),
    });

    const data = await linkPreviewService.getBatch([url]);

    expect(data[url].image).toBe('https://cloud.oxy.so/file42');
    expect(JSON.stringify(data)).not.toContain('evil.com');
  });
});

describe('get — wait=1 concurrency ceiling', () => {
  it('degrades wait=1 to pending when the sync-concurrency ceiling is saturated', async () => {
    // A resolve that parks until released, shared by every held synchronous
    // resolve so they all hold their slot simultaneously.
    let release: (value: unknown) => void = () => undefined;
    const parked = new Promise((res) => {
      release = res;
    });
    mockResolveLinkMetadata.mockReturnValue(parked);

    // Saturate every synchronous-resolve slot.
    const held: Promise<unknown>[] = [];
    for (let i = 0; i < LINK_PREVIEW_SYNC_MAX_CONCURRENCY; i++) {
      held.push(linkPreviewService.get(`https://held-${i}.example/x`, { wait: true }));
    }
    // Wait for saturation on an OBSERVABLE rather than a fixed tick: a `get`
    // reaches the resolver only after it has claimed a slot, so the resolver's
    // call count IS the number of slots taken. A `setImmediate` was enough when
    // the preceding lookup was a mock; against a real database it is a round
    // trip, and a fixed tick would let the overflow call take a free slot and
    // park — the test would then time out rather than measure the ceiling.
    while (mockResolveLinkMetadata.mock.calls.length < LINK_PREVIEW_SYNC_MAX_CONCURRENCY) {
      await new Promise((r) => setImmediate(r));
    }

    // The next wait=1 finds no free slot → background warm + immediate pending.
    const degraded = await linkPreviewService.get('https://overflow.example/x', { wait: true });
    expect(degraded).toEqual({ url: 'https://overflow.example/x', status: 'pending' });
    expect(mockEnqueueWarm).toHaveBeenCalledWith('https://overflow.example/x');

    // Release the held resolves so slots free and nothing leaks.
    release({ url: 'https://held.example/x', title: 'X' });
    await Promise.all(held);
  });
});
