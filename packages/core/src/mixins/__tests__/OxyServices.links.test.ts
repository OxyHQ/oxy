/**
 * Link-preview mixin tests.
 *
 * Stubs `makeRequest` so the tests run with no network, then asserts:
 *  - `getLinkPreview` builds `GET /links/preview?url=<percent-encoded>&wait=0|1`,
 *    percent-encoding the target URL so its `?`/`&`/`=` cannot break out of the
 *    query string, defaults `wait` to `0`, sends `wait=1` when `{ wait: true }`,
 *    reads uncached (`cache:false`), returns the preview, and surfaces errors.
 *  - `getLinkPreviews` de-duplicates input, no-ops to `{}` on empty input,
 *    chunks at 50 URLs/request (`POST /links/previews`), merges every chunk's
 *    `data` map keyed by the requested url, and surfaces a chunk failure.
 */

import type { LinkPreview } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';

const sampleResolved: LinkPreview = {
  url: 'https://news.example.com/a',
  status: 'resolved',
  title: 'Headline',
  description: 'Lede',
  image: 'https://cloud.oxy.so/img123',
  siteName: 'Example News',
  favicon: 'https://cloud.oxy.so/fav123',
  resolvedAt: '2026-06-28T00:00:00.000Z',
};

describe('OxyServices.links', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getLinkPreview', () => {
    it('percent-encodes the URL and defaults wait=0', async () => {
      makeRequestSpy.mockResolvedValueOnce(sampleResolved);

      const result = await oxy.getLinkPreview('https://news.example.com/a?b=c&d=e');

      expect(result).toEqual(sampleResolved);
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/links/preview?url=https%3A%2F%2Fnews.example.com%2Fa%3Fb%3Dc%26d%3De&wait=0',
        undefined,
        { cache: false },
      );
    });

    it('sends wait=1 when opts.wait is true', async () => {
      makeRequestSpy.mockResolvedValueOnce({ url: 'https://x.test/', status: 'pending' });

      await oxy.getLinkPreview('https://x.test/', { wait: true });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/links/preview?url=https%3A%2F%2Fx.test%2F&wait=1',
        undefined,
        { cache: false },
      );
    });

    it('surfaces errors via handleError', async () => {
      makeRequestSpy.mockRejectedValueOnce(new Error('boom'));

      await expect(oxy.getLinkPreview('https://x.test/')).rejects.toThrow('boom');
    });
  });

  describe('getLinkPreviews', () => {
    it('returns {} and performs no network call for empty / whitespace input', async () => {
      await expect(oxy.getLinkPreviews([])).resolves.toEqual({});
      await expect(oxy.getLinkPreviews(['', '   '])).resolves.toEqual({});
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('de-duplicates and sends a single chunk for <= 50 unique URLs', async () => {
      // makeRequest unwraps the API's `{ data }` envelope, so the resolved value
      // is the bare record (NOT `{ data: {...} }`) — mirror that real shape here.
      const record: Record<string, LinkPreview> = { 'https://a.test/': sampleResolved };
      makeRequestSpy.mockResolvedValueOnce(record);

      const result = await oxy.getLinkPreviews([
        'https://a.test/',
        'https://a.test/', // duplicate
        '   ', // dropped
      ]);

      expect(result).toEqual(record);
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/links/previews',
        { urls: ['https://a.test/'] },
        { cache: false },
      );
    });

    it('chunks at 50 URLs per request and merges each chunk data map', async () => {
      const urls = Array.from({ length: 120 }, (_, i) => `https://site.test/${i}`);

      makeRequestSpy.mockImplementation(
        async (
          _method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          _url: string,
          data?: { urls: string[] },
        ): Promise<Record<string, LinkPreview>> => {
          const chunkUrls = data?.urls ?? [];
          const dataMap: Record<string, LinkPreview> = {};
          for (const u of chunkUrls) {
            dataMap[u] = { url: u, status: 'resolved', title: `t-${u}` };
          }
          return dataMap;
        },
      );

      const result = await oxy.getLinkPreviews(urls);

      // 120 unique URLs => 50 + 50 + 20 across three POSTs.
      expect(makeRequestSpy).toHaveBeenCalledTimes(3);
      const chunkSizes = makeRequestSpy.mock.calls.map((call) => (call[2] as { urls: string[] }).urls.length);
      expect(chunkSizes).toEqual([50, 50, 20]);

      // Every requested URL is present in the merged, request-keyed map.
      expect(Object.keys(result)).toHaveLength(120);
      expect(result['https://site.test/0']).toEqual({
        url: 'https://site.test/0',
        status: 'resolved',
        title: 't-https://site.test/0',
      });
      expect(result['https://site.test/119']).toEqual({
        url: 'https://site.test/119',
        status: 'resolved',
        title: 't-https://site.test/119',
      });
    });

    it('surfaces a chunk failure via handleError', async () => {
      const urls = Array.from({ length: 60 }, (_, i) => `https://site.test/${i}`);
      makeRequestSpy
        .mockResolvedValueOnce({ data: {} })
        .mockRejectedValueOnce(new Error('chunk failed'));

      await expect(oxy.getLinkPreviews(urls)).rejects.toThrow('chunk failed');
    });
  });
});
