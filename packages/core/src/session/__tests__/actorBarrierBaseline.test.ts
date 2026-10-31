import { HttpService } from '../../HttpService';
import { OxyServices } from '../../OxyServices';
import { SessionClient, type SessionClientHost } from '../SessionClient';
import { ExperimentalContextBarrier } from '../experimentalContextBarrier';

const token = (actor: string) =>
  `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: `s-${actor}`, act: { sub: actor }, exp: 4102444800 })).toString('base64url')}.s`;
const state = (revision: number) => ({
  deviceId: 'd1',
  revision,
  updatedAt: 1720000000000,
  activeAccountId: 'org',
  accounts: ['alice', 'nate'].map((actor, authuser) => ({
    accountId: 'org',
    sessionId: `s-${actor}`,
    authuser,
    operatedByUserId: actor,
  })),
});
const directory = (revision: number) => ({
  deviceId: 'd1',
  revision,
  updatedAt: 1720000000000,
  activeContextId: `ctx-${revision === 1 ? 'alice' : 'nate'}`,
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
        active: actor === (revision === 1 ? 'alice' : 'nate'),
        lastUsedAt: null,
      },
    ],
  })),
});

function fixture() {
  let revision = 1;
  let syncToken: string | null = null;
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      handlers.set(event, callback);
    },
    off: () => {},
    connect: () => {},
    disconnect: () => {},
  };
  const http = new HttpService({ baseURL: 'https://test.invalid', enableCache: false });
  http.setTokens(token('alice'));
  const host: SessionClientHost = {
    makeRequest: async <T>(_method: 'GET' | 'POST', path: string) => {
      if (path === '/session/device/state')
        return {
          state: state(revision),
          activeToken: syncToken
            ? { accessToken: syncToken, expiresAt: '2099-01-01T00:00:00Z' }
            : null,
        } as T;
      if (path === '/session/device/directory') return directory(revision) as T;
      throw new Error(`unexpected path ${path}`);
    },
    getBaseURL: () => 'https://test.invalid',
    getAccessToken: () => http.getAccessToken(),
    getDeviceCredential: () => null,
    onTokensChanged: (fn) => http.addTokenChangeListener(fn),
    setTokens: (value) => http.setTokens(value),
    getCurrentAccountId: () => 'org',
  };
  const client = new SessionClient(host, { socketFactory: () => socket as never });
  return {
    client,
    http,
    handlers,
    revision: () => revision,
    next: () => {
      revision = 2;
    },
    withToken: () => {
      syncToken = token('nate');
    },
  };
}

describe('baseline: real session and token store ordering', () => {
  it('a direct directory refresh exposes a different actor under the old bearer', async () => {
    const f = fixture();
    await f.client.start();
    await f.client.refreshDirectory();
    f.next();
    await f.client.refreshDirectory();
    expect(f.client.getActiveContext()?.actor.userId).toBe('nate');
    expect(f.http.getAccessToken()).toBe(token('alice'));
    f.client.stop();
    f.http.dispose();
  });

  it('a socket push converges the directory while retaining the old actor bearer', async () => {
    const f = fixture();
    await f.client.start();
    await f.client.refreshDirectory();
    f.next();
    f.handlers.get('session_state')?.(state(2));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.client.getActiveContext()?.actor.userId).toBe('nate');
    expect(f.http.getAccessToken()).toBe(token('alice'));
    f.client.stop();
    f.http.dispose();
  });

  it('a real token-change listener reenters before directory settlement', async () => {
    const f = fixture();
    await f.client.start();
    await f.client.refreshDirectory();
    const seen: Array<{
      revision: number | undefined;
      actor: string | undefined;
      bearer: string | null;
    }> = [];
    f.http.addTokenChangeListener(() =>
      seen.push({
        revision: f.client.getState()?.revision,
        actor: f.client.getActiveContext()?.actor.userId,
        bearer: f.http.getAccessToken(),
      }),
    );
    f.next();
    f.withToken();
    await f.client.bootstrap();
    expect(seen).toContainEqual({ revision: 2, actor: 'alice', bearer: token('nate') });
    f.client.stop();
    f.http.dispose();
  });
});

describe('prototype ingress adapter with real session and token store', () => {
  it.each(['socket', 'direct directory read'])(
    'hides staged state throughout a %s transition and synchronous token callbacks',
    async (source) => {
      const f = fixture();
      await f.client.start();
      await f.client.refreshDirectory();
      const gate = new ExperimentalContextBarrier({
        getCredential: () => ({ deviceId: 'd1', deviceSecret: 'secret' }),
        getAccessToken: () => f.http.getAccessToken(),
        setAccessToken: (value) => f.http.setTokens(value),
        mint: async () => {
          const revision = f.revision();
          const actor = revision === 1 ? 'alice' : 'nate';
          return {
            version: 1,
            deviceId: 'd1',
            deviceSessionId: 'instance',
            revision,
            contextId: `ctx-${actor}`,
            actorId: actor,
            accountId: 'org',
            sessionId: `s-${actor}`,
            accessToken: token(actor),
            expiresAt: '2099-01-01T00:00:00Z',
          };
        },
        readState: async () => state(f.revision()),
        readDirectory: async () => directory(f.revision()),
      });
      expect(await gate.reconcile()).toBe(true);
      expect(gate.snapshot()?.actorId).toBe('alice');
      const observations: Array<string | null> = [];
      f.http.addTokenChangeListener(() => observations.push(gate.snapshot()?.actorId ?? null));
      f.client.subscribe(() => observations.push(gate.snapshot()?.actorId ?? null));
      f.client.subscribeDirectory(() => observations.push(gate.snapshot()?.actorId ?? null));
      f.next();
      // Prototype adapter: the production ingress paths do not yet make this call.
      gate.invalidate();
      if (source === 'socket') {
        f.handlers.get('session_state')?.(state(2));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      } else {
        await f.client.refreshDirectory();
      }
      expect(gate.snapshot()).toBeNull();
      expect(await gate.reconcile()).toBe(true);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((value) => value === null)).toBe(true);
      expect(gate.snapshot()?.actorId).toBe('nate');
      expect(f.http.getAccessToken()).toBe(token('nate'));
      f.client.stop();
      f.http.dispose();
    },
  );
});

it('baseline: an independent linked client still yields a bearer while the prototype is closed', async () => {
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid' });
  oxy.http.setTokens(token('alice'));
  const linked = oxy.createLinkedClient({ baseURL: 'https://app.invalid' });
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'd1', deviceSecret: 'secret' }),
    getAccessToken: () => oxy.http.getAccessToken(),
    setAccessToken: (value) => oxy.http.setTokens(value),
    mint: async () => {
      throw new Error('unused');
    },
    readState: async () => {
      throw new Error('unused');
    },
    readDirectory: async () => {
      throw new Error('unused');
    },
  });
  expect(gate.status()).toBe('unavailable');
  expect(await linked.getAccessToken('https://app.invalid/socket')).toBe(token('alice'));
  linked.dispose();
  oxy.dispose();
});
