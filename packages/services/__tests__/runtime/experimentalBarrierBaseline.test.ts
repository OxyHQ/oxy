import { HttpService } from '../../../core/src/HttpService';
import { SessionClient } from '../../../core/src/session/SessionClient';
import { ExperimentalContextBarrier } from '../../../core/src/session/experimentalContextBarrier';
import { createOxyRuntime } from '../../src/ui/runtime';

it('uses the bound session and masks cached runtime data while the real barrier is closed', async () => {
  const http = new HttpService({ baseURL: 'https://oxy.invalid' });
  http.setTokens('old');
  let hold = false;
  let finish!: (value: unknown) => void;
  const binding = {
    version: 1,
    deviceId: 'd1',
    deviceSessionId: 'instance',
    revision: 2,
    contextId: 'ctx-nate',
    actorId: 'nate',
    accountId: 'org',
    sessionId: 's-nate',
    accessToken: 'candidate',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const state = {
    deviceId: 'd1',
    revision: 2,
    updatedAt: 1,
    activeAccountId: 'org',
    accounts: [
      { accountId: 'org', sessionId: 's-alice', authuser: 0, operatedByUserId: 'alice' },
      { accountId: 'org', sessionId: 's-nate', authuser: 1, operatedByUserId: 'nate' },
    ],
  };
  const directory = {
    deviceId: 'd1',
    revision: 2,
    updatedAt: 1,
    activeContextId: 'ctx-nate',
    principals: [
      {
        id: 'p-nate',
        userId: 'nate',
        authuser: 1,
        user: { id: 'nate', username: 'nate' },
        contexts: [
          {
            id: 'ctx-nate',
            accountId: 'org',
            kind: 'organization',
            relationship: 'member',
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
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'd1', deviceSecret: 'secret' }),
    getAccessToken: () => http.experimentalPeekAccessToken(),
    setAccessToken: (token) => http.experimentalInstallContextToken(token),
    mint: () =>
      hold
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(binding),
    readState: async () => state,
    readDirectory: async () => directory,
  });
  http.experimentalSetContextGateProvider(() => gate);
  const client = new SessionClient(
    {
      makeRequest: async () => {
        throw new Error('unexpected');
      },
      getBaseURL: () => 'https://oxy.invalid',
      getAccessToken: () => http.getAccessToken(),
      getDeviceCredential: () => ({ deviceId: 'd1', deviceSecret: 'secret' }),
      onTokensChanged: (fn) => http.addTokenChangeListener(fn),
      setTokens: (token) => http.setTokens(token),
      getCurrentAccountId: () => 'org',
    },
    {
      experimentalContextBarrier: gate,
      experimentalContextReady: () => http.experimentalContextReady(),
    },
  );
  const runtime = createOxyRuntime({
    oxyServices: {
      session: {
        get accessToken() {
          return http.getAccessToken();
        },
      },
      users: {
        getMany: async (ids) => ids.map((id) => ({ id, username: id, publicKey: 'key' }) as never),
      },
    },
    sessionClient: client,
    sessionClientHost: { setCurrentAccountId: () => {} },
    identity: null,
    onDeviceEmpty: async () => {},
    logger: () => {},
  });
  try {
    await client.bootstrap();
    await runtime.reconcileFromClient();
    expect(runtime.getSnapshot().activeContext?.actor.userId).toBe('nate');
    expect(runtime.getAccountSessionIdentity().sessionId).toBe('s-nate');
    expect(gate.snapshot()?.sessionId).toBe('s-nate');
    const stopRuntime = runtime.start();
    const observed: Array<string | null> = [];
    const unsubscribe = runtime.subscribe(() =>
      observed.push(runtime.getSnapshot().activeContext?.actor.userId ?? null),
    );
    hold = true;
    const pending = client.refreshDirectory();
    expect(client.getState()).toBeNull();
    expect(http.getAccessToken()).toBeNull();
    expect(runtime.getSnapshot().activeContext).toBeNull();
    expect(runtime.getAccountSessionIdentity().sessionId).toBeNull();
    expect(observed).toContain(null);
    finish(binding);
    await pending;
    unsubscribe();
    stopRuntime();
  } finally {
    client.stop();
    http.dispose();
  }
});
