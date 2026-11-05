import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost } from '../SessionClient';
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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clientWith(request: jest.Mock) {
  let token = 'nate';
  const host: SessionClientHost = {
    makeRequest: request,
    getBaseURL: () => 'https://oxy.example',
    getAccessToken: () => token,
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: (value) => { token = value; },
    getCurrentAccountId: () => 'org',
  };
  return { client: new SessionClient(host), token: () => token };
}

describe('SessionClient bootstrap token ownership', () => {
  it('does not plant an older revision for another actor of the same account', async () => {
    const delayed = deferred<unknown>();
    const request = jest.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(sync('d1', 2, 'alice'));
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

  it('does not let a response for a retired device replace a newer device', async () => {
    const delayed = deferred<unknown>();
    const request = jest.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(sync('d2', 1, 'alice'));
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

  it('the default HTTP host rejects a response if the bearer changed in flight', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = (actor: string) => `h.${encode({ userId: 'org', sessionId: `session-${actor}`, exp: 4102444800 })}.s`;
    const nate = jwt('nate');
    const alice = jwt('alice');
    const pendingResponse = deferred<Response>();
    const started = deferred<void>();
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => { started.resolve(); return pendingResponse.promise; }) as typeof fetch;
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
      pendingResponse.resolve(new Response(JSON.stringify({ data: sync('d1', 1, nate) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
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
    globalThis.fetch = jest.fn(async () => { started.resolve(); return pendingResponse.promise; }) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
    oxy.session.setAccessToken(token);
    const client = new SessionClient(createSessionClientHost(oxy));
    try {
      client.adoptState(state('d1', 1));
      const old = client.bootstrap();
      await started.promise;
      client.adoptState(state('d2', 1));
      pendingResponse.resolve(new Response(JSON.stringify({ data: sync('d1', 2, token) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      await old;
      expect(client.getState()?.deviceId).toBe('d2');
      expect(oxy.session.accessToken).toBe(token);
    } finally {
      globalThis.fetch = original;
      oxy.dispose();
    }
  });
});
