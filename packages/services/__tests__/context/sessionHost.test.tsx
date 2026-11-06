/**
 * @jest-environment-options {"url": "https://app.oxy.so/"}
 *
 * Host mode (ADR 0058 decision 1): a platform that holds the Oxy session
 * registers an `OxySessionHost`, and the provider takes its session from it.
 *
 * A real `OxyServices` runs over a recorded `fetch`, so "no `/session/device/*`
 * call" and "the request carried the host's token" are read off the wire.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OxyServices } from '@oxy.so/core';
import type { OxyHostSnapshot, OxyHostToken, OxySessionHost } from '@oxy.so/core/host';

const mockUserSocket = {
  onServerEvent: jest.fn(() => () => undefined),
  sync: jest.fn(),
  restart: jest.fn(),
  stop: jest.fn(),
};
jest.mock('@oxy.so/core/session', () => ({
  ...jest.requireActual('@oxy.so/core/session'),
  createUserEventSocket: jest.fn(() => mockUserSocket),
}));

// Everything a hosted provider must never reach.
const mockCreatePlatformAuthStateStore = jest.fn();
const mockCreateSessionClient = jest.fn();
jest.mock('../../src/ui/session', () => ({
  ...jest.requireActual('../../src/ui/session'),
  createPlatformAuthStateStore: (...args: unknown[]) => mockCreatePlatformAuthStateStore(...args),
  createSessionClient: (...args: unknown[]) => mockCreateSessionClient(...args),
}));
const mockColdBoot = jest.fn();
jest.mock('../../src/ui/boot/runProviderColdBoot', () => ({
  runProviderColdBoot: (...args: unknown[]) => mockColdBoot(...args),
}));
const mockOpenBridgeWindow = jest.fn();
jest.mock('../../src/ui/oauth/browserBridge', () => ({
  ...jest.requireActual('../../src/ui/oauth/browserBridge'),
  openBridgeWindow: (...args: unknown[]) => mockOpenBridgeWindow(...args),
}));
const mockPresentDetached = jest.fn();
jest.mock('../../src/ui/navigation/surfaces', () => ({
  ...jest.requireActual('../../src/ui/navigation/surfaces'),
  presentDetached: (...args: unknown[]) => mockPresentDetached(...args),
}));

import { OxyHostedRuntimeProvider } from '../../src/ui/context/OxyHostedContext';
import { useOxy, type OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuth } from '../../src/ui/hooks/useAuth';
import { useOxyEvent } from '../../src/ui/hooks/useOxyEvent';
import { createMemoryStorage } from '../../src/ui/utils/storageHelpers';

const API = 'https://api.oxy.test';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let jti = 0;
function token(userId: string, sessionId = `sess-${userId}`): OxyHostToken {
  jti += 1;
  return {
    accessToken: `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
      userId,
      sessionId,
      azp: 'app-client',
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: String(jti),
    })}.sig`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

const ALICE = { id: 'acct-alice', handle: 'alice', displayName: 'Alice' };
const BOB = { id: 'acct-bob', handle: 'bob' };

function signedIn(account: OxyHostSnapshot['account'], revision = 1, online = true) {
  return { status: 'signed_in', revision, account, online } as OxyHostSnapshot;
}

function fakeHost(initial: OxyHostSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const host = {
    contract: 1 as const,
    platform: 'oxyos' as const,
    snapshot: jest.fn(() => current),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    getAccessToken: jest.fn(async (_request: { reason: 'boot' | 'preflight' | 'response-401' }) =>
      current.account ? token(current.account.id) : null,
    ) as jest.Mock<
      Promise<OxyHostToken | null>,
      [{ reason: 'boot' | 'preflight' | 'response-401' }]
    >,
    request: jest.fn(async (_action: string) => undefined),
  };
  return {
    host: host as OxySessionHost & typeof host,
    set(next: OxyHostSnapshot) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface Call {
  url: string;
  authorization: string | null;
}
let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

function installFetch(): void {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url, authorization: headers.Authorization ?? headers.authorization ?? null };
    calls.push(call);
    const { status, body } = respond(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
      body: null,
    };
  });
}

let captured: OxyContextState | null = null;
let auth: ReturnType<typeof useAuth> | null = null;
let renders: Array<{ userId: string | null; bearer: string | null }> = [];

function Capture({ oxy }: { oxy: OxyServices }) {
  captured = useOxy();
  auth = useAuth();
  useOxyEvent('supervision_changed', () => undefined);
  renders.push({ userId: captured.user?.id ?? null, bearer: oxy.session.accessToken });
  return null;
}

function renderHosted(session: { host: OxySessionHost } | { unknownContract: true }) {
  const oxy = new OxyServices({ baseURL: API, enableCache: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OxyHostedRuntimeProvider
        session={session}
        oxyServices={oxy}
        clientId="app-client"
        platformStorage={createMemoryStorage()}
      >
        <Capture oxy={oxy} />
      </OxyHostedRuntimeProvider>
    </QueryClientProvider>,
  );
  return { oxy, view };
}

function deviceCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/session/device'));
}

beforeEach(() => {
  calls = [];
  respond = (call) =>
    call.url.endsWith('/users/me')
      ? { status: 200, body: { id: ALICE.id, username: ALICE.handle, name: {}, publicKey: '' } }
      : { status: 200, body: [] };
  installFetch();
  captured = null;
  auth = null;
  renders = [];
  window.localStorage.clear();
  for (const mock of [
    mockCreatePlatformAuthStateStore,
    mockCreateSessionClient,
    mockColdBoot,
    mockOpenBridgeWindow,
    mockPresentDetached,
    mockUserSocket.restart,
    mockUserSocket.sync,
  ]) {
    mock.mockClear();
  }
});

describe('OxyProvider host mode', () => {
  it('takes the account and token from the host and persists, boots and bridges nothing', async () => {
    const { host } = fakeHost(signedIn(ALICE));
    const { oxy } = renderHosted({ host });

    await waitFor(() => expect(captured?.canUsePrivateApi).toBe(true));
    expect(captured?.isAuthenticated).toBe(true);
    expect(captured?.user?.id).toBe(ALICE.id);
    expect(captured?.user?.username).toBe('alice');
    expect(captured?.activeSessionId).toBe(`sess-${ALICE.id}`);
    expect(host.getAccessToken).toHaveBeenCalledWith({ reason: 'boot' });
    expect(oxy.session.userId).toBe(ALICE.id);

    // The profile is read with the host's token.
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/users/me'))).toBe(true));
    const me = calls.find((call) => call.url.endsWith('/users/me'));
    expect(me?.authorization).toBe(`Bearer ${oxy.session.accessToken}`);

    expect(mockCreatePlatformAuthStateStore).not.toHaveBeenCalled();
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
    expect(mockColdBoot).not.toHaveBeenCalled();
    expect(mockOpenBridgeWindow).not.toHaveBeenCalled();
    expect(deviceCalls()).toEqual([]);
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith('oxy.auth'))).toEqual(
      [],
    );
    expect(captured?.sessionClient).toBeNull();
    expect(captured?.accountDialogController).toBeNull();
    // The user socket follows the app token.
    expect(mockUserSocket.restart).toHaveBeenCalled();
    expect(mockUserSocket.onServerEvent).toHaveBeenCalledWith(
      'supervision_changed',
      expect.any(Function),
    );
  });

  it('a revision change drops the token before the new account is published', async () => {
    const fake = fakeHost(signedIn(ALICE));
    const { oxy } = renderHosted({ host: fake.host });
    await waitFor(() => expect(captured?.canUsePrivateApi).toBe(true));
    const aliceBearer = oxy.session.accessToken;
    const epochBefore = oxy.http.getSessionEpoch();

    let resolveBob: (value: OxyHostToken) => void = () => undefined;
    fake.host.getAccessToken.mockImplementation(
      () =>
        new Promise<OxyHostToken>((resolve) => {
          resolveBob = resolve;
        }),
    );
    renders = [];
    act(() => fake.set(signedIn(BOB, 2)));

    // Mid-transition: Alice's token is gone, Bob is not published yet.
    expect(oxy.session.accessToken).toBeNull();
    expect(oxy.http.getSessionEpoch()).toBeGreaterThan(epochBefore);
    expect(captured?.user?.id).toBe(ALICE.id);
    expect(captured?.canUsePrivateApi).toBe(false);

    const bobToken = token(BOB.id);
    await act(async () => resolveBob(bobToken));
    await waitFor(() => expect(captured?.user?.id).toBe(BOB.id));
    expect(oxy.session.accessToken).toBe(bobToken.accessToken);
    expect(captured?.canUsePrivateApi).toBe(true);

    // No render ever paired an account with the other account's token.
    for (const entry of renders) {
      if (entry.userId === BOB.id) expect(entry.bearer).not.toBe(aliceBearer);
      if (entry.userId === ALICE.id) expect(entry.bearer).not.toBe(bobToken.accessToken);
    }
    const firstBob = renders.findIndex((entry) => entry.userId === BOB.id);
    expect(renders.slice(0, firstBob).some((entry) => entry.bearer === null)).toBe(true);
    expect(deviceCalls()).toEqual([]);
  });

  it('signs out when the host does', async () => {
    const fake = fakeHost(signedIn(ALICE));
    const { oxy } = renderHosted({ host: fake.host });
    await waitFor(() => expect(captured?.canUsePrivateApi).toBe(true));
    act(() => fake.set({ status: 'signed_out', revision: 2, account: null, online: true }));
    await waitFor(() => expect(captured?.isAuthenticated).toBe(false));
    expect(oxy.session.accessToken).toBeNull();
  });

  it('runs signed out with a host it cannot speak to, and never signs in itself', async () => {
    renderHosted({ unknownContract: true });
    await waitFor(() => expect(captured?.isAuthResolved).toBe(true));
    expect(captured?.isAuthenticated).toBe(false);

    await act(async () => {
      captured?.openAccountDialog('signin');
      await auth?.signIn();
    });
    expect(mockPresentDetached).not.toHaveBeenCalled();
    expect(mockColdBoot).not.toHaveBeenCalled();
    expect(mockCreatePlatformAuthStateStore).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('signIn, the switcher and logout only ask the host', async () => {
    const fake = fakeHost(signedIn(ALICE));
    renderHosted({ host: fake.host });
    await waitFor(() => expect(captured?.canUsePrivateApi).toBe(true));
    const before = calls.length;

    await act(async () => {
      captured?.openAccountDialog();
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('switch_account');

    await act(async () => {
      await captured?.switchToAccount('acct-other');
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('switch_account');

    let result: Awaited<ReturnType<OxyContextState['logout']>> | undefined;
    await act(async () => {
      result = await captured?.logout();
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('sign_out');
    expect(result).toEqual({ status: 'requested' });
    // The platform decides; the app is still signed in until a snapshot says otherwise.
    expect(captured?.user?.id).toBe(ALICE.id);

    await act(async () => {
      await auth?.signOut();
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('sign_out');

    act(() => fake.set({ status: 'signed_out', revision: 2, account: null, online: true }));
    await waitFor(() => expect(captured?.isAuthenticated).toBe(false));
    let outcome: Awaited<ReturnType<ReturnType<typeof useAuth>['signIn']>> | undefined;
    await act(async () => {
      outcome = await auth?.signIn();
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('sign_in');
    expect(outcome).toEqual({ status: 'dialog-opened' });
    await act(async () => {
      captured?.openAccountDialog('signin');
    });
    expect(fake.host.request).toHaveBeenLastCalledWith('sign_in');

    expect(mockPresentDetached).not.toHaveBeenCalled();
    expect(mockOpenBridgeWindow).not.toHaveBeenCalled();
    expect(calls.slice(before).filter((call) => call.url.includes('/session'))).toEqual([]);
  });

  it('offline: signed in from the snapshot with no token, then a token once online', async () => {
    const fake = fakeHost(signedIn(ALICE, 1, false));
    fake.host.getAccessToken.mockResolvedValue(null);
    const { oxy } = renderHosted({ host: fake.host });

    await waitFor(() => expect(captured?.isAuthResolved).toBe(true));
    expect(captured?.isAuthenticated).toBe(true);
    expect(captured?.user?.id).toBe(ALICE.id);
    expect(captured?.user?.name?.displayName).toBe('Alice');
    expect(captured?.hasAccessToken).toBe(false);
    expect(captured?.canUsePrivateApi).toBe(false);
    expect(oxy.session.accessToken).toBeNull();
    expect(calls.filter((call) => call.authorization)).toEqual([]);

    const online = token(ALICE.id);
    fake.host.getAccessToken.mockResolvedValue(online);
    act(() => fake.set(signedIn(ALICE, 1, true)));
    await waitFor(() => expect(captured?.canUsePrivateApi).toBe(true));
    expect(oxy.session.accessToken).toBe(online.accessToken);
    expect(fake.host.getAccessToken).toHaveBeenLastCalledWith({ reason: 'preflight' });
  });

  it('refreshes the token through the host on a 401', async () => {
    const fake = fakeHost(signedIn(ALICE));
    const first = token(ALICE.id);
    const second = token(ALICE.id);
    fake.host.getAccessToken.mockImplementation(async ({ reason }) =>
      reason === 'response-401' ? second : first,
    );
    respond = (call) => {
      if (call.authorization === `Bearer ${first.accessToken}`) {
        return { status: 401, body: { message: 'expired' } };
      }
      return call.url.endsWith('/users/me')
        ? { status: 200, body: { id: ALICE.id, username: 'alice', name: {}, publicKey: '' } }
        : { status: 200, body: [] };
    };
    const { oxy } = renderHosted({ host: fake.host });

    await waitFor(() =>
      expect(fake.host.getAccessToken).toHaveBeenCalledWith({ reason: 'response-401' }),
    );
    await waitFor(() => expect(oxy.session.accessToken).toBe(second.accessToken));
    const retried = calls.filter((call) => call.url.endsWith('/users/me'));
    expect(retried[0]?.authorization).toBe(`Bearer ${first.accessToken}`);
    expect(retried[retried.length - 1]?.authorization).toBe(`Bearer ${second.accessToken}`);
    expect(captured?.canUsePrivateApi).toBe(true);
    expect(deviceCalls()).toEqual([]);
  });

  it('drops a token that names another account', async () => {
    const fake = fakeHost(signedIn(ALICE));
    fake.host.getAccessToken.mockResolvedValue(token(BOB.id));
    const { oxy } = renderHosted({ host: fake.host });
    await waitFor(() => expect(captured?.isAuthResolved).toBe(true));
    expect(captured?.user?.id).toBe(ALICE.id);
    expect(oxy.session.accessToken).toBeNull();
    expect(captured?.canUsePrivateApi).toBe(false);
  });
});
