import { OxyServices } from '../../OxyServices';

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
}

describe('oxy.session', () => {
  const originalFetch = globalThis.fetch;
  let oxy: OxyServices;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reads userId and accessTokenExpiry from the token, and follows a new token', () => {
    expect(oxy.session.userId).toBeNull();
    expect(oxy.session.accessTokenExpiry).toBeNull();
    expect(oxy.session.isAuthenticated).toBe(false);

    oxy.session.setAccessToken(jwt({ userId: 'u1', exp: 2_000_000_000 }));
    expect(oxy.session.userId).toBe('u1');
    expect(oxy.session.accessTokenExpiry).toBe(2_000_000_000);
    expect(oxy.session.isAuthenticated).toBe(true);

    oxy.session.setAccessToken(jwt({ id: 'u2', exp: 2_000_000_100 }));
    expect(oxy.session.userId).toBe('u2');
    expect(oxy.session.accessTokenExpiry).toBe(2_000_000_100);

    oxy.session.clear();
    expect(oxy.session.userId).toBeNull();
    expect(oxy.session.accessToken).toBeNull();
  });

  it('treats an opaque token as authenticated but with no user id or expiry', () => {
    oxy.session.setAccessToken('opaque-token');
    expect(oxy.session.isAuthenticated).toBe(true);
    expect(oxy.session.userId).toBeNull();
    expect(oxy.session.accessTokenExpiry).toBeNull();
  });

  it('waitForAuth resolves as soon as a token is planted, without polling', async () => {
    jest.useFakeTimers();
    const waiting = oxy.session.waitForAuth(5000);
    oxy.session.setAccessToken(jwt({ userId: 'u1' }));
    await expect(waiting).resolves.toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waitForAuth resolves false after the timeout', async () => {
    jest.useFakeTimers();
    const waiting = oxy.session.waitForAuth(1000);
    jest.advanceTimersByTime(1000);
    await expect(waiting).resolves.toBe(false);
  });

  it('waitForAuth resolves immediately when already signed in', async () => {
    oxy.session.setAccessToken(jwt({ userId: 'u1' }));
    await expect(oxy.session.waitForAuth(1)).resolves.toBe(true);
  });

  it('reads the device proof from the installed provider, and never throws', async () => {
    expect(await oxy.session.readDeviceProof()).toBeNull();

    const dispose = oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'd1', deviceSecret: 's1' }));
    expect(await oxy.session.readDeviceProof()).toEqual({ deviceId: 'd1', deviceSecret: 's1' });

    oxy.session.setDeviceCredentialProvider(async () => {
      throw new Error('store locked');
    });
    expect(await oxy.session.readDeviceProof()).toBeNull();

    oxy.session.setDeviceCredentialProvider(() => ({ deviceId: '', deviceSecret: 's' }));
    expect(await oxy.session.readDeviceProof()).toBeNull();

    // A stale disposer does not clear a newer provider.
    dispose();
    oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'd2', deviceSecret: 's2' }));
    dispose();
    expect(await oxy.session.readDeviceProof()).toEqual({ deviceId: 'd2', deviceSecret: 's2' });
  });

  it('validate drops the cached session user when the session is invalid', async () => {
    const remove = jest.spyOn(oxy.cache, 'delete');
    globalThis.fetch = jest.fn(async () => jsonResponse(null, 401)) as unknown as typeof fetch;

    await expect(oxy.session.validate('sess-1')).rejects.toMatchObject({ status: 401 });
    expect(remove).toHaveBeenCalledWith('GET:/session/user/sess-1');
  });

  it('validateToken is false without a token and never throws', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ valid: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await oxy.session.validateToken()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    oxy.session.setAccessToken(jwt({ userId: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }));
    expect(await oxy.session.validateToken()).toBe(true);

    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await oxy.session.validateToken()).toBe(false);
  });
});
