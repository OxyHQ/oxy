/**
 * `runProviderColdBoot` with a session saved on the device: it paints from the
 * cache before any network answers, then checks the classification and the
 * session in the background. A first boot (nothing cached) is unchanged.
 */
import type { AuthStateStore, PersistedAuthState, SessionClient } from '@oxy.so/core/session';

jest.mock('@oxy.so/core/session', () => {
  const actual = jest.requireActual('@oxy.so/core/session');
  return { __esModule: true, ...actual, runSessionColdBoot: jest.fn() };
});

import { runSessionColdBoot } from '@oxy.so/core/session';
import { runProviderColdBoot, type RunProviderColdBootOptions } from '../runProviderColdBoot';

const mockRunSessionColdBoot = runSessionColdBoot as jest.Mock;
type BootOptions = Parameters<typeof runSessionColdBoot>[0];

const OFFICIAL = {
  id: 'app',
  name: 'App',
  type: 'first_party',
  isOfficial: true,
  isInternal: false,
  scopes: [],
};

function credentialStore(): AuthStateStore {
  const state: PersistedAuthState = {
    sessionId: 's1',
    userId: 'u1',
    deviceId: 'd1',
    deviceSecret: 'secret',
  };
  return {
    load: jest.fn(async () => state),
    save: jest.fn(async () => true),
    clear: jest.fn(async () => undefined),
  } as unknown as AuthStateStore;
}

function makeOptions(paints: boolean): RunProviderColdBootOptions & {
  getPublic: jest.Mock;
  release: (app: unknown) => void;
  fail: (error: Error) => void;
} {
  let release: (app: unknown) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const getPublic = jest.fn(
    () =>
      new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
  );
  const markAuthResolved = jest.fn();
  return {
    oxyServices: { apps: { getPublic } } as unknown as RunProviderColdBootOptions['oxyServices'],
    authStore: credentialStore(),
    clientId: 'oxy_dk_test',
    sessionClient: { start: jest.fn(async () => undefined) } as unknown as SessionClient,
    syncDeviceCredentialToHost: jest.fn(async () => undefined),
    commitSession: jest.fn(async () => undefined),
    markAuthResolved,
    setTokenReady: jest.fn(),
    paintCachedSession: jest.fn(async () => {
      if (paints) markAuthResolved();
      return paints;
    }),
    onCachedSessionRejected: jest.fn(async () => undefined),
    onCachedSessionUnconfirmed: jest.fn(),
    getPublic,
    release: (app) => release(app),
    fail: (error) => fail(error),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockRunSessionColdBoot.mockReset();
  window.history.replaceState(null, '', '/');
});

it('paints a saved session before the registry or the mint answers, then mints for a verdict', async () => {
  mockRunSessionColdBoot.mockImplementation(async (opts: BootOptions) => {
    const session = { sessionId: 's1', userId: 'u1', accessToken: 'minted', via: 'mint' };
    await opts.onSession?.(session);
    return { kind: 'session', via: session.via, session };
  });
  const options = makeOptions(true);

  const boot = runProviderColdBoot(options);
  await tick();

  expect(options.markAuthResolved).toHaveBeenCalled();
  expect(mockRunSessionColdBoot).not.toHaveBeenCalled();

  options.release(OFFICIAL);
  await boot;

  expect(mockRunSessionColdBoot).toHaveBeenCalledWith(
    expect.objectContaining({ requireServerVerdict: true }),
  );
  expect(options.commitSession).toHaveBeenCalledWith(
    { sessionId: 's1', userId: 'u1', accessToken: 'minted', deviceState: undefined },
    { activate: false },
  );
  expect(options.onCachedSessionRejected).not.toHaveBeenCalled();
  expect(options.onCachedSessionUnconfirmed).not.toHaveBeenCalled();
});

it.each([
  ['the server ends the holder', OFFICIAL, true],
  [
    'the registry now classifies the app OAuth-only',
    { ...OFFICIAL, type: 'third_party', isOfficial: false },
    false,
  ],
])('signs a painted session out when %s', async (_case, app, mints) => {
  mockRunSessionColdBoot.mockImplementation(async (opts: BootOptions) => {
    opts.onHolderRejected?.();
    await opts.onSignedOut?.('no_session');
    return { kind: 'unauthenticated' };
  });
  const options = makeOptions(true);

  const boot = runProviderColdBoot(options);
  await tick();
  options.release(app);
  await boot;

  expect(mockRunSessionColdBoot).toHaveBeenCalledTimes(mints ? 1 : 0);
  expect(options.onCachedSessionRejected).toHaveBeenCalledTimes(1);
  expect(options.onCachedSessionUnconfirmed).not.toHaveBeenCalled();
});

it('keeps a painted session the server could not be asked about, and asks again', async () => {
  mockRunSessionColdBoot.mockImplementationOnce(async (opts: BootOptions) => {
    await opts.onSignedOut?.('no_session');
    return { kind: 'unauthenticated' };
  });
  const options = makeOptions(true);

  const boot = runProviderColdBoot(options);
  await tick();
  options.fail(new Error('offline'));
  await boot;

  expect(options.onCachedSessionRejected).not.toHaveBeenCalled();
  const retry = (options.onCachedSessionUnconfirmed as jest.Mock).mock.calls[0][0];
  mockRunSessionColdBoot.mockImplementationOnce(async (opts: BootOptions) => {
    const session = { sessionId: 's1', userId: 'u1', accessToken: 'minted', via: 'mint' };
    await opts.onSession?.(session);
    return { kind: 'session', via: session.via, session };
  });
  const retried = retry();
  await tick();
  options.release(OFFICIAL);
  await retried;

  expect(options.commitSession).toHaveBeenCalledTimes(1);
  expect(options.onCachedSessionUnconfirmed).toHaveBeenCalledTimes(1);
});

it('a first boot with nothing cached still waits for the verdict and the handoff', async () => {
  mockRunSessionColdBoot.mockImplementation(async (opts: BootOptions) => {
    await opts.onSignedOut?.('no_session');
    return { kind: 'unauthenticated' };
  });
  const options = makeOptions(false);

  const boot = runProviderColdBoot(options);
  await tick();

  expect(options.markAuthResolved).not.toHaveBeenCalled();
  expect(mockRunSessionColdBoot).not.toHaveBeenCalled();

  options.release(OFFICIAL);
  await boot;

  expect(mockRunSessionColdBoot).toHaveBeenCalledWith(
    expect.objectContaining({ requireServerVerdict: false }),
  );
  expect(options.markAuthResolved).toHaveBeenCalled();
  expect(options.onCachedSessionRejected).not.toHaveBeenCalled();
});
