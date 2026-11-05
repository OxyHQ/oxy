import type { DeviceDirectory, DeviceSessionState } from '@oxy.so/contracts';
import { OxyServices } from '@oxy.so/core';
import { SessionClient } from '../../../core/src/session/SessionClient';
import { createOxyRuntime } from '../../src/ui/runtime/createOxyRuntime';
import { createTokenTransport } from '../../src/ui/session/tokenTransport';

it('audits a pushed switch between two actors of the same account with the real transport', async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `h.${encode({ userId: 'org', sessionId: 'session-nate', act: { sub: 'nate' }, exp: 4102444800 })}.s`;
  let revision = 1;
  const state = (): DeviceSessionState => ({
    deviceId: 'd1', revision, updatedAt: 1720000000000, activeAccountId: 'org',
    accounts: [
      { accountId: 'org', sessionId: 'session-nate', authuser: 0, operatedByUserId: 'nate' },
      { accountId: 'org', sessionId: 'session-alice', authuser: 1, operatedByUserId: 'alice' },
    ],
  });
  const directory = (): DeviceDirectory => ({
    deviceId: 'd1', revision, updatedAt: 1720000000000,
    activeContextId: revision === 1 ? 'ctx-nate-org' : 'ctx-alice-org',
    principals: ['nate', 'alice'].map((name, index) => ({
      id: `p-${name}`, userId: name, authuser: index, user: { id: name, username: name },
      contexts: [{ id: `ctx-${name}-org`, accountId: 'org', kind: 'organization', relationship: 'member',
        account: { id: 'org', username: 'org' }, onDevice: true, available: true,
        active: name === (revision === 1 ? 'nate' : 'alice'), lastUsedAt: null }],
    })),
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    on: (name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); },
    off: (name: string) => { handlers.delete(name); },
    disconnect: () => undefined,
  };
  const oxy = new OxyServices({ baseURL: 'https://oxy.example' });
  oxy.session.setAccessToken(token);
  const refresh = jest.spyOn(oxy.http, 'refreshAccessToken').mockResolvedValue(null);
  jest.spyOn(oxy.users, 'getMany').mockResolvedValue([{ id: 'org', username: 'org' }] as never);
  const makeRequest = jest.fn(async (_method: string, path: string) => {
    if (path === '/session/device/state') return { state: state(), activeToken: { accessToken: token, expiresAt: 'x' } };
    if (path === '/session/device/directory') return directory();
    throw new Error(`Unexpected path ${path}`);
  });
  const client = new SessionClient({
    makeRequest: makeRequest as never, getBaseURL: () => 'https://oxy.example',
    getAccessToken: () => oxy.session.accessToken, setTokens: (value) => oxy.session.setAccessToken(value),
    getDeviceCredential: () => null, onTokensChanged: () => () => undefined, getCurrentAccountId: () => 'org',
  }, { transport: createTokenTransport(oxy), socketFactory: (() => socket) as never });
  const runtime = createOxyRuntime({
    oxyServices: oxy as never, sessionClient: client as never,
    sessionClientHost: { setCurrentAccountId: () => undefined },
    onDeviceEmpty: async () => undefined, logger: () => undefined,
  });
  const dispose = runtime.start();
  try {
    await client.start();
    await client.refreshDirectory();
    await runtime.reconcileFromClient();
    expect(runtime.getSnapshot().activeContext?.actor.userId).toBe('nate');
    expect(runtime.getSnapshot().activeSessionId).toBe('session-nate');
    const previous = runtime.getAccountSessionIdentity();
    makeRequest.mockClear();
    revision = 2;
    handlers.get('session_state')?.(state());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(runtime.getSnapshot().activeContext?.actor.userId).toBe('alice');
    expect(runtime.getSnapshot().activeSessionId).toBe('session-nate');
    expect(runtime.getAccountSessionIdentity()).toEqual(previous);
    expect(oxy.session.accessToken).toBe(token);
    expect(refresh).not.toHaveBeenCalled();
    expect(makeRequest.mock.calls.map((args) => args[1])).toEqual(['/session/device/directory']);
  } finally {
    dispose(); client.stop(); oxy.dispose();
  }
});
