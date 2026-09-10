import type { DeviceSessionState } from '@oxy.so/contracts';
import type { User } from '../../models/interfaces';
import { SessionClient, type TokenTransport } from '../SessionClient';
import { createSessionClientHost } from '../sessionClientHost';
import { createSessionClient } from '../createSessionClient';
import {
  accountIdsOf,
  activeSessionIdOf,
  activeUserOf,
  deviceStateToClientSessions,
} from '../projectSessionState';

function fakeOxy() {
  const listeners = new Set<(t: string | null) => void>();
  return {
    makeRequest: jest.fn().mockResolvedValue({ ok: true }),
    getBaseURL: jest.fn().mockReturnValue('https://api.oxy.so'),
    getAccessToken: jest.fn().mockReturnValue('tok'),
    setTokens: jest.fn(),
    onTokensChanged: jest.fn((l: (t: string | null) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    _emit: (t: string | null) => listeners.forEach((l) => l(t)),
  };
}

describe('createSessionClientHost', () => {
  test('delegates REST + token methods to oxyServices', async () => {
    const oxy = fakeOxy();
    const host = createSessionClientHost(oxy as never);
    await host.makeRequest('GET', '/session/device/state', undefined, { cache: false });
    expect(oxy.makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, { cache: false });
    expect(host.getBaseURL()).toBe('https://api.oxy.so');
    expect(host.getAccessToken()).toBe('tok');
    host.setTokens('new');
    expect(oxy.setTokens).toHaveBeenCalledWith('new');
  });

  test('getCurrentAccountId reflects setCurrentAccountId', () => {
    const host = createSessionClientHost(fakeOxy() as never);
    expect(host.getCurrentAccountId()).toBeNull();
    host.setCurrentAccountId('u1');
    expect(host.getCurrentAccountId()).toBe('u1');
  });

  test('setDeviceCredential reflects on getDeviceCredential', () => {
    const host = createSessionClientHost(fakeOxy() as never);
    expect(host.getDeviceCredential()).toBeNull();
    host.setDeviceCredential({ deviceId: 'd1', deviceSecret: 's1' });
    expect(host.getDeviceCredential()).toEqual({ deviceId: 'd1', deviceSecret: 's1' });
  });

  test('onTokensChanged forwards to oxyServices and unsubscribes', () => {
    const oxy = fakeOxy();
    const host = createSessionClientHost(oxy as never);
    const cb = jest.fn();
    const unsub = host.onTokensChanged(cb);
    oxy._emit(null);
    expect(cb).toHaveBeenCalledWith(null);
    unsub();
    oxy._emit('x');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

function makeUser(id: string): User {
  return {
    id,
    publicKey: `pk-${id}`,
    username: `user-${id}`,
    name: {},
  };
}

// DeviceSessionState.updatedAt is an epoch-ms number on the wire (see
// packages/contracts/src/deviceSession.ts: `updatedAt: z.number()`), not an
// ISO string.
const UPDATED_AT_MS = Date.UTC(2026, 6, 1, 0, 0, 0, 0);
const UPDATED_AT_ISO = new Date(UPDATED_AT_MS).toISOString();

const state: DeviceSessionState = {
  deviceId: 'device-1',
  accounts: [
    { accountId: 'a1', sessionId: 'sess-a1', authuser: 0 },
    { accountId: 'a2', sessionId: 'sess-a2', authuser: 1 },
  ],
  activeAccountId: 'a2',
  revision: 1,
  updatedAt: UPDATED_AT_MS,
};

const usersById = new Map<string, User>([
  ['a1', makeUser('a1')],
  ['a2', makeUser('a2')],
]);

describe('projectSessionState', () => {
  describe('activeSessionIdOf', () => {
    test('returns the active account sessionId', () => {
      expect(activeSessionIdOf(state)).toBe('sess-a2');
    });

    test('returns null for null state', () => {
      expect(activeSessionIdOf(null)).toBeNull();
    });

    test('returns null when activeAccountId is null', () => {
      expect(activeSessionIdOf({ ...state, activeAccountId: null })).toBeNull();
    });
  });

  describe('deviceStateToClientSessions', () => {
    test('maps every account in order with isCurrent + authuser', () => {
      const sessions = deviceStateToClientSessions(state, usersById);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toEqual({
        sessionId: 'sess-a1',
        deviceId: 'device-1',
        expiresAt: UPDATED_AT_ISO,
        lastActive: UPDATED_AT_ISO,
        userId: 'a1',
        isCurrent: false,
        authuser: 0,
      });
      expect(sessions[1]).toEqual({
        sessionId: 'sess-a2',
        deviceId: 'device-1',
        expiresAt: UPDATED_AT_ISO,
        lastActive: UPDATED_AT_ISO,
        userId: 'a2',
        isCurrent: true,
        authuser: 1,
      });
    });

    test('still projects a session for an account absent from usersById', () => {
      const sessions = deviceStateToClientSessions(state, new Map());
      expect(sessions).toHaveLength(2);
      expect(sessions.map((session) => session.userId)).toEqual(['a1', 'a2']);
    });
  });

  describe('activeUserOf', () => {
    test('returns the active account user', () => {
      expect(activeUserOf(state, usersById)).toEqual(makeUser('a2'));
    });

    test('returns null for null state', () => {
      expect(activeUserOf(null, usersById)).toBeNull();
    });

    test('returns null when activeAccountId is null', () => {
      expect(activeUserOf({ ...state, activeAccountId: null }, usersById)).toBeNull();
    });

    test('returns null when the active account id is absent from usersById', () => {
      expect(activeUserOf(state, new Map())).toBeNull();
    });
  });

  describe('accountIdsOf', () => {
    test('returns every account id in order', () => {
      expect(accountIdsOf(state)).toEqual(['a1', 'a2']);
    });

    test('returns [] for null state', () => {
      expect(accountIdsOf(null)).toEqual([]);
    });
  });
});

describe('createSessionClient', () => {
  function fakeTransport(): TokenTransport {
    return { ensureActiveToken: jest.fn().mockResolvedValue(undefined) };
  }

  test('wires a SessionClient instance backed by the host + injected transport', () => {
    const oxy = fakeOxy();

    const { client, host } = createSessionClient(oxy as never, fakeTransport());

    expect(client).toBeInstanceOf(SessionClient);
    expect(typeof client.bootstrap).toBe('function');
    expect(client.getState()).toBeNull();
    expect(typeof host.setCurrentAccountId).toBe('function');
  });

  test('the returned host reflects setCurrentAccountId', () => {
    const oxy = fakeOxy();

    const { host } = createSessionClient(oxy as never, fakeTransport());

    expect(host.getCurrentAccountId()).toBeNull();
    host.setCurrentAccountId('u1');
    expect(host.getCurrentAccountId()).toBe('u1');
  });

  test('uses the injected transport (not a hard-coded one) when the client bootstraps', async () => {
    const oxy = fakeOxy();
    oxy.makeRequest.mockResolvedValue({ state, activeToken: null });
    const transport = fakeTransport();

    const { client } = createSessionClient(oxy as never, transport);
    await client.bootstrap();

    expect(transport.ensureActiveToken).toHaveBeenCalledWith(expect.objectContaining({ revision: state.revision }));
  });
});
