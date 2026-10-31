import { createExperimentalContextTransport } from '../experimentalContextTransport';
import { ExperimentalContextBarrier } from '../experimentalContextBarrier';

it('stages a complete personal context through the v1 transport before installing its bearer', async () => {
  let installed = 'old';
  const binding = {
    version: 1,
    deviceId: 'device',
    deviceSessionId: 'incarnation',
    revision: 4,
    contextId: 'context',
    actorId: 'person',
    accountId: 'person',
    sessionId: 'session',
    accessToken: 'candidate',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const state = {
    deviceId: 'device',
    revision: 4,
    updatedAt: 1,
    activeAccountId: 'person',
    accounts: [{ accountId: 'person', sessionId: 'session', authuser: 0 }],
  };
  const directory = {
    deviceId: 'device',
    revision: 4,
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
  const fetcher = jest.fn(async (url: string, init: RequestInit) => {
    expect(installed).toBe('old');
    const data = url.endsWith('context-token-v1')
      ? binding
      : url.endsWith('/state')
        ? { state, activeToken: null }
        : directory;
    if (url.endsWith('context-token-v1')) expect(init.headers).not.toHaveProperty('Authorization');
    else expect(init.headers).toEqual({ Authorization: 'Bearer candidate' });
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  const transport = createExperimentalContextTransport(
    'https://oxy.invalid',
    fetcher as typeof fetch,
  );
  const gate = new ExperimentalContextBarrier({
    ...transport,
    getCredential: () => ({ deviceId: 'device', deviceSecret: 'secret' }),
    getAccessToken: () => installed,
    setAccessToken: (token) => {
      expect(gate.snapshot()).toBeNull();
      installed = token;
    },
  });
  expect(await gate.reconcile()).toBe(true);
  expect(installed).toBe('candidate');
  expect(gate.snapshot()?.actorId).toBe('person');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('proves the holder without a bearer, then reads using only the candidate bearer', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { accessToken: 'candidate' } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { state: { revision: 4 }, activeToken: null } }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { revision: 4 } }), { status: 200 }),
    );
  const transport = createExperimentalContextTransport('https://oxy.invalid/base', fetcher);
  expect(await transport.mint({ deviceId: 'device', deviceSecret: 'secret' })).toEqual({
    accessToken: 'candidate',
  });
  expect(await transport.readState('candidate')).toEqual({ revision: 4 });
  expect(await transport.readDirectory('candidate')).toEqual({ revision: 4 });
  const [[mintUrl, mint], [stateUrl, state], [directoryUrl, directory]] = fetcher.mock.calls;
  expect(mintUrl).toBe('https://oxy.invalid/session/device/context-token-v1');
  expect(mint.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(mint.body)).toEqual({ deviceId: 'device', deviceSecret: 'secret' });
  expect(stateUrl).toBe('https://oxy.invalid/session/device/state');
  expect(directoryUrl).toBe('https://oxy.invalid/session/device/directory');
  expect(state.headers).toEqual({ Authorization: 'Bearer candidate' });
  expect(directory.headers).toEqual({ Authorization: 'Bearer candidate' });
  for (const init of [mint, state, directory]) {
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
  }
});

it.each([401, 409, 429, 500])('refuses %s without leaking the response body', async (status) => {
  const fetcher = jest.fn().mockResolvedValue(new Response('secret-in-error-body', { status }));
  const transport = createExperimentalContextTransport('https://oxy.invalid', fetcher);
  await expect(transport.mint({ deviceId: 'device', deviceSecret: 'secret' })).rejects.toThrow(
    'Context binding unavailable',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refuses non-HTTPS or credentialed origins before sending secrets', () => {
  expect(() => createExperimentalContextTransport('http://oxy.invalid')).toThrow();
  expect(() => createExperimentalContextTransport('https://u:p@oxy.invalid')).toThrow();
});
