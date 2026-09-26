/**
 * Queue, dedupe and retry composition regressions.
 *
 * - A 401's refresh-and-retry re-entered the queue while the original attempt
 *   still held its slot: with every slot held by a 401 (a revoked session under
 *   load) no retry could start and the whole client stalled.
 * - Deduplication keyed an opaque body (`FormData`, `URLSearchParams`) as an
 *   empty object, so two different uploads collapsed into one call.
 * - Writes were retried by default, so a POST that hit a 5xx could apply twice.
 * - The shared work of a deduplicated call ran in the FIRST caller's abort
 *   domain, so that caller cancelling failed every other caller on the key.
 */
import { HttpService } from '../HttpService';

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('HttpService queue, dedupe and retry composition', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries a 401 storm that fills every slot instead of stalling', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const fresh = createJwt({ userId: 'u', exp: future, v: 2 });
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === `Bearer ${fresh}` ? jsonResponse({ ok: true }) : jsonResponse(null, 401);
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', maxConcurrentRequests: 2, enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: future, v: 1 }));
    http.setAuthRefreshHandler(async () => fresh);

    const all = Promise.all(
      ['/a', '/b', '/c', '/d'].map((path) => http.get(path, { cache: false })),
    );

    expect(await settlesWithin(all, 1000)).toBe(true);
    await expect(all).resolves.toHaveLength(4);
    expect(calls).toBe(8);
  });

  it('never merges two concurrent uploads with different bodies', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      return jsonResponse({ n: bodies.length });
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    const a = new FormData();
    a.append('file', 'a');
    const b = new FormData();
    b.append('file', 'b');

    const [ra, rb] = await Promise.all([
      http.post('/assets/upload', a, { skipAuth: true }),
      http.post('/assets/upload', b, { skipAuth: true }),
    ]);

    expect(bodies).toHaveLength(2);
    expect(ra).not.toEqual(rb);
  });

  it('does not re-send a POST that failed with a 5xx', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(null, 503);
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', retryDelay: 1 });
    await expect(http.post('/payments', { amount: 1 }, { skipAuth: true })).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('still retries a GET that failed with a 5xx', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 2 ? jsonResponse(null, 503) : jsonResponse({ ok: true });
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', retryDelay: 1 });
    await expect(http.get('/health', { skipAuth: true, cache: false })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('keeps a deduplicated call alive when only the first caller cancels', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(jsonResponse({ shared: true }));
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    const first = new AbortController();
    const a = http.get('/users/1', { skipAuth: true, cache: false, signal: first.signal });
    const b = http.get('/users/1', { skipAuth: true, cache: false, signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.abort();
    await expect(a).rejects.toMatchObject({ code: 'CANCELLED' });
    release?.();
    await expect(b).resolves.toEqual({ shared: true });
    expect(calls).toBe(1);
  });
});
