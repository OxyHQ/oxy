/**
 * `oxy.withCallOptions(options)` — per-call transport options for any
 * namespace call, without a second client or a per-method options parameter.
 *
 * Pins what reaches the transport (`http.request`) for each kind of call: a
 * write, a cached read, a batched lookup and a call one namespace makes into
 * another; how the scope combines with what the method sets itself; and that
 * the scope is a view of the same client (session, cache), not a copy.
 */
import { OxyServices } from '../OxyServices';
import type { RequestOptions } from '../HttpService';

type SentRequest = RequestOptions & { method: string; url: string };

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

describe('OxyServices.withCallOptions', () => {
  let oxy: OxyServices;
  let sent: SentRequest[];
  let requestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'u1' }));
    sent = [];
    requestSpy = jest.spyOn(oxy.http, 'request').mockImplementation(async (config) => {
      sent.push(config as SentRequest);
      const url = (config as SentRequest).url;
      if (url.endsWith('/visibility')) {
        return { file: { id: 'f1', visibility: 'public', updatedAt: 'now' } } as never;
      }
      if (url === '/users/by-ids') {
        const { ids } = (config as { data: { ids: string[] } }).data;
        return ids.map((id) => ({ id, username: `user-${id}` })) as never;
      }
      return { id: 'u2', username: 'ada' } as never;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gives a write its own timeout and keeps what the method sets', async () => {
    await oxy.withCallOptions({ timeout: 60_000 }).assets.setVisibility('f1', 'public');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'PATCH',
      url: '/assets/f1/visibility',
      cache: false,
      timeout: 60_000,
    });
  });

  it('gives a cached read a whole-call deadline and sends it once', async () => {
    await oxy.withCallOptions({ deadline: 2_500, retry: false }).users.byUsername('ada');

    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: '/profiles/username/ada',
      cache: true,
      deadline: 2_500,
      retry: false,
    });
  });

  it('carries the options on every chunk of a batched lookup', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const result = await oxy.withCallOptions({ deadline: 2_500 }).users.lookupMany(ids);

    expect(result.found).toHaveLength(150);
    expect(sent.length).toBeGreaterThan(1);
    for (const request of sent) {
      expect(request).toMatchObject({ url: '/users/by-ids', deadline: 2_500 });
    }
  });

  it('keeps the options on a call one namespace makes into another', async () => {
    // A bearer that names no user: `privacy.settings()` resolves "me" through `users.me()`.
    oxy.session.setAccessToken(makeJwt({ sessionId: 's1' }));
    await oxy.withCallOptions({ timeout: 1_234 }).privacy.settings();

    expect(sent.map((request) => request.url)).toEqual(['/users/me', '/privacy/u2/privacy']);
    for (const request of sent) expect(request.timeout).toBe(1_234);
  });

  it('never turns retries back on for a request the method sends once', async () => {
    // A method that sends once on purpose passes `retry: false`; emulate one
    // through the scope's own context, exactly as a namespace would.
    const scoped = oxy.withCallOptions({ retry: true }) as unknown as {
      context: {
        request: (m: string, u: string, d: unknown, o: RequestOptions) => Promise<unknown>;
      };
    };
    await scoped.context.request('POST', '/once', {}, { retry: false });
    await scoped.context.request('GET', '/any', undefined, {});

    expect(sent[0].retry).toBe(false);
    expect(sent[1].retry).toBe(true);
  });

  it('aborts with the scope’s signal, and with the method’s own', async () => {
    const scopeController = new AbortController();
    const methodController = new AbortController();
    const scoped = oxy.withCallOptions({ signal: scopeController.signal }) as unknown as {
      context: {
        request: (m: string, u: string, d: unknown, o: RequestOptions) => Promise<unknown>;
      };
    };

    await scoped.context.request('GET', '/a', undefined, {});
    expect(sent[0].signal).toBe(scopeController.signal);

    let seen: AbortSignal | undefined;
    requestSpy.mockImplementationOnce(async (config) => {
      seen = (config as SentRequest).signal;
      methodController.abort(new Error('method gave up'));
      return {} as never;
    });
    await scoped.context.request('GET', '/b', undefined, { signal: methodController.signal });
    expect(seen).toBeDefined();
    expect(seen).not.toBe(scopeController.signal);
    expect(seen?.aborted).toBe(true);
    expect(scopeController.signal.aborted).toBe(false);
  });

  it('is a view of the same client: session and cache are shared, namespaces are its own', async () => {
    const scoped = oxy.withCallOptions({ timeout: 5_000 });

    expect(scoped.users).not.toBe(oxy.users);
    expect(scoped.users).toBe(scoped.users);
    expect((scoped as unknown as OxyServices).session).toBe(oxy.session);
    expect((scoped as unknown as OxyServices).http).toBe(oxy.http);

    const evict = jest.spyOn(oxy.http, 'invalidateCache');
    await scoped.assets.setVisibility('f1', 'public');
    expect(evict).toHaveBeenCalled();
  });

  it('leaves the client itself unscoped', async () => {
    oxy.withCallOptions({ timeout: 60_000 });
    await oxy.assets.setVisibility('f1', 'public');

    expect(sent[0].timeout).toBeUndefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a budget of %p', (value) => {
    expect(() => oxy.withCallOptions({ timeout: value })).toThrow(RangeError);
    expect(() => oxy.withCallOptions({ deadline: value })).toThrow(RangeError);
  });
});
