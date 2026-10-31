import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost, type SessionClientOptions } from '../SessionClient';
import { createSessionClientHost } from '../sessionClientHost';
import { OxyServices } from '../../OxyServices';

const state = (deviceId: string, revision: number): DeviceSessionState => ({
  deviceId,
  revision,
  updatedAt: 1720000000000,
  activeAccountId: 'org',
  accounts: [
    { accountId: 'org', sessionId: 'session-nate', authuser: 0, operatedByUserId: 'nate' },
    { accountId: 'org', sessionId: 'session-alice', authuser: 1, operatedByUserId: 'alice' },
  ],
});

const sync = (deviceId: string, revision: number, accessToken: string) => ({
  state: state(deviceId, revision),
  activeToken: { accessToken, expiresAt: '2030-01-01T00:00:00Z' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clientWith(
  request: jest.Mock,
  options?: SessionClientOptions,
  initialToken: string | null = 'nate',
) {
  let token = initialToken;
  const host: SessionClientHost = {
    makeRequest: request,
    getBaseURL: () => 'https://oxy.example',
    getAccessToken: () => token,
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: (value) => {
      token = value;
    },
    getCurrentAccountId: () => 'org',
  };
  return { client: new SessionClient(host, options), token: () => token };
}

function contextDirectory(actor: string, revision = 2) {
  return {
    deviceId: 'd1',
    revision,
    updatedAt: 1720000000000,
    activeContextId: `ctx-${actor}`,
    principals: [
      {
        id: `p-${actor}`,
        userId: actor,
        authuser: 0,
        user: { id: actor, username: actor },
        contexts: [
          {
            id: `ctx-${actor}`,
            accountId: 'org',
            kind: 'organization',
            relationship: 'owner',
            account: { id: 'org', username: 'org' },
            onDevice: true,
            available: true,
            active: true,
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

function actorToken(actor: string, context: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `h.${encode({ ver: 2, userId: 'org', sessionId: `session-${actor}`, act: { sub: actor }, device_context_id: context, exp: 4102444800 })}.s`;
}

describe('SessionClient bootstrap token ownership', () => {
  afterEach(() => jest.restoreAllMocks());
  it('does not plant an older revision for another actor of the same account', async () => {
    const delayed = deferred<unknown>();
    const request = jest
      .fn()
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(sync('d1', 2, 'alice'));
    const { client, token } = clientWith(request);
    client.adoptState(state('d1', 1));
    const old = client.bootstrap();
    client.adoptState(state('d1', 2));
    await client.bootstrap();
    expect(token()).toBe('alice');
    delayed.resolve(sync('d1', 1, 'nate'));
    await old;
    expect(client.getState()?.revision).toBe(2);
    expect(token()).toBe('alice');
  });

  it('plants a valid same-revision bearer after an earlier state-only push', async () => {
    const { client, token } = clientWith(jest.fn().mockResolvedValue(sync('d1', 2, 'alice')));
    client.adoptState(state('d1', 2));
    await client.bootstrap();
    expect(token()).toBe('alice');
  });

  it('adopts a new device despite its lower, independent revision', async () => {
    const { client, token } = clientWith(jest.fn().mockResolvedValue(sync('d2', 1, 'alice')));
    client.adoptState(state('d1', 42));
    await client.bootstrap();
    expect(client.getState()?.deviceId).toBe('d2');
    expect(token()).toBe('alice');
  });

  it('accepts the first bootstrap with no prior device', async () => {
    const { client, token } = clientWith(jest.fn().mockResolvedValue(sync('d1', 1, 'alice')));
    await client.bootstrap();
    expect(client.getState()?.deviceId).toBe('d1');
    expect(token()).toBe('alice');
  });

  it('accepts a same-device restate after the first state arrives while bootstrap waits', async () => {
    const delayed = deferred<unknown>();
    const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
    const pending = client.bootstrap();
    client.adoptState(state('d1', 2));
    delayed.resolve(sync('d1', 2, 'alice'));
    await pending;
    expect(token()).toBe('alice');
  });

  it('rejects a bootstrap superseded by resetLocalState', async () => {
    const delayed = deferred<unknown>();
    const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
    client.adoptState(state('d1', 1));
    const pending = client.bootstrap();
    const failure = expect(pending).rejects.toThrow('Device session request was superseded');
    client.resetLocalState();
    delayed.resolve(sync('d1', 2, 'obsolete'));
    await failure;
    expect(client.getState()).toBeNull();
    expect(token()).toBe('nate');
  });

  it('does not let a response for a retired device replace a newer device', async () => {
    const delayed = deferred<unknown>();
    const request = jest
      .fn()
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(sync('d2', 1, 'alice'));
    const { client, token } = clientWith(request);
    client.adoptState(state('d1', 1));
    const old = client.bootstrap();
    client.adoptState(state('d2', 1));
    await client.bootstrap();
    expect(token()).toBe('alice');
    delayed.resolve(sync('d1', 2, 'nate'));
    await old;
    expect(client.getState()?.deviceId).toBe('d2');
    expect(token()).toBe('alice');
  });

  it.each(['switch', 'signout', 'add'] as const)(
    'rejects a stale %s response after the active device changes',
    async (operation) => {
      const delayed = deferred<unknown>();
      const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
      client.adoptState(state('d1', 1));
      const pending =
        operation === 'switch'
          ? client.switchAccount('org')
          : operation === 'signout'
            ? client.signOut({ accountId: 'org' })
            : client.addCurrentAccount();
      const failure = expect(pending).rejects.toThrow('Device session request was superseded');
      client.adoptState(state('d2', 1));
      delayed.resolve(sync('d1', 2, 'obsolete'));
      await failure;
      expect(client.getState()?.deviceId).toBe('d2');
      expect(token()).toBe('nate');
    },
  );

  it.each(['switch', 'signout', 'add'] as const)(
    'accepts a same-device %s restate after the first state arrives',
    async (operation) => {
      const delayed = deferred<unknown>();
      const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
      const pending =
        operation === 'switch'
          ? client.switchAccount('org')
          : operation === 'signout'
            ? client.signOut({ accountId: 'org' })
            : client.addCurrentAccount();
      client.adoptState(state('d1', 2));
      delayed.resolve(sync('d1', 2, 'alice'));
      await pending;
      expect(client.getState()?.deviceId).toBe('d1');
      expect(token()).toBe('alice');
    },
  );

  it('does not report sign-out success after the device changes during logout persistence', async () => {
    const persisted = deferred<void>();
    const persistenceStarted = deferred<void>();
    const empty = { ...state('d1', 2), activeAccountId: null, accounts: [] };
    const request = jest.fn().mockResolvedValue({ state: empty, activeToken: null });
    const { client, token } = clientWith(request, {
      onFullExplicitSignOut: async () => {
        persistenceStarted.resolve();
        await persisted.promise;
      },
    });
    client.adoptState(state('d1', 1));
    const pending = client.signOut({ all: true });
    const failure = expect(pending).rejects.toThrow('Device session request was superseded');
    await persistenceStarted.promise;
    client.adoptState(state('d2', 1));
    persisted.resolve();
    await failure;
    expect(client.getState()?.deviceId).toBe('d2');
    expect(token()).toBe('nate');
  });

  it('does not report success when logout persistence synchronously adopts another device', async () => {
    const empty = { ...state('d1', 2), activeAccountId: null, accounts: [] };
    let client!: SessionClient;
    const setup = clientWith(jest.fn().mockResolvedValue({ state: empty, activeToken: null }), {
      onFullExplicitSignOut: async () => {
        client.adoptState(state('d2', 1));
      },
    });
    client = setup.client;
    client.adoptState(state('d1', 1));
    await expect(client.signOut({ all: true })).rejects.toThrow(
      'Device session request was superseded',
    );
    expect(client.getState()?.deviceId).toBe('d2');
  });

  it('does not report context removal success after reentrant device adoption', async () => {
    const empty = { ...state('d1', 2), activeAccountId: null, accounts: [] };
    const directory = {
      deviceId: 'd1',
      revision: 2,
      updatedAt: 1720000000000,
      activeContextId: null,
      principals: [],
    };
    let client!: SessionClient;
    const setup = clientWith(
      jest.fn().mockResolvedValue({ state: empty, directory, activeToken: null }),
      {
        onFullExplicitSignOut: async () => {
          client.adoptState(state('d2', 1));
        },
      },
      null,
    );
    client = setup.client;
    client.adoptState(state('d1', 1));
    await expect(client.signOutContext('ctx-old')).rejects.toThrow(
      'Device session request was superseded',
    );
    expect(client.getState()?.deviceId).toBe('d2');
  });

  it.each(['activate', 'remove-context', 'remove-principal'] as const)(
    'rejects a stale %s directory response after the active device changes',
    async (operation) => {
      const delayed = deferred<unknown>();
      const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
      client.adoptState(state('d1', 1));
      const pending =
        operation === 'activate'
          ? client.activateContext('ctx-old')
          : operation === 'remove-context'
            ? client.signOutContext('ctx-old')
            : client.signOutPrincipal('principal-old');
      const failure = expect(pending).rejects.toThrow('Device session request was superseded');
      client.adoptState(state('d2', 1));
      delayed.resolve({
        directory: {
          deviceId: 'd1',
          revision: 2,
          updatedAt: 1720000000000,
          activeContextId: null,
          principals: [],
        },
        state: state('d1', 2),
        activeToken: { accessToken: 'obsolete', expiresAt: '2030-01-01T00:00:00Z' },
      });
      await failure;
      expect(client.getState()?.deviceId).toBe('d2');
      expect(client.getDirectory()).toBeNull();
      expect(token()).toBe('nate');
    },
  );

  it('ignores a stale directory read after the active device changes', async () => {
    const delayed = deferred<unknown>();
    const { client } = clientWith(jest.fn().mockReturnValue(delayed.promise));
    client.adoptState(state('d1', 1));
    const pending = client.refreshDirectory();
    client.adoptState(state('d2', 1));
    delayed.resolve({
      deviceId: 'd1',
      revision: 2,
      updatedAt: 1720000000000,
      activeContextId: null,
      principals: [],
    });
    await pending;
    expect(client.getDirectory()).toBeNull();
    expect(client.getState()?.deviceId).toBe('d2');
  });

  it('does not report an old activation after its reconciliation is superseded', async () => {
    const delayed = deferred<unknown>();
    const readStarted = deferred<void>();
    const directory = (deviceId: string, revision: number) => ({
      deviceId,
      revision,
      updatedAt: 1720000000000,
      activeContextId: null,
      principals: [],
    });
    const request = jest.fn(async (_method: string, url: string) => {
      if (url === '/session/device/activate')
        return { directory: contextDirectory('nate'), activeToken: null };
      if (url === '/session/device/state') {
        readStarted.resolve();
        return delayed.promise;
      }
      if (url === '/session/device/directory') return directory('d2', 1);
      throw new Error(`Unexpected path ${url}`);
    });
    const { client } = clientWith(request);
    client.adoptState(state('d1', 1));
    const pending = client.activateContext('ctx-nate');
    const failure = expect(pending).rejects.toThrow('Device session request was superseded');
    await readStarted.promise;
    client.adoptState(state('d2', 1));
    delayed.resolve(sync('d1', 2, 'obsolete'));
    await failure;
    expect(client.getState()?.deviceId).toBe('d2');
  });

  it('rejects an activation overtaken on the same device while reconciliation waits', async () => {
    const oldState = deferred<unknown>();
    const oldReadStarted = deferred<void>();
    let stateReads = 0;
    const request = jest.fn(async (_method: string, url: string, body?: { contextId?: string }) => {
      if (url === '/session/device/activate') {
        const actor = body?.contextId === 'ctx-nate' ? 'nate' : 'alice';
        return {
          directory: contextDirectory(actor, actor === 'nate' ? 2 : 3),
          activeToken: {
            accessToken: actorToken(actor, `ctx-${actor}`),
            expiresAt: '2030-01-01T00:00:00Z',
          },
        };
      }
      if (url === '/session/device/state') {
        if (stateReads++ === 0) {
          oldReadStarted.resolve();
          return oldState.promise;
        }
        return sync('d1', 3, actorToken('alice', 'ctx-alice'));
      }
      throw new Error(`Unexpected path ${url}`);
    });
    const { client, token } = clientWith(request);
    client.adoptState(state('d1', 1));
    const old = client.activateContext('ctx-nate');
    const failure = expect(old).rejects.toThrow('Device session request was superseded');
    await oldReadStarted.promise;
    await client.activateContext('ctx-alice');
    oldState.resolve(sync('d1', 2, actorToken('nate', 'ctx-nate')));
    await failure;
    expect(client.getState()?.revision).toBe(3);
    expect(client.getActiveContext()?.contextId).toBe('ctx-alice');
    expect(token()).toBe(actorToken('alice', 'ctx-alice'));
  });

  it('rejects a stale activation for the same account after a newer revision', async () => {
    const delayed = deferred<unknown>();
    const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
    client.adoptState(state('d1', 1));
    const pending = client.activateContext('ctx-old');
    const failure = expect(pending).rejects.toThrow('Device session request was superseded');
    client.adoptState(state('d1', 2));
    delayed.resolve({
      directory: {
        deviceId: 'd1',
        revision: 1,
        updatedAt: 1720000000000,
        activeContextId: 'ctx-old',
        principals: [
          {
            id: 'p-nate',
            userId: 'nate',
            authuser: 0,
            user: { id: 'nate', username: 'nate' },
            contexts: [
              {
                id: 'ctx-old',
                accountId: 'org',
                kind: 'organization',
                relationship: 'owner',
                account: { id: 'org', username: 'org' },
                onDevice: true,
                available: true,
                active: true,
                lastUsedAt: null,
              },
            ],
          },
        ],
      },
      activeToken: { accessToken: 'obsolete', expiresAt: '2030-01-01T00:00:00Z' },
    });
    await failure;
    expect(client.getState()?.revision).toBe(2);
    expect(token()).toBe('nate');
  });

  it('rejects an equal-revision directory for a different requested context before publishing', async () => {
    const response = {
      directory: contextDirectory('alice'),
      activeToken: {
        accessToken: actorToken('alice', 'ctx-alice'),
        expiresAt: '2030-01-01T00:00:00Z',
      },
    };
    const { client, token } = clientWith(jest.fn().mockResolvedValue(response));
    client.adoptState(state('d1', 2));
    const listener = jest.fn();
    client.subscribe(listener);
    await expect(client.activateContext('ctx-nate')).rejects.toThrow(
      'Device session request was superseded',
    );
    expect(token()).toBe('nate');
    expect(client.getDirectory()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects equal-revision directories that name different active contexts', async () => {
    const request = jest.fn(async (_method: string, url: string) => {
      if (url === '/session/device/directory') return contextDirectory('alice');
      if (url === '/session/device/activate')
        return {
          directory: contextDirectory('nate'),
          activeToken: {
            accessToken: actorToken('nate', 'ctx-nate'),
            expiresAt: '2030-01-01T00:00:00Z',
          },
        };
      throw new Error(`Unexpected path ${url}`);
    });
    const { client, token } = clientWith(request);
    client.adoptState(state('d1', 2));
    await client.refreshDirectory();
    const listener = jest.fn();
    client.subscribe(listener);
    await expect(client.activateContext('ctx-nate')).rejects.toThrow(
      'Device session request was superseded',
    );
    expect(client.getActiveContext()?.contextId).toBe('ctx-alice');
    expect(token()).toBe('nate');
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong context', actorToken('alice', 'ctx-nate')],
    ['wrong actor', actorToken('nate', 'ctx-alice')],
  ])('rejects a bearer with a known %s before publishing', async (_label, accessToken) => {
    const response = {
      directory: contextDirectory('alice'),
      activeToken: { accessToken, expiresAt: '2030-01-01T00:00:00Z' },
    };
    const { client, token } = clientWith(jest.fn().mockResolvedValue(response));
    client.adoptState(state('d1', 2));
    const listener = jest.fn();
    client.subscribe(listener);
    await expect(client.activateContext('ctx-alice')).rejects.toThrow(
      'Device session request was superseded',
    );
    expect(token()).toBe('nate');
    expect(client.getDirectory()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ['matching v2', actorToken('alice', 'ctx-alice')],
    ['opaque', 'opaque-token'],
    [
      'legacy',
      `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: 'legacy' })).toString('base64url')}.s`,
    ],
  ])('accepts an idempotent activation with a %s bearer', async (_label, accessToken) => {
    const response = {
      directory: contextDirectory('alice'),
      activeToken: { accessToken, expiresAt: '2030-01-01T00:00:00Z' },
    };
    const { client, token } = clientWith(jest.fn().mockResolvedValue(response));
    client.adoptState(state('d1', 2));
    await client.activateContext('ctx-alice');
    expect(token()).toBe(accessToken);
    expect(client.getActiveContext()?.actor.userId).toBe('alice');
  });

  it('preserves the existing identity-pinned same-subject activation behavior', async () => {
    const response = {
      directory: contextDirectory('alice'),
      activeToken: {
        accessToken: actorToken('alice', 'ctx-alice'),
        expiresAt: '2030-01-01T00:00:00Z',
      },
    };
    const { client, token } = clientWith(jest.fn().mockResolvedValue(response), {
      getPinnedAccountId: () => 'org',
    });
    client.adoptState(state('d1', 2));
    await client.activateContext('ctx-alice');
    expect(token()).toBe(response.activeToken.accessToken);
  });

  it('preserves missing-bearer recovery for a pinned subject with a different actor', async () => {
    const response = {
      directory: contextDirectory('alice'),
      activeToken: {
        accessToken: actorToken('alice', 'ctx-alice'),
        expiresAt: '2030-01-01T00:00:00Z',
      },
    };
    const { client, token } = clientWith(
      jest.fn().mockResolvedValue(response),
      { getPinnedAccountId: () => 'org' },
      null,
    );
    client.adoptState(state('d1', 2));
    await client.activateContext('ctx-alice');
    expect(token()).toBe(response.activeToken.accessToken);
  });

  it('propagates a server 409 without reporting activation success or publishing', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: 'context_superseded' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
    const originalToken = actorToken('alice', 'ctx-alice');
    oxy.session.setAccessToken(originalToken);
    const client = new SessionClient(createSessionClientHost(oxy));
    client.adoptState(state('d1', 2));
    const listener = jest.fn();
    client.subscribe(listener);
    try {
      await expect(client.activateContext('ctx-nate')).rejects.toMatchObject({ status: 409 });
      expect(client.getDirectory()).toBeNull();
      expect(oxy.session.accessToken).toBe(originalToken);
      expect(listener).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
      oxy.dispose();
    }
  });

  it('does not resurrect a response after device A to B to A', async () => {
    const delayed = deferred<unknown>();
    const { client, token } = clientWith(jest.fn().mockReturnValue(delayed.promise));
    client.adoptState(state('d1', 1));
    const old = client.bootstrap();
    client.adoptState(state('d2', 1));
    client.adoptState(state('d1', 1));
    delayed.resolve(sync('d1', 2, 'obsolete'));
    await old;
    expect(client.getState()?.revision).toBe(1);
    expect(token()).toBe('nate');
  });

  it('rejects a bootstrap started on a device whose mint later rolls back', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `h.${encode({ userId: 'org', sessionId: 'session-nate', exp: 4102444800 })}.s`;
    const pendingResponse = deferred<unknown>();
    let failMint!: (error: Error) => void;
    const mint = new Promise<void>((_resolve, reject) => {
      failMint = reject;
    });
    const host: SessionClientHost = {
      makeRequest: jest.fn().mockReturnValue(pendingResponse.promise),
      getBaseURL: () => 'https://oxy.example',
      getAccessToken: () => token,
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: jest.fn(),
      getCurrentAccountId: () => 'org',
    };
    const client = new SessionClient(host, {
      transport: {
        ensureActiveToken: (next) => (next.deviceId === 'd2' ? mint : Promise.resolve()),
      },
    });
    client.adoptState(state('d1', 1));
    const next = { ...state('d2', 1), activeAccountId: 'other' };
    client.adoptState(next);
    expect(client.getState()?.deviceId).toBe('d2');
    const pending = client.bootstrap();
    failMint(new Error('mint failed'));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(client.getState()?.deviceId).toBe('d1');
    pendingResponse.resolve(sync('d2', 2, 'obsolete'));
    await pending;
    expect(client.getState()?.deviceId).toBe('d1');
  });

  it('does not let an obsolete failed mint roll back a newer device', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `h.${encode({ userId: 'org', sessionId: 'session-nate', exp: 4102444800 })}.s`;
    let failMint!: (error: Error) => void;
    const mint = new Promise<void>((_resolve, reject) => {
      failMint = reject;
    });
    const host: SessionClientHost = {
      makeRequest: jest.fn(),
      getBaseURL: () => 'https://oxy.example',
      getAccessToken: () => token,
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: jest.fn(),
      getCurrentAccountId: () => 'org',
    };
    const client = new SessionClient(host, {
      transport: {
        ensureActiveToken: (next) => (next.deviceId === 'd2' ? mint : Promise.resolve()),
      },
    });
    client.adoptState(state('d1', 1));
    client.adoptState({ ...state('d2', 1), activeAccountId: 'other' });
    client.adoptState(state('d3', 1));
    failMint(new Error('mint failed'));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(client.getState()?.deviceId).toBe('d3');
  });

  it('the default HTTP host rejects a response if the bearer changed in flight', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = (actor: string) =>
      `h.${encode({ userId: 'org', sessionId: `session-${actor}`, exp: 4102444800 })}.s`;
    const nate = jwt('nate');
    const alice = jwt('alice');
    const pendingResponse = deferred<Response>();
    const started = deferred<void>();
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => {
      started.resolve();
      return pendingResponse.promise;
    }) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
    oxy.session.setAccessToken(nate);
    const client = new SessionClient(createSessionClientHost(oxy));
    try {
      client.adoptState(state('d1', 1));
      const old = client.bootstrap();
      const rejected = expect(old).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await started.promise;
      client.adoptState(state('d1', 2));
      oxy.session.setAccessToken(alice);
      pendingResponse.resolve(
        new Response(JSON.stringify({ data: sync('d1', 1, nate) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await rejected;
      expect(client.getState()?.revision).toBe(2);
      expect(oxy.session.accessToken).toBe(alice);
    } finally {
      globalThis.fetch = original;
      oxy.dispose();
    }
  });

  it('the default HTTP host does not restore a retired device when its bearer stays unchanged', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `h.${encode({ userId: 'org', sessionId: 'session-nate', exp: 4102444800 })}.s`;
    const pendingResponse = deferred<Response>();
    const started = deferred<void>();
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => {
      started.resolve();
      return pendingResponse.promise;
    }) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
    oxy.session.setAccessToken(token);
    const client = new SessionClient(createSessionClientHost(oxy));
    try {
      client.adoptState(state('d1', 1));
      const old = client.bootstrap();
      await started.promise;
      client.adoptState(state('d2', 1));
      pendingResponse.resolve(
        new Response(JSON.stringify({ data: sync('d1', 2, token) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await old;
      expect(client.getState()?.deviceId).toBe('d2');
      expect(oxy.session.accessToken).toBe(token);
    } finally {
      globalThis.fetch = original;
      oxy.dispose();
    }
  });
});
