/**
 * `OxyServer.assets.mediaCache` and `.federatedMedia` — the federation media
 * routes (`/assets/service/cache`, `/assets/service/federation`), which apps
 * used to call with a hand-built transport.
 *
 * Stubs `serviceRequest`, so each test pins the route, the body (the raw bytes
 * for an upload), the headers and the send-once policy; and what a caller gets
 * back, including a budget refusal's wait.
 */
import { OxyServer } from '../OxyServer';
import { OxyApiError, retryAfterSecondsOf } from '../../OxyServices.errors';
import type { RequestOptions } from '../../HttpService';

const stored = {
  id: 'file-1',
  sha256: 'b'.repeat(64),
  size: 3,
  mime: 'video/mp4',
  visibility: 'public' as const,
};

describe('OxyServer.assets — federation media', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('mediaCache.upload POSTs the bytes to the cache once, with the description', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file: { id: 'cache-1' } });
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

    await expect(
      oxy.assets.mediaCache.upload(bytes, 'image/webp', {
        originalName: 'a.webp',
        timeout: 60_000,
      }),
    ).resolves.toEqual({ file: { id: 'cache-1' } });

    const [method, url, body, options] = serviceRequestSpy.mock.calls[0] as [
      string,
      string,
      unknown,
      RequestOptions,
    ];
    expect([method, url, body]).toEqual(['POST', '/assets/service/cache', bytes]);
    expect(options.headers).toEqual({ 'Content-Type': 'image/webp', 'x-original-name': 'a.webp' });
    expect(options).toMatchObject({ retry: false, cache: false, timeout: 60_000 });
  });

  it('mediaCache.delete DELETEs the encoded id', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ message: 'Cached asset deleted successfully' });

    await oxy.assets.mediaCache.delete('a/b');

    expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
      'DELETE',
      '/assets/service/cache/a%2Fb',
    ]);
  });

  it('federatedMedia.upload names the owner and returns the file and whether it was reused', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file: stored, deduplicated: true });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(
      oxy.assets.federatedMedia.upload('fed-user-1', bytes, 'video/mp4', {
        metadata: { sourceUrl: 'https://remote.example/v.mp4' },
      }),
    ).resolves.toEqual({ file: stored, deduplicated: true });

    const [method, url, body, options] = serviceRequestSpy.mock.calls[0] as [
      string,
      string,
      unknown,
      RequestOptions,
    ];
    expect([method, url, body]).toEqual(['POST', '/assets/service/federation', bytes]);
    expect(options.headers).toEqual({
      'Content-Type': 'video/mp4',
      'x-media-metadata': JSON.stringify({ sourceUrl: 'https://remote.example/v.mp4' }),
      'x-owner-user-id': 'fed-user-1',
    });
    expect(options.retry).toBe(false);
  });

  it('federatedMedia.upload reads a missing deduplicated flag as false', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file: stored });

    const result = await oxy.assets.federatedMedia.upload(
      'fed-user-1',
      new Uint8Array([1]),
      'video/mp4',
    );

    expect(result.deduplicated).toBe(false);
  });

  it('federatedMedia.delete sends distinct ids 20 at a time and keeps only real answers', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `f${i}`);
    serviceRequestSpy.mockImplementation(async (_m, _u, body) => {
      const asked = (body as { ids: string[] }).ids;
      return {
        results: [
          ...asked.map((id) => ({ id, result: id === 'f3' ? 'in_use' : 'deleted' })),
          { id: 'not-asked', result: 'deleted' },
          ...(asked.includes('f21') ? [{ id: 'f21', result: 'shredded' }] : []),
        ],
      };
    });

    const results = await oxy.assets.federatedMedia.delete([...ids, 'f0', '']);

    expect(serviceRequestSpy).toHaveBeenCalledTimes(2);
    expect((serviceRequestSpy.mock.calls[0][2] as { ids: string[] }).ids).toHaveLength(20);
    expect((serviceRequestSpy.mock.calls[1][2] as { ids: string[] }).ids).toEqual([
      'f20',
      'f21',
      'f22',
      'f23',
      'f24',
    ]);
    expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
      'POST',
      '/assets/service/federation/delete',
    ]);
    expect(results.find((r) => r.id === 'f3')?.result).toBe('in_use');
    expect(results.map((r) => r.id)).not.toContain('not-asked');
    // f21 got a result this build does not know (listed as deleted too): only the known one stays.
    expect(results.filter((r) => r.id === 'f21')).toEqual([{ id: 'f21', result: 'deleted' }]);
    expect(results).toHaveLength(25);
  });

  it('federatedMedia.delete of nothing sends nothing', async () => {
    await expect(oxy.assets.federatedMedia.delete([])).resolves.toEqual([]);
    expect(serviceRequestSpy).not.toHaveBeenCalled();
  });

  it('a budget refusal says how long to wait', async () => {
    serviceRequestSpy.mockRejectedValueOnce(
      new OxyApiError('Too many media cache uploads', {
        status: 429,
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 42 },
      }),
    );

    const refusal = await oxy.assets.mediaCache
      .upload(new Uint8Array([1]), 'image/png')
      .catch((error: unknown) => error);

    expect(retryAfterSecondsOf(refusal)).toBe(42);
    expect(retryAfterSecondsOf(new Error('boom'))).toBeUndefined();
    expect(retryAfterSecondsOf({ response: { data: { details: { retryAfterSeconds: 7 } } } })).toBe(
      7,
    );
  });
});
