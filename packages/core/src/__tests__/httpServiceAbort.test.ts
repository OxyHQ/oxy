/**
 * Cancellation and timeout regressions.
 *
 * `HttpService` used to build its `AbortController` INSIDE the function
 * `retryAsync` re-invokes, and link the caller's signal to each new controller
 * with a bare `addEventListener`. Since `abort` is a once-only event, a signal
 * that had already fired could not abort the controller built for attempt 2 —
 * so a request the caller had CANCELLED was re-issued for real. A caller abort
 * also reached the retry predicate as an `AbortError` carrying `status: 0`,
 * which is not 4xx, so the predicate read it as a transient failure worth
 * another try. With the 5s default timeout and 3 retries that is ~28s of work
 * after the caller stopped waiting, inside a request queue ten slots deep.
 *
 * Every test here pins one half of "a cancellation is an instruction, not a
 * failure": nothing retries it, nothing queues it, and nothing leaks after it.
 */
import { HttpService } from '../HttpService';
import { ErrorCodes } from '../utils/errorUtils';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch that never responds, but DOES honour its abort signal — rejecting
 * with an `AbortError` exactly as the real one does.
 *
 * Honouring the signal is not harness politeness, it is the whole point: the
 * behaviour under test is what happens after an abort, so a fake that ignores
 * the signal would hang instead of exercising it.
 */
function hangingFetch(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (!signal) return;
        if (signal.aborted) { fail(); return; }
        signal.addEventListener('abort', fail, { once: true });
      });
    }) as typeof globalThis.fetch,
    calls: () => calls,
  };
}

/**
 * Pin the retry backoff's jitter to zero.
 *
 * `retryAsync`'s delay is `baseDelay * 2**attempt + Math.random() * 1000`, so
 * with real timers a retry can land up to a second later. A test that waits a
 * fixed 80ms to prove "no retry happened" would then pass whether the bug was
 * present or not — it would just be measuring the jitter. Pinning it makes the
 * retry window exactly `baseDelay * (1 + 2 + 4)`, which a short wait covers
 * decisively.
 */
function pinJitter(): void {
  jest.spyOn(Math, 'random').mockReturnValue(0);
}

describe('HttpService cancellation', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('never calls fetch for a signal that was already aborted', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as typeof globalThis.fetch;

    const http = new HttpService({ baseURL: 'https://api.test' });
    const controller = new AbortController();
    controller.abort();

    await expect(http.get('/thing', { signal: controller.signal })).rejects.toMatchObject({
      code: ErrorCodes.CANCELLED,
    });
    expect(calls).toBe(0);
  });

  it('issues exactly one fetch when a request is cancelled mid-flight, with retry on', async () => {
    pinJitter();
    const { fetch, calls } = hangingFetch();
    globalThis.fetch = fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 3,
      retryDelay: 1,
    });

    const controller = new AbortController();
    const pending = http.get('/thing', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.CANCELLED });

    // Let the request reach fetch, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls()).toBe(1);
    controller.abort();
    await assertion;

    // The retry budget was 3 more attempts, whose backoff with jitter pinned is
    // 1+2+4ms. Waiting well past that window is what proves none of them ran,
    // and it is the crux of the defect: the re-issued request went out AFTER
    // the rejection the caller saw, so a test that stopped at the rejection
    // would have passed with the bug fully present.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls()).toBe(1);
  });

  it('leaves no abort listener on a caller signal that outlives the request', async () => {
    globalThis.fetch = (async () => jsonResponse({ ok: true })) as typeof globalThis.fetch;

    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    jest.spyOn(controller.signal, 'addEventListener').mockImplementation(((type: string, fn: never, opts: never) => {
      if (type === 'abort') added.push(fn);
      return realAdd(type as 'abort', fn, opts);
    }) as never);
    jest.spyOn(controller.signal, 'removeEventListener').mockImplementation(((type: string, fn: never, opts: never) => {
      if (type === 'abort') removed.push(fn);
      return realRemove(type as 'abort', fn, opts);
    }) as never);

    const http = new HttpService({ baseURL: 'https://api.test' });
    // A React Query query signal is reused across the query's whole lifetime,
    // so a listener left behind per request is an unbounded leak, not a nit.
    for (let i = 0; i < 5; i++) {
      await http.get(`/thing-${i}`, { signal: controller.signal, cache: false, deduplicate: false });
    }

    expect(added.length).toBeGreaterThan(0);
    expect(removed.length).toBe(added.length);
  });

  it('does not consume a queue slot for a cancelled request, so a live one still runs', async () => {
    const live: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/live')) {
        live.push(url);
        return jsonResponse({ ok: true });
      }
      // Cancelled requests never get here; if one does, it would hold a slot.
      return new Promise<Response>(() => { /* never settles */ });
    }) as typeof globalThis.fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      maxConcurrentRequests: 2,
      enableRetry: false,
    });

    // Fill more than the pool with requests whose callers have already gone.
    const dead = Array.from({ length: 6 }, (_, i) => {
      const controller = new AbortController();
      controller.abort();
      return http.get(`/dead-${i}`, { signal: controller.signal }).catch(() => 'cancelled');
    });
    await Promise.all(dead);

    // With only two slots, this is the assertion that matters: the live request
    // is not queued behind six abandoned ones.
    await expect(http.get('/live', { cache: false })).resolves.toBeDefined();
    expect(live).toHaveLength(1);
  });
});

describe('HttpService timeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('does not retry a timeout by default, and reports it as a timeout not a cancellation', async () => {
    pinJitter();
    const { fetch, calls } = hangingFetch();
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
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    // One attempt, not four. Four behind a short timeout is how a single slow
    // endpoint used to cost tens of seconds of wall clock.
    expect(calls()).toBe(1);
  });

  it('retries a timeout when the caller opts in', async () => {
    const { fetch, calls } = hangingFetch();
    globalThis.fetch = fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 2,
      retryDelay: 1,
      requestTimeout: 20,
    });

    await expect(
      http.get('/slow', { cache: false, retryOnTimeout: true }),
    ).rejects.toMatchObject({ code: ErrorCodes.TIMEOUT });

    expect(calls()).toBe(3);
  });

  it('bounds total wall clock with a deadline, even with retries on', async () => {
    pinJitter();
    const { fetch } = hangingFetch();
    globalThis.fetch = fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 5,
      retryDelay: 100,
      requestTimeout: 20,
    });

    const started = Date.now();
    await expect(
      http.get('/slow', { cache: false, retryOnTimeout: true, deadline: 150 }),
    ).rejects.toBeDefined();

    // `timeout` bounds an attempt; `deadline` bounds the call. Without it the
    // total is attempts x timeout + backoff, which no call site computes.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('still retries a 5xx — the fix must not disable retry wholesale', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ error: 'boom' }, 503);
    }) as typeof globalThis.fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 2,
      retryDelay: 1,
    });

    await expect(http.get('/flaky', { cache: false })).rejects.toBeDefined();
    expect(calls).toBe(3);
  });

  it('still refuses to retry a 4xx', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ error: 'nope' }, 404);
    }) as typeof globalThis.fetch;

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: true,
      maxRetries: 3,
      retryDelay: 1,
    });

    await expect(http.get('/missing', { cache: false })).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it('arms no timer past a request that threw before returning', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'nope' }, 404)) as typeof globalThis.fetch;
    jest.useFakeTimers({ doNotFake: ['nextTick'] });

    const http = new HttpService({
      baseURL: 'https://api.test',
      enableRetry: false,
      requestTimeout: 30_000,
    });

    await expect(http.get('/missing', { cache: false })).rejects.toBeDefined();
    // `clearTimeout` used to sit on the success path only, so any throw between
    // the fetch and the return left a 30s timer armed.
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
