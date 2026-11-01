import { OxyServices } from '../OxyServices';

function bearer(user: string, nonce: number, exp = 4102444800): string {
  const payload = Buffer.from(
    JSON.stringify({ userId: user, sub: user, sessionId: `s${user}`, nonce, exp }),
  ).toString('base64url');
  return `h.${payload}.s`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const ok = () =>
  new Response(JSON.stringify({ data: { ok: true } }), {
    headers: { 'content-type': 'application/json' },
  });
function captureRevision(services: OxyServices) {
  const revision = services.http.captureCredentialRevision();
  if (!revision) throw new Error('Expected an installed credential');
  return revision;
}
const originalFetch = globalThis.fetch;
let oxy: OxyServices;
let linked: ReturnType<OxyServices['createLinkedClient']>;
beforeEach(() => {
  oxy = new OxyServices({ baseURL: 'https://example.invalid', enableRetry: false });
  linked = oxy.createLinkedClient({
    baseURL: 'https://example.invalid',
    enableRetry: false,
    maxConcurrentRequests: 1,
  });
  globalThis.fetch = jest.fn(async () => ok());
});
afterEach(() => {
  linked.dispose();
  oxy.dispose();
  globalThis.fetch = originalFetch;
});

it('dispatches the current selected bearer for an unchanged revision', async () => {
  const a = bearer('A', 1);
  oxy.session.setAccessToken(a);
  const revision = captureRevision(oxy);
  await expect(
    linked.client.patch('/action', {}, { expectedCredentialRevision: revision }),
  ).resolves.toEqual({ ok: true });
  const headers = new Headers((globalThis.fetch as jest.Mock).mock.calls[0][1].headers);
  expect(headers.get('authorization')).toBe(`Bearer ${a}`);
  expect(oxy.http.isCredentialRevisionCurrent(revision)).toBe(true);
});

it.each(['same-bytes', 'same-session-refresh', 'aba', 'logout-login'] as const)(
  'rejects old revision before dispatch after %s',
  async (change) => {
    const a = bearer('A', 1);
    oxy.session.setAccessToken(a);
    const revision = captureRevision(oxy);
    if (change === 'same-bytes') oxy.session.setAccessToken(a);
    if (change === 'same-session-refresh') oxy.session.setAccessToken(bearer('A', 2));
    if (change === 'aba') {
      oxy.session.setAccessToken(bearer('B', 1));
      oxy.session.setAccessToken(a);
    }
    if (change === 'logout-login') {
      oxy.session.clear();
      oxy.session.setAccessToken(a);
    }
    await expect(
      linked.client.patch('/action', {}, { expectedCredentialRevision: revision }),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(oxy.http.isCredentialRevisionCurrent(revision)).toBe(false);
  },
);

it('rejects after a preflight refresh, before sending the new bearer', async () => {
  oxy.session.setAccessToken(bearer('A', 1, Math.floor(Date.now() / 1000) + 10));
  const revision = captureRevision(oxy);
  const refresh = deferred<string>();
  const started = deferred<void>();
  oxy.http.setAuthRefreshHandler(async () => {
    started.resolve();
    return refresh.promise;
  });
  const pending = linked.client.patch('/action', {}, { expectedCredentialRevision: revision });
  await started.promise;
  refresh.resolve(bearer('A', 2));
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('rechecks a write after it waits behind the network queue', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const revision = captureRevision(oxy);
  const response = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = jest.fn(async () => {
    started.resolve();
    return response.promise;
  });
  const first = linked.client.patch('/first');
  await started.promise;
  const second = linked.client.patch('/second', {}, { expectedCredentialRevision: revision });
  oxy.session.setAccessToken(bearer('A', 2));
  response.resolve(ok());
  await first;
  await expect(second).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it.each([200, 500])(
  'rejects a retained HTTP %s after a new credential revision',
  async (status) => {
    oxy.session.setAccessToken(bearer('A', 1));
    const revision = captureRevision(oxy);
    const response = deferred<Response>();
    const started = deferred<void>();
    globalThis.fetch = jest.fn(async () => {
      started.resolve();
      return response.promise;
    });
    const pending = linked.client.patch('/action', {}, { expectedCredentialRevision: revision });
    await started.promise;
    oxy.session.setAccessToken(bearer('A', 2));
    response.resolve(
      new Response(JSON.stringify({ data: {} }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  },
);

it.each([200, 500])('rejects after an ABA while reading the body of HTTP %s', async (status) => {
  const a = bearer('A', 1);
  oxy.session.setAccessToken(a);
  const revision = captureRevision(oxy);
  const body = deferred<unknown>();
  const started = deferred<void>();
  const response = new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  response.json = async () => {
    started.resolve();
    return body.promise;
  };
  globalThis.fetch = jest.fn(async () => response);
  const pending = linked.client.patch('/action', {}, { expectedCredentialRevision: revision });
  await started.promise;
  oxy.session.setAccessToken(bearer('B', 1));
  oxy.session.setAccessToken(a);
  body.resolve({ data: { ok: true } });
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
});

it('refuses explicit authorization, reads and revisions from another source', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const revision = captureRevision(oxy);
  await expect(
    linked.client.patch(
      '/action',
      {},
      { expectedCredentialRevision: revision, headers: { Authorization: 'Bearer forged' } },
    ),
  ).rejects.toThrow();
  await expect(oxy.http.get('/action', { expectedCredentialRevision: revision })).rejects.toThrow();
  const other = new OxyServices({ baseURL: 'https://example.invalid' });
  other.session.setAccessToken(bearer('A', 1));
  try {
    await expect(
      linked.client.patch('/action', {}, { expectedCredentialRevision: captureRevision(other) }),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  } finally {
    other.dispose();
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('holds a synthetic evidence response to the exact revision across ABA', async () => {
  const a = bearer('A', 1);
  oxy.session.setAccessToken(a);
  const revision = captureRevision(oxy);
  const response = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = jest.fn(async () => {
    started.resolve();
    return response.promise;
  });
  // This is a simulated response, not a call to the experimental endpoint.
  const pending = oxy.http.post(
    '/session/device/context-evidence-v1',
    { deviceId: 'fixture', deviceSecret: 'fixture' },
    { expectedCredentialRevision: revision },
  );
  await started.promise;
  oxy.session.setAccessToken(bearer('B', 1));
  oxy.session.setAccessToken(a);
  response.resolve(ok());
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(oxy.http.isCredentialRevisionCurrent(revision)).toBe(false);
});

it('does not refresh or clear credentials for a guarded 401 evidence response', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const revision = captureRevision(oxy);
  const refresh = jest.fn(async () => bearer('A', 2));
  oxy.http.setAuthRefreshHandler(refresh);
  globalThis.fetch = jest.fn(
    async () =>
      new Response(JSON.stringify({ error: 'invalid_bearer' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await expect(
    oxy.http.post(
      '/session/device/context-evidence-v1',
      { deviceId: 'fixture', deviceSecret: 'fixture' },
      { expectedCredentialRevision: revision },
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(refresh).not.toHaveBeenCalled();
  expect(oxy.http.isCredentialRevisionCurrent(revision)).toBe(true);
});

it('rejects when linked preflight selects a bearer different from its source', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const revision = captureRevision(oxy);
  linked.client.setAccessTokenProvider(() => bearer('A', 2));
  await expect(
    linked.client.patch('/action', {}, { expectedCredentialRevision: revision }),
  ).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('does not issue revisions from pull-only sources where ABA is unobservable', async () => {
  oxy.session.setAccessToken(bearer('A', 1));
  const old = captureRevision(oxy);
  oxy.http.setAccessTokenProvider(() => bearer('A', 1));
  expect(oxy.http.captureCredentialRevision()).toBeNull();
  expect(oxy.http.isCredentialRevisionCurrent(old)).toBe(false);
  await expect(
    linked.client.patch('/action', {}, { expectedCredentialRevision: old }),
  ).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('preserves ordinary linked request behavior without an opt-in revision', async () => {
  oxy.session.setAccessToken(bearer('A', 1, Math.floor(Date.now() / 1000) + 10));
  oxy.http.setAuthRefreshHandler(async () => bearer('A', 2));
  await expect(linked.client.patch('/action')).resolves.toEqual({ ok: true });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it('permits a new revision after restore or refresh instead of leaving a session inert', async () => {
  expect(oxy.http.captureCredentialRevision()).toBeNull();
  oxy.session.setAccessToken(bearer('A', 1));
  const before = captureRevision(oxy);
  oxy.session.setAccessToken(bearer('A', 2));
  const after = captureRevision(oxy);
  expect(oxy.http.isCredentialRevisionCurrent(before)).toBe(false);
  await expect(
    linked.client.patch('/action', {}, { expectedCredentialRevision: after }),
  ).resolves.toEqual({ ok: true });
});

it('rejects if a reentrant source listener replaces the credential before evidence can be used', async () => {
  const a = bearer('A', 1);
  oxy.session.setAccessToken(a);
  const revision = captureRevision(oxy);
  const unsubscribe = oxy.http.addTokenChangeListener(() => {
    unsubscribe();
    oxy.session.setAccessToken(a);
  });
  oxy.session.setAccessToken(bearer('B', 1));
  expect(oxy.http.isCredentialRevisionCurrent(revision)).toBe(false);
  await expect(
    linked.client.patch('/action', {}, { expectedCredentialRevision: revision }),
  ).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
