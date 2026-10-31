import { OxyServices } from '../../OxyServices';
import { ExperimentalContextBarrier } from '../experimentalContextBarrier';

function gate() {
  let generation = 0;
  let ready = true;
  return {
    close() {
      generation++;
      ready = false;
    },
    invalidate() {
      generation++;
      ready = false;
    },
    open() {
      ready = true;
    },
    lease() {
      if (!ready) throw new Error('Context binding unavailable');
      return generation;
    },
    isCurrent(lease: number) {
      return ready && lease === generation;
    },
  };
}

it('gates the real main and pre-existing linked HTTP clients, including cached reads', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(
    async () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid' });
  oxy.http.setTokens('opaque-token');
  const linked = oxy.createLinkedClient({ baseURL: 'https://app.invalid' });
  const barrier = gate();
  try {
    await oxy.http.get('/data');
    await oxy.http.get('/data');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(oxy.http.peekCachedGet('/data')).toEqual({ ok: true });
    oxy.experimentalSetContextGate(barrier);
    expect(oxy.http.peekCachedGet('/data')).toBeNull();
    await expect(oxy.http.refreshAccessToken('preflight')).rejects.toThrow(
      'Strict context refresh is unavailable',
    );
    await oxy.http.get('/data');
    await oxy.http.get('/data');
    expect(fetcher).toHaveBeenCalledTimes(3);
    barrier.close();
    await expect(oxy.http.get('/data')).rejects.toThrow('Context binding unavailable');
    await expect(linked.client.get('/data')).rejects.toThrow('Context binding unavailable');
    await expect(linked.getAccessToken('https://app.invalid/socket')).rejects.toThrow(
      'Context binding unavailable',
    );
    expect(oxy.http.getAccessToken()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    linked.dispose();
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('closes before an outside token mutation and does not publish it to listeners', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(
    async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid' });
  const barrier = gate();
  oxy.http.setTokens('opaque-token');
  oxy.experimentalSetContextGate(barrier);
  let entered = false;
  oxy.http.addTokenChangeListener(() => {
    entered = true;
    barrier.close();
  });
  try {
    oxy.http.setTokens('another-token');
    expect(entered).toBe(false);
    expect(barrier.isCurrent(0)).toBe(false);
    await expect(oxy.http.get('/data')).rejects.toThrow('Context binding unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('rechecks the lease after a synchronous request-body callback', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens('opaque-token');
  const barrier = gate();
  oxy.experimentalSetContextGate(barrier);
  try {
    await expect(
      oxy.http.post('/write', {
        toJSON: () => {
          barrier.close();
          return {};
        },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('refuses a queued owner lease after a switch and when a provider reenters before send', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens('opaque-token');
  const barrier = gate();
  oxy.experimentalSetContextGate(barrier);
  try {
    const aliceLease = barrier.lease();
    barrier.close();
    barrier.open();
    await expect(
      oxy.http.experimentalRequestForLease(
        { method: 'POST', url: '/write', data: {} },
        barrier,
        aliceLease,
      ),
    ).rejects.toThrow();
    const nextLease = barrier.lease();
    oxy.http.setAccessTokenProvider(() => {
      barrier.close();
      return 'opaque-token';
    });
    await expect(
      oxy.http.experimentalRequestForLease(
        { method: 'POST', url: '/write', data: {} },
        barrier,
        nextLease,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('rejects an in-flight response after the gate closes and reopens', async () => {
  const originalFetch = globalThis.fetch;
  let respond!: (response: Response) => void;
  const fetcher = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens('opaque-token');
  const barrier = gate();
  oxy.experimentalSetContextGate(barrier);
  try {
    const pending = oxy.http.get('/data');
    for (let i = 0; i < 20 && !fetcher.mock.calls.length; i++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    barrier.close();
    barrier.open();
    respond(
      new Response(JSON.stringify({ data: { old: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(pending).rejects.toThrow();
  } finally {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('rejects a mutation response sent before strict mode was installed', async () => {
  const originalFetch = globalThis.fetch;
  let respond!: (response: Response) => void;
  const fetcher = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens('opaque-token');
  const barrier = gate();
  try {
    const pending = oxy.http.post('/write', { value: 1 });
    for (let i = 0; i < 20 && !fetcher.mock.calls.length; i++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    barrier.close();
    oxy.experimentalSetContextGate(barrier);
    respond(
      new Response(JSON.stringify({ data: { written: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(pending).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('installs a staged bearer behind the real gate and releases a pre-existing linked client', async () => {
  const candidate = `h.${Buffer.from(JSON.stringify({ userId: 'person', sessionId: 'session', exp: 4102444800 })).toString('base64url')}.s`;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid' });
  oxy.http.setTokens('old');
  const linked = oxy.createLinkedClient({ baseURL: 'https://app.invalid' });
  const binding = {
    version: 1,
    deviceId: 'device',
    deviceSessionId: 'incarnation',
    revision: 1,
    contextId: 'context',
    actorId: 'person',
    accountId: 'person',
    sessionId: 'session',
    accessToken: candidate,
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const state = {
    deviceId: 'device',
    revision: 1,
    updatedAt: 1,
    activeAccountId: 'person',
    accounts: [{ accountId: 'person', sessionId: 'session', authuser: 0 }],
  };
  const directory = {
    deviceId: 'device',
    revision: 1,
    updatedAt: 1,
    activeContextId: 'context',
    principals: [
      {
        id: 'principal',
        userId: 'person',
        authuser: 0,
        user: { id: 'person', username: 'person' },
        contexts: [
          {
            id: 'context',
            accountId: 'person',
            kind: 'personal',
            relationship: 'self',
            account: { id: 'person', username: 'person' },
            onDevice: true,
            available: true,
            active: true,
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'device', deviceSecret: 'secret' }),
    getAccessToken: () => oxy.http.experimentalPeekAccessToken(),
    setAccessToken: (value) => oxy.http.experimentalInstallContextToken(value),
    mint: async () => binding,
    readState: async () => state,
    readDirectory: async () => directory,
  });
  oxy.experimentalSetContextGate(gate);
  let observed: string | null = 'not-called';
  oxy.http.addTokenChangeListener((token) => {
    observed = token;
  });
  try {
    expect(oxy.http.getAccessToken()).toBeNull();
    expect(await gate.reconcile()).toBe(true);
    expect(observed).toBe('not-called');
    oxy.http.experimentalContextReady();
    expect(observed).toBe(candidate);
    expect(await linked.getAccessToken('https://app.invalid/socket')).toBe(candidate);
    gate.invalidate();
    await expect(linked.getAccessToken('https://app.invalid/socket')).rejects.toThrow();
  } finally {
    linked.dispose();
    oxy.dispose();
  }
});
