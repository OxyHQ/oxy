/**
 * An abort is recognised by OUR signal, not by the shape of the platform's error.
 *
 * Expo's `fetch` — the global `fetch` of an Expo 52+ native app — rejects an
 * aborted request with a plain `Error`, `fetch failed: Fetch request has been
 * canceled`, carrying no `AbortError` name. `HttpService` classified aborts by
 * that name only, so on a phone its own 5s per-attempt timeout came out of
 * `handleHttpError` as `NETWORK_ERROR` with `status: 0` (measured in Allo: a
 * `users.getMany` chunk logged exactly that message), and a caller's
 * cancellation was reported as a network failure the retry loop would try
 * again. The fake below rejects the way Expo's does.
 */
import { HttpService } from '../HttpService';
import { ErrorCodes } from '../utils/errorUtils';

/** Never answers; on abort rejects like `expo/fetch` (a `FetchError`, name `Error`). */
function expoLikeHangingFetch(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(new Error('fetch failed: Fetch request has been canceled'));
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      });
    }) as typeof globalThis.fetch,
    calls: () => calls,
  };
}

describe('HttpService abort classification under Expo fetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reports its own timeout as TIMEOUT, not as a network error', async () => {
    const { fetch, calls } = expoLikeHangingFetch();
    globalThis.fetch = fetch;
    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 3,
      retryDelay: 1,
      requestTimeout: 20,
    });

    await expect(http.get('/slow', { cache: false })).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
      timeout: true,
      message: 'Request timed out after 20ms',
    });
    // A timeout costs one attempt by default; read as a network error it cost four.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls()).toBe(1);
  });

  it('reports a POST timeout (the users.getMany chunk) as TIMEOUT', async () => {
    globalThis.fetch = expoLikeHangingFetch().fetch;
    const http = new HttpService({ baseURL: 'https://api.test', requestTimeout: 20 });

    await expect(
      http.post('/users/by-ids', { ids: ['a'] }, { cache: false }),
    ).rejects.toMatchObject({ code: ErrorCodes.TIMEOUT, timeout: true });
  });

  it("reports a caller's cancellation as CANCELLED, and never retries it", async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { fetch, calls } = expoLikeHangingFetch();
    globalThis.fetch = fetch;
    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 3,
      retryDelay: 1,
    });

    const controller = new AbortController();
    const pending = http.get('/thing', { cache: false, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.CANCELLED });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assertion;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls()).toBe(1);
  });

  it('still reports a genuine network failure (no abort) as a network error', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Network request failed');
    }) as typeof globalThis.fetch;
    const http = new HttpService({ baseURL: 'https://api.test', enableRetry: false });

    await expect(http.get('/thing', { cache: false })).rejects.toMatchObject({
      code: ErrorCodes.NETWORK_ERROR,
      status: 0,
    });
  });
});
