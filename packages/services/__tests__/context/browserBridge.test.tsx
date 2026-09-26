/**
 * @jest-environment-options {"url": "https://app.oxy.so/"}
 *
 * The browser bridge from the provider (ADR 0029 D2): opening the account dialog
 * on the web with NO device credential opens auth.oxy.so/bridge synchronously
 * (from the press), joins the browser's device, and — when the browser is
 * already signed in — signs this app in without a dialog sign-in. With a
 * credential, on the auth origin itself, or with the window blocked, nothing
 * changes. Harness borrowed from `coldBoot.test.tsx`.
 */

import React from 'react';
import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AUTH_STATE_STORAGE_KEY } from '@oxy.so/core/session';
import { type User } from '@oxy.so/core';
import { OXY_BRIDGE_CODE_MESSAGE_TYPE, OXY_BRIDGE_WINDOW_NAME } from '../../src/ui/oauth/browserBridge';

const redirectToAuthorize = jest.fn();
jest.mock('../../src/ui/components/oauthNavigation', () => ({
  redirectToAuthorize: (...args: unknown[]) => redirectToAuthorize(...args),
}));

const fakeSessionClientHost = {
  setCurrentAccountId: jest.fn(),
  setDeviceCredential: jest.fn(),
  getDeviceCredential: () => null,
};
const fakeSessionClient = {
  getState: jest.fn(() => null),
  // The dialog controller reads the directory on every snapshot build, and the
  // runtime reaches the context lane through the same client, so a stand-in
  // that omits these is not a SessionClient. Null is the honest answer for a
  // fake that was never given a directory.
  getDirectory: jest.fn(() => null),
  refreshDirectory: jest.fn(async () => undefined),
  activateContext: jest.fn(async () => undefined),
  signOutContext: jest.fn(async () => undefined),
  signOutPrincipal: jest.fn(async () => undefined),
  subscribe: jest.fn(() => () => undefined),
  start: jest.fn(async () => undefined),
  bootstrap: jest.fn(async () => undefined),
  adoptState: jest.fn(() => true),
  addCurrentAccount: jest.fn(async () => undefined),
  registerAndActivate: jest.fn(async () => undefined),
  switchAccount: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
};
jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createSessionClient: jest.fn(() => ({
      client: fakeSessionClient,
      host: fakeSessionClientHost,
    })),
  };
});

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import type { OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';

const API_BASE_URL = 'https://api.oxy.so';
const USER_ID = 'user_cb_1';

/**
 * A `@oxy.so/core`-shaped stub. `mintFromDeviceSecret` is the zero-cookie mint the
 * web cold boot uses to restore a returning device; it is only called when a
 * `deviceId` + `deviceSecret` is persisted, so a signed-out boot (no seed) never
 * reaches it. `getCurrentUser` hydrates the committed session in the restore case.
 */
function buildStub(overrides: { devices?: Record<string, unknown> } = {}) {
  let currentToken: string | null = null;
  const built = {
    stub: {
      config: {},
      http: {
        setTokens: (token: string) => { currentToken = token; },
        setAuthRefreshHandler: jest.fn(),
        refreshAccessToken: jest.fn(async () => null),
        // The device-secret mint runs through the client's single-flight; a plain
        // passthrough is enough for these (non-concurrent) integration paths.
        runSingleFlightDeviceSecretMint: (mint: () => Promise<unknown>) => mint(),
        getSessionEpoch: () => 0,
      },
      baseURL: API_BASE_URL,
      getSessionBaseUrl: () => API_BASE_URL,
      session: { get accessToken() { return (() => currentToken)(); }, get accessTokenExpiry() { return (() => null)(); }, onChange: () => () => undefined, setDeviceCredentialProvider: () => () => undefined, setAccessToken: (token: string) => { currentToken = token; }, clear: () => { currentToken = null; } },
cache: { clear: jest.fn() },
devices: { mintToken: jest.fn(async () => ({
        accessToken: 'cb.minted.access',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        nextDeviceSecret: 'cb.next.secret',
        state: {
          deviceId: 'dev-cb',
          accounts: [{ accountId: USER_ID, sessionId: 'sess_cb', authuser: 0 }],
          activeAccountId: USER_ID,
          revision: 1,
          updatedAt: Date.now(),
        },
      })) },
      auth: { signInWithSharedIdentity: jest.fn(async () => null) },
      users: { me: jest.fn(async (): Promise<User> => ({ id: USER_ID, username: 'cbuser' } as User)), getMany: jest.fn(async () => []) },
      accounts: { list: jest.fn(async () => []) },
    },
  };
  built.stub.devices = { ...built.stub.devices, ...overrides.devices } as typeof built.stub.devices;
  return built;
}

let capturedContext: OxyContextState | null = null;

function Capture() {
  capturedContext = useOxy();
  return null;
}

function renderProvider(oxyServices: unknown, props: Record<string, unknown> = {}): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider oxyServices={oxyServices as never} baseURL={API_BASE_URL} clientId="oxy_test_client" {...props}>
        <Capture />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}


function fakePopup() {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close: jest.fn(() => {
      closed = true;
    }),
    location: { href: '' },
  };
}

async function navigated(popup: { location: { href: string } }): Promise<URL> {
  await waitFor(() => expect(popup.location.href).not.toBe(''));
  return new URL(popup.location.href);
}

describe('OxyContext — the browser bridge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    capturedContext = null;
    useAuthStore.getState().logout();
    Object.values(fakeSessionClient).forEach((fn) => (fn as jest.Mock).mockClear());
    fakeSessionClientHost.setDeviceCredential.mockClear();
    jest.restoreAllMocks();
  });

  it('opens the bridge from the press, joins, and signs in when the browser already is', async () => {
    const joinBrowserDevice = jest.fn(async () => ({ deviceId: 'dev-cb', deviceSecret: 'app.secret' }));
    const { stub } = buildStub({ devices: { joinBrowser: joinBrowserDevice } });
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    expect(capturedContext?.isAuthenticated).toBe(false);

    const popup = fakePopup();
    const open = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    act(() => {
      capturedContext?.openAccountDialog('signin');
    });
    // Synchronously, inside the call — gesture attribution.
    expect(open).toHaveBeenCalledWith('', OXY_BRIDGE_WINDOW_NAME, expect.any(String));

    const url = await navigated(popup);
    expect(url.origin + url.pathname).toBe('https://auth.oxy.so/bridge');
    expect(url.searchParams.get('client_id')).toBe('oxy_test_client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.oxy.so');
    await act(async () => {
      const event = new Event('message');
      Object.assign(event, {
        origin: 'https://auth.oxy.so',
        source: popup,
        data: { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'join-code', state: url.searchParams.get('state') },
      });
      window.dispatchEvent(event);
    });

    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    expect(joinBrowserDevice).toHaveBeenCalledWith(expect.objectContaining({ code: 'join-code', clientId: 'oxy_test_client' }));
    expect(stub.devices.mintToken).toHaveBeenCalledWith('dev-cb', 'app.secret');
    expect(JSON.parse(window.localStorage.getItem(AUTH_STATE_STORAGE_KEY) ?? '{}').deviceId).toBe('dev-cb');
    expect(popup.close).toHaveBeenCalled();
  });

  it('keeps the joined credential when nobody is signed in yet, and never opens the bridge again', async () => {
    const joinBrowserDevice = jest.fn(async () => ({ deviceId: 'dev-cb', deviceSecret: 'app.secret' }));
    const mintFromDeviceSecret = jest.fn(async () => {
      throw Object.assign(new Error('no_active_session'), { status: 401 });
    });
    const { stub } = buildStub({ devices: { joinBrowser: joinBrowserDevice, mintToken: mintFromDeviceSecret }, });
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));

    const popup = fakePopup();
    const open = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    act(() => {
      capturedContext?.openAccountDialog('signin');
    });
    const url = await navigated(popup);
    await act(async () => {
      const event = new Event('message');
      Object.assign(event, {
        origin: 'https://auth.oxy.so',
        source: popup,
        data: { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'join-code', state: url.searchParams.get('state') },
      });
      window.dispatchEvent(event);
    });
    await waitFor(() => expect(mintFromDeviceSecret).toHaveBeenCalled());
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(AUTH_STATE_STORAGE_KEY) ?? '{}').deviceSecret).toBe('app.secret'),
    );
    expect(capturedContext?.isAuthenticated).toBe(false);

    open.mockClear();
    act(() => {
      capturedContext?.openAccountDialog('signin');
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('never opens it with a credential already held, or on the auth origin itself', async () => {
    window.localStorage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({ sessionId: '', userId: '', deviceId: 'dev-cb', deviceSecret: 'held.secret' }),
    );
    const mintFromDeviceSecret = jest.fn(async () => {
      throw Object.assign(new Error('no_active_session'), { status: 401 });
    });
    const { stub } = buildStub({ devices: { mintToken: mintFromDeviceSecret } });
    const first = renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    const open = jest.spyOn(window, 'open');
    act(() => {
      capturedContext?.openAccountDialog('signin');
    });
    expect(open).not.toHaveBeenCalled();
    first.unmount();

    window.localStorage.clear();
    capturedContext = null;
    const { stub: onAuth } = buildStub();
    renderProvider(onAuth, { authorizeBaseUrl: 'https://app.oxy.so/authorize' });
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    act(() => {
      capturedContext?.openAccountDialog('signin');
    });
    expect(open).not.toHaveBeenCalled();
  });
});
