import { HttpService } from '../HttpService';
import { stopAllCleanupIntervals } from '../utils/cache';

const response = (value: string) =>
  new Response(JSON.stringify({ data: { value } }), {
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  jest.restoreAllMocks();
  stopAllCleanupIntervals();
});

test.each(['all', 'key', 'prefix'] as const)(
  '%s invalidation separates pending reads and prevents late stale cache writes',
  async (mode) => {
    let releaseOld!: (value: Response) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        started();
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      })
      .mockResolvedValueOnce(response('fresh'));
    const http = new HttpService({ baseURL: 'https://test.invalid', enableRetry: false });
    const old = http.get('/users/me');
    await firstStarted;
    if (mode === 'all') http.clearCache();
    if (mode === 'key') http.clearCacheEntry('GET:/users/me');
    if (mode === 'prefix') http.clearCacheByPrefix('GET:/users/');
    const fresh = http.get('/users/me');
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseOld(response('old'));
    await expect(old).resolves.toEqual({ value: 'old' });
    await expect(fresh).resolves.toEqual({ value: 'fresh' });
    await expect(http.get('/users/me')).resolves.toEqual({ value: 'fresh' });
    expect(fetch).toHaveBeenCalledTimes(2);
    http.dispose();
  },
);

test('targeted invalidation preserves unrelated pending deduplication and cached data', async () => {
  let release!: (value: Response) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response('warm'))
    .mockImplementationOnce(() => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
  const http = new HttpService({ baseURL: 'https://test.invalid', enableRetry: false });
  await http.get('/public');
  const pending = http.get('/other');
  await startedPromise;
  http.clearCacheByPrefix('GET:/users/');
  const same = http.get('/other');
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(response('shared'));
  await expect(pending).resolves.toEqual({ value: 'shared' });
  await expect(same).resolves.toEqual({ value: 'shared' });
  await expect(http.get('/other')).resolves.toEqual({ value: 'shared' });
  await expect(http.get('/public')).resolves.toEqual({ value: 'warm' });
  expect(fetch).toHaveBeenCalledTimes(2);
  http.dispose();
});

test('an invalidated request finishing alone cannot repopulate cache', async () => {
  let release!: (value: Response) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    })
    .mockResolvedValueOnce(response('fresh'));
  const http = new HttpService({ baseURL: 'https://test.invalid', enableRetry: false });
  const old = http.get('/users/me');
  await startedPromise;
  http.clearCacheEntry('GET:/users/me');
  release(response('old'));
  await old;
  expect(http.getCacheStats().size).toBe(0);
  await expect(http.get('/users/me')).resolves.toEqual({ value: 'fresh' });
  expect(fetch).toHaveBeenCalledTimes(2);
  http.dispose();
});
