import { HttpService } from '../../HttpService';

function token(userId: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ userId, exp: 4102444800 })}.signature`;
}

it('documents why a token and epoch snapshot cannot fence a later directory request', async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  try {
    const http = new HttpService({ baseURL: 'https://api.example.test', enableRetry: false });
    const alice = token('alice');
    const bob = token('bob');
    let provided = alice;
    http.setTokens(alice);
    http.setAccessTokenProvider(() => provided);
    const capturedEpoch = http.getSessionEpoch();
    const capturedToken = http.getAccessToken();

    // The provider changes while an earlier activation result is pending. A
    // controller checking only these public snapshots still thinks it owns A.
    provided = bob;
    expect(http.getSessionEpoch()).toBe(capturedEpoch);
    expect(http.getAccessToken()).toBe(capturedToken);

    // request() synchronizes the provider only after that check; the GET would
    // therefore run under B, whose own 401 may legitimately end B's session.
    await http.get('/session/device/directory', { cache: false });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${bob}`,
    );
    expect(http.getSessionEpoch()).not.toBe(capturedEpoch);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('shows an unfenced directory request may clear the replacement session on its own 401', async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  try {
    const http = new HttpService({ baseURL: 'https://api.example.test', enableRetry: false });
    const alice = token('alice');
    const bob = token('bob');
    let provided = alice;
    http.setTokens(alice);
    http.setAccessTokenProvider(() => provided);
    const epoch = http.getSessionEpoch();
    const bearer = http.getAccessToken();
    provided = bob;
    expect(http.getSessionEpoch()).toBe(epoch);
    expect(http.getAccessToken()).toBe(bearer);

    await expect(
      http.get('/session/device/directory', { cache: false, retry: false }),
    ).rejects.toMatchObject({ status: 401 });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${bob}`,
    );
    expect(http.getAccessToken()).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('cannot observe a provider A to B to A transition without a provider generation', () => {
  const http = new HttpService({ baseURL: 'https://api.example.test', enableRetry: false });
  const alice = token('alice');
  let provided = alice;
  http.setTokens(alice);
  http.setAccessTokenProvider(() => provided);
  const epoch = http.getSessionEpoch();
  const bearer = http.getAccessToken();
  provided = token('bob');
  expect(provided).not.toBe(bearer);
  provided = alice;
  expect(http.getSessionEpoch()).toBe(epoch);
  expect(http.getAccessToken()).toBe(bearer);
});

it('does not make epoch a universal same-user session-generation proof', () => {
  const http = new HttpService({ baseURL: 'https://api.example.test', enableRetry: false });
  const first = token('alice');
  const second = `${first}-different-signature`;
  http.setTokens(first);
  const epoch = http.getSessionEpoch();
  http.setTokens(second);
  expect(http.getAccessToken()).toBe(second);
  // Claims here include a user id but no session id; the transport accepts the
  // replacement as same-context. A caller cannot infer a session generation.
  expect(http.getSessionEpoch()).toBe(epoch);
});
