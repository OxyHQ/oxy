import { HttpService } from '../HttpService';
import { OxyServices } from '../OxyServices';
import { SessionClient } from '../session/SessionClient';
import { createSessionClientHost } from '../session/sessionClientHost';

function token(deviceId: unknown, jti: string): string {
  const payload = {
    userId: 'alice',
    sessionId: 'session-a',
    exp: 4102444800,
    jti,
    ...(deviceId === undefined ? {} : { deviceId }),
  };
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function state(deviceId: string, revision: number) {
  return {
    deviceId,
    revision,
    updatedAt: 1720000000000,
    activeAccountId: 'alice',
    accounts: [{ accountId: 'alice', sessionId: 'session-a', authuser: 0 }],
  };
}

describe('HttpService device-session ownership', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not let an old device bootstrap restore its bearer after a same-session migration', async () => {
    let deliver!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = jest.fn(async () => {
      markStarted();
      return waiting;
    }) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
    const d1 = token('d1', 'a');
    const d2 = token('d2', 'b');
    const obsolete = token('d1', 'c');
    oxy.session.setAccessToken(d1);
    const client = new SessionClient(createSessionClientHost(oxy));
    client.adoptState(state('d1', 1));
    try {
      const pending = client.bootstrap();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await started;
      const epoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(d2);
      deliver(
        response({
          state: state('d1', 2),
          activeToken: { accessToken: obsolete, expiresAt: '2100-01-01T00:00:00Z' },
        }),
      );
      await rejection;
      expect(oxy.http.getSessionEpoch()).toBe(epoch + 1);
      expect(oxy.session.accessToken).toBe(d2);
      expect(client.getState()?.revision).toBe(1);
    } finally {
      oxy.dispose();
    }
  });

  it('keeps the same-device token rotation and cached result', async () => {
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    globalThis.fetch = jest.fn().mockResolvedValue(response({ viewer: 'alice' })) as typeof fetch;
    http.setTokens(token('d1', 'a'));
    const epoch = http.getSessionEpoch();
    expect(await http.get('/private')).toEqual({ viewer: 'alice' });
    http.setTokens(token('d1', 'b'));
    expect(http.getSessionEpoch()).toBe(epoch);
    expect(await http.get('/private')).toEqual({ viewer: 'alice' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 'd1'],
    ['d1', undefined],
    [undefined, undefined],
  ])(
    'preserves legacy bearer rotation from %s to %s when a device claim is unavailable',
    (before, after) => {
      const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
      http.setTokens(token(before, 'a'));
      const epoch = http.getSessionEpoch();
      http.setTokens(token(after, 'b'));
      expect(http.getSessionEpoch()).toBe(epoch);
    },
  );

  it('remembers a known device through a legacy rotation before a migration', async () => {
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(response('d1'))
      .mockResolvedValueOnce(response('d2')) as typeof fetch;
    http.setTokens(token('d1', 'a'));
    const epoch = http.getSessionEpoch();
    expect(await http.get('/private')).toBe('d1');
    http.setTokens(token(undefined, 'b'));
    expect(http.getSessionEpoch()).toBe(epoch);
    http.setTokens(token('d2', 'c'));
    expect(http.getSessionEpoch()).toBe(epoch + 1);
    expect(await http.get('/private')).toBe('d2');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, '', 42, { id: 'd1' }])(
    'treats malformed or empty deviceId %j as unknown without forgetting a known device',
    (malformed) => {
      const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
      http.setTokens(token('d1', 'first'));
      const epoch = http.getSessionEpoch();
      http.setTokens(token(malformed, 'unknown'));
      expect(http.getSessionEpoch()).toBe(epoch);
      http.setTokens(token('d2', 'migrated'));
      expect(http.getSessionEpoch()).toBe(epoch + 1);
    },
  );

  it.each([null, '', 42, { id: 'd1' }])(
    'does not infer a prior device from malformed or empty deviceId %j',
    (malformed) => {
      const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
      http.setTokens(token(malformed, 'unknown'));
      const epoch = http.getSessionEpoch();
      http.setTokens(token('d2', 'known'));
      expect(http.getSessionEpoch()).toBe(epoch);
    },
  );

  it('rechecks the epoch after a silent provider migration before reading the old response', async () => {
    let deliver!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = jest.fn(async () => {
      markStarted();
      return waiting;
    }) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    let provided = token('d1', 'first');
    http.setAccessTokenProvider(() => provided);
    http.setTokens(provided);
    provided = token(undefined, 'legacy');
    const pending = http.get('/private', { cache: false });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    provided = token('d2', 'migrated');
    const oldResponse = response({ viewer: 'old-device' });
    const parse = jest.spyOn(oldResponse, 'json');
    deliver(oldResponse);
    await rejection;
    expect(parse).not.toHaveBeenCalled();
    expect(http.getAccessToken()).toBe(provided);
  });

  it('does not refresh or retry an old 401 after a silent provider migration', async () => {
    let deliver!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = jest.fn(async () => {
      markStarted();
      return waiting;
    }) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    let provided = token('d1', 'first');
    http.setAccessTokenProvider(() => provided);
    http.setTokens(provided);
    provided = token(undefined, 'legacy');
    const refresh = jest.fn(async () => null);
    http.setAuthRefreshHandler(refresh);
    const pending = http.get('/private', { retry: false });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    provided = token('d2', 'migrated');
    deliver(new Response('{}', { status: 401 }));
    await rejection;
    expect(refresh).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(http.getAccessToken()).toBe(provided);
  });

  it('rejects a raw response after a silent provider migration', async () => {
    let deliver!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = jest.fn(async () => {
      markStarted();
      return waiting;
    }) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    let provided = token('d1', 'first');
    http.setAccessTokenProvider(() => provided);
    http.setTokens(provided);
    provided = token(undefined, 'legacy');
    const pending = http.requestAuthenticatedResponse({ method: 'GET', url: '/private' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    provided = token('d2', 'migrated');
    deliver(response({ viewer: 'old-device' }));
    await rejection;
    expect(http.getAccessToken()).toBe(provided);
  });

  it('rejects a handshake before returning an old token after a silent provider migration', async () => {
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    let provided = token('d1', 'first');
    http.setAccessTokenProvider(() => provided);
    http.setTokens(provided);
    provided = token(undefined, 'legacy');
    const pending = http.getAuthenticatedAccessToken('wss://oxy.example/socket');
    provided = token('d2', 'migrated');
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    expect(http.getAccessToken()).toBe(provided);
  });

  it('forgets the old device when a 401 clears the token directly', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 })) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    http.setTokens(token('d1', 'a'));
    await expect(http.get('/private', { retry: false })).rejects.toMatchObject({ status: 401 });
    expect(http.getAccessToken()).toBeNull();
    http.setTokens(token(undefined, 'legacy'));
    const epoch = http.getSessionEpoch();
    http.setTokens(token('d2', 'fresh'));
    expect(http.getSessionEpoch()).toBe(epoch);
  });

  it('forgets the old device when the session changes or tokens are cleared', () => {
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    const otherSession = (jti: string, deviceId?: string) =>
      `h.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId: 'session-b', jti, exp: 4102444800, ...(deviceId ? { deviceId } : {}) })).toString('base64url')}.s`;
    http.setTokens(token('d1', 'a'));
    http.setTokens(otherSession('a'));
    const epoch = http.getSessionEpoch();
    http.setTokens(otherSession('b', 'd2'));
    expect(http.getSessionEpoch()).toBe(epoch);
    http.setTokens(token('d1', 'b'));
    http.clearTokens();
    http.setTokens(token('d2', 'c'));
    const afterClear = http.getSessionEpoch();
    http.setTokens(token('d2', 'd'));
    expect(http.getSessionEpoch()).toBe(afterClear);
  });

  it('does not carry the previous user’s device into a new legacy session', () => {
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    const bob = (jti: string, deviceId?: string) =>
      `h.${Buffer.from(JSON.stringify({ userId: 'bob', sessionId: 'session-b', jti, exp: 4102444800, ...(deviceId ? { deviceId } : {}) })).toString('base64url')}.s`;
    http.setTokens(token('d1', 'a'));
    http.setTokens(bob('a'));
    const epoch = http.getSessionEpoch();
    http.setTokens(bob('b', 'd2'));
    expect(http.getSessionEpoch()).toBe(epoch);
  });

  it('allows an in-flight request to finish after a same-device token rotation', async () => {
    let deliver!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = jest.fn(async () => {
      markStarted();
      return waiting;
    }) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    http.setTokens(token('d1', 'a'));
    const epoch = http.getSessionEpoch();
    const pending = http.get('/private');
    await started;
    http.setTokens(token('d1', 'b'));
    deliver(response({ viewer: 'alice' }));
    await expect(pending).resolves.toEqual({ viewer: 'alice' });
    expect(http.getSessionEpoch()).toBe(epoch);
  });

  it('uses a newer same-device bearer when an older 401 refresh completes', async () => {
    let finishRefresh!: (value: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(response('ok')) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    http.setTokens(token('d1', 'a'));
    http.setAuthRefreshHandler(() => {
      markStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const pending = http.get('/private', { retry: false });
    await started;
    const newer = token('d1', 'newer');
    http.setTokens(newer);
    finishRefresh(token('d1', 'older'));
    await expect(pending).resolves.toBe('ok');
    expect(http.getAccessToken()).toBe(newer);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let an older 401 refresh overwrite a migrated device', async () => {
    let finishRefresh!: (value: string | null) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 })) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    http.setTokens(token('d1', 'a'));
    http.setAuthRefreshHandler(() => {
      markStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const pending = http.get('/private', { retry: false });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await started;
    const migrated = token('d2', 'newer');
    http.setTokens(migrated);
    finishRefresh(token('d1', 'older'));
    await rejection;
    expect(http.getAccessToken()).toBe(migrated);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('adopts a migrated bearer returned by refresh and lets a new request proceed', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(response('ok')) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    const migrated = token('d2', 'new');
    http.setTokens(token('d1', 'old'));
    http.setAuthRefreshHandler(async () => migrated);
    await expect(http.get('/private', { retry: false })).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    expect(http.getAccessToken()).toBe(migrated);
    await expect(http.get('/private', { retry: false })).resolves.toBe('ok');
  });
});
