/**
 * REAL-path regression tests for the bug that 500'd YouTube + the batch endpoint
 * in prod: a returned/serialized preview MUST always carry `status`.
 *
 * Unlike `linkPreviewService.test.ts` (which mocks the resolver), these run the
 * REAL resolver provider chain + REAL serializer and validate the returned value
 * against `linkPreviewSchema` exactly the way the route does — so a status-less
 * value would fail here just as it did in prod. Only the network (`safeFetch`),
 * the asset service, and the warm queue are mocked; `link_previews` is a real
 * Postgres table.
 */
import { Readable } from 'stream';
import { linkPreviewSchema } from '@oxyhq/contracts';

delete process.env.REDIS_URL;

const mockSafeFetch = jest.fn();
const mockUpload = jest.fn();
const mockGetPublicCdnUrl = jest.fn();
const mockEnqueueWarm = jest.fn();

jest.mock('@oxyhq/core/server', () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
  SsrfRejection: class SsrfRejection extends Error {},
}));
jest.mock('../../assetServiceSingleton', () => ({
  assetService: {
    uploadLinkPreviewImageStream: (...a: unknown[]) => mockUpload(...a),
    getPublicCdnUrl: (...a: unknown[]) => mockGetPublicCdnUrl(...a),
  },
}));
jest.mock('../../../queue/linkPreviewWarm.queue', () => ({
  enqueueLinkPreviewWarm: (...a: unknown[]) => mockEnqueueWarm(...a),
}));
// REAL resolver + serializer + cache (cache is a no-op without REDIS_URL).
import { closePostgres, connectPostgres } from '../../../config/postgres';
import { linkPreviewService } from '../linkPreviewService';

function jsonResp(body: unknown): unknown {
  return {
    response: Readable.from([Buffer.from(JSON.stringify(body))]),
    status: 200,
    headers: { 'content-type': 'application/json' },
    finalUrl: 'https://provider/oembed',
  };
}
function htmlResp(html: string, finalUrl: string): unknown {
  return {
    response: Readable.from([Buffer.from(html)]),
    status: 200,
    headers: { 'content-type': 'text/html' },
    finalUrl,
  };
}
function imgResp(): unknown {
  return {
    response: Readable.from([Buffer.from('PNG')]),
    status: 200,
    headers: { 'content-type': 'image/png' },
    finalUrl: 'https://i.ytimg.com/x.jpg',
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUpload.mockImplementation((src: Readable) => {
    src.resume();
    return Promise.resolve({ id: 'file123' });
  });
  mockGetPublicCdnUrl.mockResolvedValue('https://cloud.oxy.so/content/x.png');
});

describe('YouTube (oEmbed + description-enrichment path)', () => {
  beforeEach(() => {
    mockSafeFetch.mockImplementation((url: string) => {
      if (url.includes('/oembed')) {
        // YouTube oEmbed: title + thumbnail, NO description → enrichment runs.
        return Promise.resolve(jsonResp({ title: 'A YouTube Video', thumbnail_url: 'https://i.ytimg.com/x.jpg' }));
      }
      if (url.includes('youtube.com/watch')) {
        // Enrichment scrape of the watch page.
        return Promise.resolve(
          htmlResp('<html><head><meta property="og:description" content="desc"></head></html>', 'https://www.youtube.com/watch?v=mYDSSRS-B5U'),
        );
      }
      return Promise.resolve(imgResp()); // thumbnail re-host
    });
  });

  it('wait=1 resolve returns a SCHEMA-VALID preview with status', async () => {
    const dto = await linkPreviewService.resolveAndStore('https://youtu.be/mYDSSRS-B5U');
    expect(dto.status).toBe('resolved');
    // Validate exactly the way the route does — this would have caught the prod bug.
    expect(() => linkPreviewSchema.parse(dto)).not.toThrow();
    expect(dto.image).toMatch(/\/file123$/);
  });

  it('still carries status when enrichment yields no description and re-host fails', async () => {
    mockSafeFetch.mockImplementation((url: string) => {
      if (url.includes('/oembed')) {
        return Promise.resolve(jsonResp({ title: 'A YouTube Video', thumbnail_url: 'https://i.ytimg.com/x.jpg' }));
      }
      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResp('<html><head></head></html>', 'https://www.youtube.com/watch?v=mYDSSRS-B5U'));
      }
      return Promise.reject(new Error('image down')); // re-host fails
    });

    const dto = await linkPreviewService.resolveAndStore('https://youtu.be/mYDSSRS-B5U');
    expect(dto.status).toBeDefined();
    expect(() => linkPreviewSchema.parse(dto)).not.toThrow();
    expect(dto.image).toBeUndefined();
  });
});

describe('batch miss', () => {
  it('returns a SCHEMA-VALID pending preview (with status) for every requested url', async () => {
    // A url no earlier case resolved: the store is REAL now, so reusing the
    // YouTube url above would read back its stored row instead of a miss.
    const url = 'https://youtu.be/never-resolved-here';
    const data = await linkPreviewService.getBatch([url, 'https://example.com/a']);

    for (const key of Object.keys(data)) {
      expect(data[key].status).toBeDefined();
      expect(() => linkPreviewSchema.parse(data[key])).not.toThrow();
    }
    expect(data[url].status).toBe('pending');
  });
});
