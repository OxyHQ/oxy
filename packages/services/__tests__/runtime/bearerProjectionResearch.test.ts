import { OxyServices } from '@oxy.so/core';
import { SessionClient } from '../../../core/src/session/SessionClient';
import { createSessionClientHost } from '../../../core/src/session/sessionClientHost';
import { createOxyRuntime } from '../../src/ui/runtime';

/** Unsigned test fixture. Decoded claims are never server authorization. */
const token = (actor: string) =>
  `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: `s-${actor}`, act: { sub: actor }, exp: 4102444800 })).toString('base64url')}.s`;
const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify({ userId: 'org', exp: 4102444800, ...claims })).toString('base64url')}.s`;

const state = {
  deviceId: 'd1',
  revision: 1,
  updatedAt: 1720000000000,
  activeAccountId: 'org',
  accounts: ['alice', 'nate'].map((actor, authuser) => ({
    accountId: 'org',
    sessionId: `s-${actor}`,
    authuser,
    operatedByUserId: actor,
  })),
};

const directory = {
  deviceId: 'd1',
  revision: 1,
  updatedAt: 1720000000000,
  activeContextId: 'ctx-alice',
  principals: ['alice', 'nate'].map((actor, authuser) => ({
    id: `p-${actor}`,
    userId: actor,
    authuser,
    user: { id: actor, username: actor },
    contexts: [
      {
        id: `ctx-${actor}`,
        accountId: 'org',
        kind: 'organization',
        relationship: 'member',
        account: { id: 'org', username: 'org' },
        onDevice: true,
        available: true,
        active: actor === 'alice',
        lastUsedAt: null,
      },
    ],
  })),
};

it('reproduces a different projected session from the actual bearer for one subject', async () => {
  const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
  oxy.session.setAccessToken(token('nate'));
  jest.spyOn(oxy.users, 'getMany').mockResolvedValue([{ id: 'org', username: 'org' }] as never);
  const host = createSessionClientHost(oxy);
  const client = new SessionClient(host);
  const originalFetch = globalThis.fetch;
  let observed: { path: string; auth: string | undefined } | null = null;
  globalThis.fetch = jest.fn(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    observed = { path, auth };
    return {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => 'application/json' },
      json: async () => ({ code: 'ACTING_SESSION_MISMATCH', message: 'Acting session mismatch' }),
    } as Response;
  });
  const runtime = createOxyRuntime({
    oxyServices: oxy,
    sessionClient: client,
    sessionClientHost: host,
    identity: null,
    onDeviceEmpty: async () => {},
    logger: () => {},
  });
  try {
    client.adoptState(state);
    await runtime.reconcileFromClient();
    expect(oxy.session.accessToken).toBe(token('nate'));
    expect(runtime.getSnapshot().activeSessionId).toBe('s-alice');
    const projected = runtime.getSnapshot().activeSessionId;
    if (!projected) throw new Error('Expected a projected session');
    await expect(oxy.session.list(projected)).rejects.toMatchObject({
      code: 'ACTING_SESSION_MISMATCH',
    });
    expect(observed).toEqual({
      path: '/session/sessions/s-alice',
      auth: `Bearer ${token('nate')}`,
    });
  } finally {
    globalThis.fetch = originalFetch;
    client.stop();
    oxy.http.dispose();
  }
});

it('reproduces synchronous token-listener reentry before the real directory snapshot moves', async () => {
  const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
  oxy.session.setAccessToken(token('alice'));
  jest.spyOn(oxy.users, 'getMany').mockResolvedValue([{ id: 'org', username: 'org' }] as never);
  const host = createSessionClientHost(oxy);
  host.makeRequest = async () => directory as never;
  const client = new SessionClient(host);
  const runtime = createOxyRuntime({
    oxyServices: oxy,
    sessionClient: client,
    sessionClientHost: host,
    identity: null,
    onDeviceEmpty: async () => {},
    logger: () => {},
  });
  try {
    client.adoptState(state);
    await client.refreshDirectory();
    await runtime.reconcileFromClient();
    expect(runtime.getSnapshot().activeContext?.actor.userId).toBe('alice');
    const seen: Array<{ actor?: string; active: string | null; token: string | null }> = [];
    const dispose = oxy.session.onChange(() =>
      seen.push({
        actor: runtime.getSnapshot().activeContext?.actor.userId,
        active: runtime.getSnapshot().activeSessionId,
        token: oxy.session.accessToken,
      }),
    );
    oxy.session.setAccessToken(token('nate'));
    oxy.session.setAccessToken(token('alice'));
    dispose();
    expect(seen).toEqual([
      { actor: 'alice', active: 's-alice', token: token('nate') },
      { actor: 'alice', active: 's-alice', token: token('alice') },
    ]);
  } finally {
    client.stop();
    oxy.http.dispose();
  }
});

it('lets a pending same-revision projection commit after bearer ABA', async () => {
  const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
  oxy.session.setAccessToken(token('alice'));
  let release!: (value: never) => void;
  jest.spyOn(oxy.users, 'getMany').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const host = createSessionClientHost(oxy);
  const client = new SessionClient(host);
  const runtime = createOxyRuntime({
    oxyServices: oxy,
    sessionClient: client,
    sessionClientHost: host,
    identity: null,
    onDeviceEmpty: async () => {},
    logger: () => {},
  });
  try {
    client.adoptState(state);
    const epoch = oxy.http.getSessionEpoch();
    const pending = runtime.reconcileFromClient();
    oxy.session.setAccessToken(token('nate'));
    oxy.session.setAccessToken(token('alice'));
    expect(oxy.http.getSessionEpoch()).toBeGreaterThan(epoch);
    release([{ id: 'org', username: 'pre-aba-response' }] as never);
    await pending;
    expect(runtime.getSnapshot().activeSessionId).toBe('s-alice');
    expect(runtime.getSnapshot().account?.username).toBe('pre-aba-response');
  } finally {
    client.stop();
    oxy.http.dispose();
  }
});

it.each([
  ['opaque', 'opaque-token', false],
  ['legacy without sessionId', jwt({ act: { sub: 'nate' } }), true],
  ['malformed sessionId', jwt({ sessionId: { invalid: true } }), true],
  ['empty sessionId', jwt({ sessionId: '' }), true],
])(
  'observes %s token behavior through real projection and transport',
  async (_label, bearer, sendsBearer) => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    oxy.session.setAccessToken(bearer);
    jest.spyOn(oxy.users, 'getMany').mockResolvedValue([{ id: 'org', username: 'org' }] as never);
    const host = createSessionClientHost(oxy);
    const client = new SessionClient(host);
    const runtime = createOxyRuntime({
      oxyServices: oxy,
      sessionClient: client,
      sessionClientHost: host,
      identity: null,
      onDeviceEmpty: async () => {},
      logger: () => {},
    });
    const previousFetch = globalThis.fetch;
    let auth: string | undefined;
    globalThis.fetch = jest.fn(async (_input, init) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => [],
      } as Response;
    });
    try {
      client.adoptState(state);
      await runtime.reconcileFromClient();
      expect(runtime.getSnapshot().activeSessionId).toBe('s-alice');
      await oxy.session.list('s-alice');
      expect(auth).toBe(sendsBearer ? `Bearer ${bearer}` : undefined);
    } finally {
      globalThis.fetch = previousFetch;
      client.stop();
      oxy.http.dispose();
    }
  },
);

it('fences an actor ABA with same-subject legacy claims in real HTTP', async () => {
  const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
  const alice = jwt({ act: { sub: 'alice' } });
  const nate = jwt({ act: { sub: 'nate' } });
  oxy.session.setAccessToken(alice);
  const epoch = oxy.http.getSessionEpoch();
  const previousFetch = globalThis.fetch;
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = jest.fn(async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ marker: 'old-response' }),
    } as Response;
  });
  try {
    const pending = oxy.request('GET', '/account-data', undefined, { cache: false, retry: false });
    await entered;
    oxy.session.setAccessToken(nate);
    oxy.session.setAccessToken(alice);
    expect(oxy.http.getSessionEpoch()).toBe(epoch + 2);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
  } finally {
    globalThis.fetch = previousFetch;
    oxy.http.dispose();
  }
});
