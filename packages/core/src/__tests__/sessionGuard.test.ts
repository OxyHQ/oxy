import { HttpService } from '../HttpService';

function token(userId: string, jti: string, sessionId = userId) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ userId, sessionId, jti })}.signature`;
}

describe('captureSessionGuard', () => {
  it('invalidates work on an account switch or sign-out, including A to B to A', () => {
    const http = new HttpService({ baseURL: 'https://example.test' });
    http.setTokens(token('alice', '1'));
    const alice = http.captureSessionGuard();
    http.setTokens(token('bob', '1'));
    expect(alice()).toBe(false);
    http.setTokens(token('alice', '2'));
    expect(alice()).toBe(false);
    const nextAlice = http.captureSessionGuard();
    http.endSession();
    expect(nextAlice()).toBe(false);
  });

  it('invalidates guest work on sign-in and keeps same-session refresh work valid', () => {
    const http = new HttpService({ baseURL: 'https://example.test' });
    const guest = http.captureSessionGuard();
    http.setTokens(token('alice', '1'));
    expect(guest()).toBe(false);
    const alice = http.captureSessionGuard();
    http.setTokens(token('alice', '2'));
    expect(alice()).toBe(true);
  });

  it('never allows work after the bearer disappears and returns', () => {
    const http = new HttpService({ baseURL: 'https://example.test' });
    http.setTokens(token('alice', '1'));
    const alice = http.captureSessionGuard();
    http.clearTokens();
    http.setTokens(token('alice', '2'));
    expect(alice()).toBe(false);
  });

  it('invalidates a replaced session for the same account', () => {
    const http = new HttpService({ baseURL: 'https://example.test' });
    http.setTokens(token('alice', '1', 'device-session-a'));
    const oldSession = http.captureSessionGuard();
    http.setTokens(token('alice', '2', 'device-session-b'));
    expect(oldSession()).toBe(false);
  });

  it('invalidates a guard when a 401 clears the bearer before another sign-in', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response('{}', { status: 401 }));
    try {
      const http = new HttpService({ baseURL: 'https://example.test', enableRetry: false });
      http.setTokens(token('alice', '1'));
      const alice = http.captureSessionGuard();
      await expect(http.get('/private', { retry: false })).rejects.toBeDefined();
      expect(http.getAccessToken()).toBeNull();
      http.setTokens(token('bob', '1'));
      expect(alice()).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
