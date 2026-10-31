/**
 * In-session access-token refresh plumbing.
 *
 * These guard the HttpService surface that `@oxy.so/services`' OxyContext now
 * drives via `setAuthRefreshHandler`: a 401 re-mints through the handler and
 * retries the ORIGINAL request with the fresh token; an unrecoverable refresh
 * clears tokens and notifies listeners (the reconcile signal that flips the RN
 * provider out of its zombie logged-in state); concurrent refreshes coalesce and
 * a failed refresh is cooldown-guarded (no refresh storm). Plus the new
 * `OxyServices.getAccessTokenExpiry()` helper the proactive scheduler reads.
 */
import { HttpService } from '../HttpService';
import { OxyServices } from '../OxyServices';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'token expired' }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  });
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

const farFutureExp = (): number => Math.floor(Date.now() / 1000) + 3600;

describe('HttpService in-session refresh handler', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('invalidates the old session epoch when a 401 clears the bearer', async () => {
    globalThis.fetch = async () => unauthorized();
    const onRequestError = jest.fn();
    const http = new HttpService({
      baseURL: 'https://example.test',
      enableRetry: false,
      onRequestError,
    });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'session-a' }));
    const oldEpoch = http.getSessionEpoch();
    const notifications: Array<string | null> = [];
    http.addTokenChangeListener((token) => notifications.push(token));

    await expect(http.get('/private', { retry: false })).rejects.toMatchObject({ status: 401 });
    expect(onRequestError).toHaveBeenCalledTimes(1);
    expect(http.getAccessToken()).toBeNull();
    expect(notifications).toEqual([null]);
    expect(http.getSessionEpoch()).toBeGreaterThan(oldEpoch);

    http.setTokens(createJwt({ userId: 'bob', sessionId: 'session-b' }));
    expect(http.getSessionEpoch()).toBeGreaterThan(oldEpoch);
  });

  it('does not treat an old 401 as current if B arrives while its body is read', async () => {
    let release!: (value: unknown) => void;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const response = unauthorized();
    response.json = jest.fn(() => {
      markReading();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    globalThis.fetch = jest.fn(async () => response);
    const onRequestError = jest.fn();
    const http = new HttpService({
      baseURL: 'https://example.test',
      enableRetry: false,
      onRequestError,
    });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private');
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await reading;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release({ message: 'old error' });
    await failure;
    expect(onRequestError).not.toHaveBeenCalled();
  });

  it('cancels only the caller waiting on a shared preflight refresh', async () => {
    let release!: (token: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const old = createJwt({
      userId: 'alice',
      sessionId: 'a',
      exp: Math.floor(Date.now() / 1000) + 1,
    });
    const fresh = createJwt({ userId: 'alice', sessionId: 'a', jti: 'fresh', exp: farFutureExp() });
    http.setTokens(old);
    http.setAuthRefreshHandler(() => {
      markStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    globalThis.fetch = jest.fn(async () => jsonResponse({ ok: true }));
    const controller = new AbortController();
    const cancelled = http.get('/first', { signal: controller.signal });
    const failure = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    const live = http.get('/second');
    controller.abort();
    await failure;
    expect(globalThis.fetch).not.toHaveBeenCalled();
    release(fresh);
    await expect(live).resolves.toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not consult the provider or start refresh when already aborted', async () => {
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const controller = new AbortController();
    controller.abort();
    const provider = jest.fn(() => createJwt({ userId: 'alice' }));
    const refresh = jest.fn(async () => null);
    globalThis.fetch = jest.fn(async () => jsonResponse({ ok: true }));
    http.setAccessTokenProvider(provider);
    http.setAuthRefreshHandler(refresh);
    await expect(http.get('/private', { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('cancels one 401 refresh waiter without cancelling the shared refresh', async () => {
    let release!: (token: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const old = createJwt({ userId: 'alice', sessionId: 'a', jti: 'old', exp: farFutureExp() });
    const fresh = createJwt({ userId: 'alice', sessionId: 'a', jti: 'fresh', exp: farFutureExp() });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(old);
    const refresh = jest.fn(() => {
      markStarted();
      return new Promise<string | null>((resolve) => {
        release = resolve;
      });
    });
    http.setAuthRefreshHandler(refresh);
    globalThis.fetch = jest.fn(async (_url, init) =>
      new Headers(init?.headers).get('authorization') === `Bearer ${fresh}`
        ? jsonResponse({ ok: true })
        : unauthorized(),
    );
    const controller = new AbortController();
    const cancelled = http.get('/first', { signal: controller.signal });
    const failure = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    const live = http.get('/second');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await failure;
    release(fresh);
    await expect(live).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps a deduplicated 401 request alive when only one caller cancels', async () => {
    let release!: (token: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const old = createJwt({ userId: 'alice', sessionId: 'a', jti: 'old', exp: farFutureExp() });
    const fresh = createJwt({ userId: 'alice', sessionId: 'a', jti: 'fresh', exp: farFutureExp() });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(old);
    const refresh = jest.fn(() => {
      markStarted();
      return new Promise<string | null>((resolve) => {
        release = resolve;
      });
    });
    http.setAuthRefreshHandler(refresh);
    globalThis.fetch = jest.fn(async (_url, init) =>
      new Headers(init?.headers).get('authorization') === `Bearer ${fresh}`
        ? jsonResponse({ ok: true })
        : unauthorized(),
    );
    const controller = new AbortController();
    const cancelled = http.get('/shared', { signal: controller.signal });
    const failure = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    const live = http.get('/shared');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await failure;
    release(fresh);
    await expect(live).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not refresh, retry or clear B when an A request returns a late 401', async () => {
    let respond!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      markStarted();
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const alice = createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() });
    const bob = createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() });
    http.setTokens(alice);
    const refresh = jest.fn(async () => bob);
    http.setAuthRefreshHandler(refresh);
    const request = http.get('/private', { retry: false });
    const failed = expect(request).rejects.toBeDefined();
    await started;
    http.setTokens(bob);
    respond(unauthorized());
    await failed;
    expect(http.getAccessToken()).toBe(bob);
    expect(refresh).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['null', 'bob'] as const)(
    'does not clear or retry as B when pending A refresh returns %s',
    async (result) => {
      globalThis.fetch = jest.fn(async () => unauthorized());
      let finishRefresh!: (token: string | null) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
      const alice = createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() });
      const bob = createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() });
      http.setTokens(alice);
      http.setAuthRefreshHandler(() => {
        markStarted();
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      });
      const request = http.get('/private', { retry: false });
      const failed = expect(request).rejects.toBeDefined();
      await started;
      http.setTokens(bob);
      finishRefresh(result === 'bob' ? bob : null);
      await failed;
      expect(http.getAccessToken()).toBe(bob);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['Authorization', 'authorization'])(
    'does not refresh or clear the session for a 401 with explicit %s',
    async (headerName) => {
      let sent: Headers | undefined;
      globalThis.fetch = jest.fn(async (_input, init) => {
        sent = new Headers(init?.headers);
        return unauthorized();
      });
      const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
      const alice = createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() });
      http.setTokens(alice);
      const refresh = jest.fn(async () => null);
      http.setAuthRefreshHandler(refresh);
      await expect(
        http.get('/private', { retry: false, headers: { [headerName]: 'Bearer external' } }),
      ).rejects.toBeDefined();
      expect(sent?.get('authorization')).toBe('Bearer external');
      expect(http.getAccessToken()).toBe(alice);
      expect(refresh).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not send a queued A request after switching to B', async () => {
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      markStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const http = new HttpService({
      baseURL: 'https://example.test',
      enableRetry: false,
      maxConcurrentRequests: 1,
    });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const holder = http.get('/holder', { skipAuth: true, cache: false });
    await started;
    const request = http.get('/private', { retry: false, cache: false });
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release(jsonResponse({ ok: true }));
    await holder;
    await failure;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry A work after switching to B during backoff', async () => {
    const http = new HttpService({ baseURL: 'https://example.test', retryDelay: 1 });
    const bob = createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() });
    globalThis.fetch = jest.fn(async () => {
      http.setTokens(bob);
      return new Response('{}', { status: 503 });
    });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    await expect(http.get('/private', { cache: false, maxRetries: 1 })).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(http.getAccessToken()).toBe(bob);
  });

  it('does not return or cache a late successful A response after switching to B', async () => {
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      markStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private');
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release(jsonResponse({ owner: 'alice' }));
    await failure;
    expect(http.getCacheStats().size).toBe(0);
  });

  it.each([
    ['without cancel', {}],
    [
      'with a synchronous failure',
      {
        cancel: () => {
          throw new Error('unsupported');
        },
      },
    ],
    ['with a rejected promise', { cancel: () => Promise.reject(new Error('unsupported')) }],
  ])('preserves the session error for a native body %s', async (_name, body) => {
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      markStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private');
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    const response = jsonResponse({ owner: 'alice' });
    Object.defineProperty(response, 'body', { value: body });
    release(response);
    await failure;
  });

  it('still delivers explicitly unauthenticated responses across an account switch', async () => {
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      markStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/public', { skipAuth: true, cache: false });
    await started;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release(jsonResponse({ public: true }));
    await expect(request).resolves.toEqual({ public: true });
  });

  it('does not return a response whose body finishes after the account changes', async () => {
    let release!: (value: unknown) => void;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const response = jsonResponse({ owner: 'alice' });
    response.json = jest.fn(() => {
      markReading();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    globalThis.fetch = jest.fn(async () => response);
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private');
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await reading;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release({ data: { owner: 'alice' } });
    await failure;
    expect(http.getCacheStats().size).toBe(0);
  });

  it('prioritizes the session change when an old 403 body completes late', async () => {
    let release!: (value: unknown) => void;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const response = new Response('{}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    response.json = jest.fn(() => {
      markReading();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    globalThis.fetch = jest.fn(async () => response);
    const onRequestError = jest.fn();
    const http = new HttpService({
      baseURL: 'https://example.test',
      enableRetry: false,
      onRequestError,
    });
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private');
    const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await reading;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    release({ message: 'alice private denial' });
    await failure;
    expect(onRequestError).not.toHaveBeenCalled();
  });

  it.each(['json', 'blob', 'text'] as const)(
    'prioritizes the session change when an old %s body fails',
    async (reader) => {
      let fail!: (error: Error) => void;
      let markReading!: () => void;
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      const response = new Response('{}', {
        status: 200,
        headers: { 'content-type': reader === 'json' ? 'application/json' : 'text/plain' },
      });
      Object.defineProperty(response, reader, {
        value: () => {
          markReading();
          return new Promise((_resolve, reject) => {
            fail = reject;
          });
        },
      });
      globalThis.fetch = jest.fn(async () => response);
      const onRequestError = jest.fn();
      const http = new HttpService({
        baseURL: 'https://example.test',
        enableRetry: false,
        onRequestError,
      });
      http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
      const request = http.get('/private', reader === 'blob' ? { responseType: 'blob' } : {});
      const failure = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await reading;
      http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
      fail(new Error('old private failure'));
      await failure;
      expect(onRequestError).not.toHaveBeenCalled();
    },
  );

  it('preserves explicit cancellation when the session also changes during body reading', async () => {
    let fail!: (error: Error) => void;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const response = jsonResponse({ ok: true });
    response.json = jest.fn(() => {
      markReading();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    globalThis.fetch = jest.fn(async () => response);
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const controller = new AbortController();
    http.setTokens(createJwt({ userId: 'alice', sessionId: 'a', exp: farFutureExp() }));
    const request = http.get('/private', { signal: controller.signal });
    const failure = expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
    await reading;
    http.setTokens(createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() }));
    controller.abort();
    fail(new Error('cancelled body'));
    await failure;
  });

  it('retries with a newer bearer from the same session without clearing it', async () => {
    let respond!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const calls: FetchCall[] = [];
    globalThis.fetch = jest.fn((input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        markStarted();
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const alice1 = createJwt({ userId: 'alice', sessionId: 'a', jti: '1', exp: farFutureExp() });
    const alice2 = createJwt({ userId: 'alice', sessionId: 'a', jti: '2', exp: farFutureExp() });
    http.setTokens(alice1);
    const refresh = jest.fn(async () => null);
    http.setAuthRefreshHandler(refresh);
    const request = http.get('/private', { retry: false });
    await started;
    http.setTokens(alice2);
    respond(unauthorized());
    await expect(request).resolves.toEqual({ ok: true });
    expect(http.getAccessToken()).toBe(alice2);
    expect(refresh).not.toHaveBeenCalled();
    expect(readHeaders(calls[1].init).Authorization).toBe(`Bearer ${alice2}`);
  });

  it('uses a same-session rotation that arrives while refresh fails', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = jest.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? unauthorized() : jsonResponse({ ok: true });
    });
    let finishRefresh!: (token: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const alice1 = createJwt({ userId: 'alice', sessionId: 'a', jti: '1', exp: farFutureExp() });
    const alice2 = createJwt({ userId: 'alice', sessionId: 'a', jti: '2', exp: farFutureExp() });
    http.setTokens(alice1);
    http.setAuthRefreshHandler(() => {
      markStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const request = http.get('/private', { retry: false });
    await started;
    http.setTokens(alice2);
    finishRefresh(null);
    await expect(request).resolves.toEqual({ ok: true });
    expect(http.getAccessToken()).toBe(alice2);
    expect(readHeaders(calls[1].init).Authorization).toBe(`Bearer ${alice2}`);
  });

  it('does not overwrite a newer same-session token when an older refresh completes', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = jest.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? unauthorized() : jsonResponse({ ok: true });
    });
    let finishRefresh!: (token: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
    const alice1 = createJwt({ userId: 'alice', sessionId: 'a', jti: '1', exp: farFutureExp() });
    const alice2 = createJwt({ userId: 'alice', sessionId: 'a', jti: '2', exp: farFutureExp() });
    const stale = createJwt({ userId: 'alice', sessionId: 'a', jti: 'stale', exp: farFutureExp() });
    http.setTokens(alice1);
    http.setAuthRefreshHandler(() => {
      markStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const request = http.get('/private', { retry: false });
    await started;
    http.setTokens(alice2);
    finishRefresh(stale);
    await expect(request).resolves.toEqual({ ok: true });
    expect(http.getAccessToken()).toBe(alice2);
    expect(readHeaders(calls[1].init).Authorization).toBe(`Bearer ${alice2}`);
  });

  it.each(['null', 'bob'] as const)(
    'does not send A work after preflight switches to B and returns %s',
    async (result) => {
      globalThis.fetch = jest.fn(async () => jsonResponse({ ok: true }));
      let finishRefresh!: (token: string | null) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
      const alice = createJwt({
        userId: 'alice',
        sessionId: 'a',
        exp: Math.floor(Date.now() / 1000) + 1,
      });
      const bob = createJwt({ userId: 'bob', sessionId: 'b', exp: farFutureExp() });
      http.setTokens(alice);
      http.setAuthRefreshHandler(() => {
        markStarted();
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      });
      const request = http.get('/private', { retry: false });
      const failed = expect(request).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await started;
      http.setTokens(bob);
      finishRefresh(result === 'bob' ? bob : null);
      await failed;
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(http.getAccessToken()).toBe(bob);
    },
  );

  it('refreshes via the handler on a 401 and retries the original request with the fresh token', async () => {
    const oldToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'old' });
    const newToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'new' });
    const calls: FetchCall[] = [];
    let feedAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/feed')) {
        feedAttempts += 1;
        if (feedAttempts === 1) return unauthorized();
      }
      return jsonResponse({ ok: true });
    };

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(oldToken);

    let handlerCalls = 0;
    const reasons: string[] = [];
    http.setAuthRefreshHandler(async (reason) => {
      handlerCalls += 1;
      reasons.push(reason);
      // Simulate a silent arm planting the rotated token internally.
      http.setTokens(newToken);
      return newToken;
    });

    const result = await http.post('/feed', { cursor: 0 }, { retry: false });

    expect(result).toEqual({ ok: true });
    expect(handlerCalls).toBe(1);
    expect(reasons).toEqual(['response-401']);

    const feedCalls = calls.filter((call) => call.url.endsWith('/feed'));
    expect(feedCalls).toHaveLength(2);
    // The original request is retried carrying the FRESH bearer.
    expect(readHeaders(feedCalls[1].init).Authorization).toBe(`Bearer ${newToken}`);
    expect(http.getAccessToken()).toBe(newToken);
  });

  it('clears tokens and notifies listeners when the handler cannot refresh on a 401 (reconcile signal)', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/feed')) return unauthorized();
      return jsonResponse({ ok: true });
    };

    const oxy = new OxyServices({ baseURL: 'https://api.mention.earth' });
    oxy.session.setAccessToken(createJwt({ userId: 'u', exp: farFutureExp() }));

    const tokenEvents: Array<string | null> = [];
    oxy.session.onChange((token) => tokenEvents.push(token));

    oxy.http.setAuthRefreshHandler(async () => null);

    await expect(oxy.http.post('/feed', {}, { retry: false })).rejects.toBeDefined();

    // The dead session reconciles: token cleared + a null change emitted (which
    // OxyContext's `handleTokenChange(null)` turns into a local sign-out).
    expect(oxy.session.accessToken).toBeNull();
    expect(tokenEvents).toContain(null);
  });

  it('coalesces concurrent refreshes into a single handler invocation', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const newToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'fresh' });

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: farFutureExp() }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      http.setTokens(newToken);
      return newToken;
    });

    const [a, b, c] = await Promise.all([
      http.refreshAccessToken('preflight'),
      http.refreshAccessToken('preflight'),
      http.refreshAccessToken('preflight'),
    ]);

    expect(handlerCalls).toBe(1);
    expect([a, b, c]).toEqual([newToken, newToken, newToken]);
  });

  it('cooldown-guards a failed refresh so it does not storm the handler', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: farFutureExp() }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    const first = await http.refreshAccessToken('preflight');
    const second = await http.refreshAccessToken('preflight');

    expect(first).toBeNull();
    expect(second).toBeNull();
    // The second call is inside the post-failure cooldown → handler not re-run.
    expect(handlerCalls).toBe(1);
  });

  it('lets an EXPIRED token re-mint promptly instead of waiting out the long proactive cooldown', async () => {
    // Regression: an ECS rolling-deploy blip briefly fails a mint; the 15s
    // proactive cooldown then left the client forwarding/omitting a now-expired
    // bearer for up to 15s after the endpoint recovered (Mention /privacy 401s).
    // An already-expired token must recover on the short cooldown instead.
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    // Current token is already 10s past exp (exp is in SECONDS).
    http.setTokens(createJwt({ userId: 'u', exp: Math.floor(T0 / 1000) - 10 }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    // First attempt fails → records the failure timestamp.
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 500ms later: still inside the SHORT expired cooldown → NOT re-run. This is
    // the storm guard — an expired token does not fully bypass the cooldown.
    nowSpy.mockReturnValue(T0 + 500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 1.5s later: past the short expired cooldown but WELL inside the 15s
    // proactive cooldown → the expired token re-mints promptly.
    nowSpy.mockReturnValue(T0 + 1500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(2);

    nowSpy.mockRestore();
  });

  it('keeps the full 15s cooldown for a still-valid (proactive) near-expiry refresh', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    // Token is still valid for another hour — a proactive refresh, not expired.
    http.setTokens(createJwt({ userId: 'u', exp: Math.floor(T0 / 1000) + 3600 }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 1.5s later: past the short expired cooldown, but the token is NOT expired,
    // so the full proactive cooldown still applies → no re-run (no storm).
    nowSpy.mockReturnValue(T0 + 1500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    nowSpy.mockRestore();
  });
});

describe('HttpService.endSession — a sign-out outranks a refresh', () => {
  it('plants nothing when the session ends while a re-mint is in flight', async () => {
    const oldToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'old' });
    const lateToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'late' });
    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(oldToken);

    let finish!: (token: string | null) => void;
    http.setAuthRefreshHandler(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const seen: Array<string | null> = [];
    http.addTokenChangeListener((token) => seen.push(token));

    const pending = http.refreshAccessToken('preflight');
    http.endSession();
    finish(lateToken);

    await expect(pending).resolves.toBeNull();
    expect(http.getAccessToken()).toBeNull();
    expect(seen).toEqual([null]);
  });

  it('abandons only what was in flight: a later re-mint (another tab signed in) still runs', async () => {
    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    const fresh = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'fresh' });
    const handler = jest.fn(async () => fresh);
    http.setAuthRefreshHandler(handler);

    http.endSession();
    expect(http.hasSessionEnded()).toBe(true);
    await expect(http.refreshAccessToken('preflight')).resolves.toBe(fresh);
    expect(http.getAccessToken()).toBe(fresh);
    expect(http.hasSessionEnded()).toBe(false);
  });

  it('is what OxyServices.clearTokens does; a plain HttpService.clearTokens (a mirror) is not', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    const before = oxy.http.getSessionEpoch();
    oxy.session.clear();
    expect(oxy.http.getSessionEpoch()).toBe(before + 1);
    expect(oxy.http.hasSessionEnded()).toBe(true);

    const mirror = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    mirror.clearTokens();
    expect(mirror.getSessionEpoch()).toBe(0);
    expect(mirror.hasSessionEnded()).toBe(false);
  });
});

describe('OxyServices.getAccessTokenExpiry', () => {
  it('returns the JWT exp (seconds) of the current access token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    const exp = Math.floor(Date.now() / 1000) + 1234;
    oxy.session.setAccessToken(createJwt({ userId: 'u', exp }));
    expect(oxy.session.accessTokenExpiry).toBe(exp);
  });

  it('returns null when there is no access token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    expect(oxy.session.accessTokenExpiry).toBeNull();
  });

  it('returns null for an opaque / non-JWT token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken('opaque-not-a-jwt');
    expect(oxy.session.accessTokenExpiry).toBeNull();
  });

  it('returns null for a JWT with no numeric exp claim', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(createJwt({ userId: 'u' }));
    expect(oxy.session.accessTokenExpiry).toBeNull();
  });
});
