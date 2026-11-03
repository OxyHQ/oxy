import { OxyServices } from '../OxyServices';

function bearer(user: string, nonce: number, extra: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: user,
      sub: user,
      sessionId: `s${user}`,
      deviceId: 'dev',
      device_context_id: `c${user}`,
      nonce,
      exp: 4102444800,
      ...extra,
    }),
  ).toString('base64url');
  return `h.${payload}.s`;
}
function evidenceBody(user: string, patch: Record<string, unknown> = {}) {
  return {
    data: {
      version: 1,
      deviceId: 'dev',
      deviceSessionId: 'ds',
      revision: 3,
      contextId: `c${user}`,
      actorId: user,
      accountId: user,
      sessionId: `s${user}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...patch,
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const originalFetch = globalThis.fetch;
let oxy: OxyServices;
beforeEach(() => {
  oxy = new OxyServices({ baseURL: 'https://example.invalid', enableRetry: false });
  oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'dev', deviceSecret: 'secret' }));
  globalThis.fetch = jest.fn(async () => json(evidenceBody('A')));
});
afterEach(() => {
  oxy.dispose();
  globalThis.fetch = originalFetch;
});

it('binds the server observation to the installed generation and shares one request', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const [first, second] = await Promise.all([
    oxy.session.observeHolderEvidence(),
    oxy.session.observeHolderEvidence(),
  ]);
  expect(first).toBe(second);
  expect(first.status).toBe('ok');
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  if (first.status !== 'ok') throw new Error('unreachable');
  expect(first.evidence.identity).toMatchObject({ accountId: 'A', actorId: 'A', contextId: 'cA' });
  expect(oxy.session.isHolderEvidenceCurrent(first.evidence)).toBe(true);
  expect(JSON.stringify(first.evidence)).not.toContain('secret');
  // Any new installation, even of the same bytes, retires the evidence.
  oxy.session.setAccessToken(bearer('A', 1));
  expect(oxy.session.isHolderEvidenceCurrent(first.evidence)).toBe(false);
});

it.each(['same-bytes', 'refresh', 'aba', 'logout-login'] as const)(
  'does not honor an answer when the bearer changed in flight (%s)',
  async (change) => {
    const a = bearer('A', 1);
    oxy.session.setAccessToken(a);
    const response = deferred<Response>();
    const started = deferred<void>();
    globalThis.fetch = jest.fn(async () => {
      started.resolve();
      return response.promise;
    });
    const pending = oxy.session.observeHolderEvidence();
    await started.promise;
    if (change === 'same-bytes') oxy.session.setAccessToken(a);
    if (change === 'refresh') oxy.session.setAccessToken(bearer('A', 2));
    if (change === 'aba') {
      oxy.session.setAccessToken(bearer('B', 1));
      oxy.session.setAccessToken(a);
    }
    if (change === 'logout-login') {
      oxy.session.clear();
      oxy.session.setAccessToken(a);
    }
    response.resolve(json(evidenceBody('A')));
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'changed' });
  },
);

it.each([
  ['another account', { accountId: 'B' }],
  ['another session', { sessionId: 'sB' }],
  ['another context', { contextId: 'cB' }],
  ['another actor', { actorId: 'B' }],
  ['another device', { deviceId: 'other' }],
])('refuses evidence naming %s than the bearer', async (_label, patch) => {
  oxy.session.setAccessToken(bearer('A', 1, { act: { sub: 'A' } }));
  globalThis.fetch = jest.fn(async () => json(evidenceBody('A', patch)));
  await expect(oxy.session.observeHolderEvidence()).resolves.toEqual({
    status: 'unavailable',
    reason: 'binding_unavailable',
  });
});

it.each([
  [403, 'unsupported'],
  [409, 'binding_unavailable'],
  [429, 'unavailable'],
  [503, 'unavailable'],
  [401, 'unavailable'],
  [404, 'unavailable'],
] as const)(
  'maps HTTP %s to %s without refreshing or clearing the session',
  async (status, reason) => {
    oxy.session.setAccessToken(bearer('A', 1));
    const refresh = jest.fn(async () => bearer('A', 2));
    oxy.http.setAuthRefreshHandler(refresh);
    globalThis.fetch = jest.fn(async () => json({ error: 'x' }, status));
    await expect(oxy.session.observeHolderEvidence()).resolves.toEqual({
      status: 'unavailable',
      reason,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(oxy.session.isAuthenticated).toBe(true);
  },
);

it('is unavailable without a bearer, a holder credential, or a valid answer shape', async () => {
  await expect(oxy.session.observeHolderEvidence()).resolves.toEqual({
    status: 'unavailable',
    reason: 'no_credential',
  });
  oxy.session.setAccessToken(bearer('A', 1));
  oxy.session.setDeviceCredentialProvider(null);
  await expect(oxy.session.observeHolderEvidence()).resolves.toEqual({
    status: 'unavailable',
    reason: 'no_holder',
  });
  oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'dev', deviceSecret: 'secret' }));
  oxy.session.setAccessToken(bearer('A', 2));
  globalThis.fetch = jest.fn(async () => json({ data: { version: 2 } }));
  await expect(oxy.session.observeHolderEvidence()).resolves.toEqual({
    status: 'unavailable',
    reason: 'unavailable',
  });
});

it('remembers a refusal briefly per installation instead of hammering the endpoint', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  globalThis.fetch = jest.fn(async () => json({ error: 'evidence_unavailable' }, 503));
  await oxy.session.observeHolderEvidence();
  await oxy.session.observeHolderEvidence();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  oxy.session.setAccessToken(bearer('A', 2));
  await oxy.session.observeHolderEvidence();
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
