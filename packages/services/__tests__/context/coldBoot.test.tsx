/**
 * @jest-environment-options {"url": "https://app.oxy.so/"}
 *
 * Device-first cold boot in `OxyContext` via `runProviderColdBoot`.
 *
 *   1. A signed-out boot resolves to `isAuthResolved: true` / `isAuthenticated:
 *      false` WITHOUT any navigation — the app renders its own "Sign in with
 *      Oxy" affordance instead of being bounced. This is the DEFAULT provider
 *      (no `webAuthMode` prop): phase 7b deleted the cross-origin silent restore
 *      that used to bounce this exact case to `auth.oxy.so?prompt=none`.
 *   2. A returning device (a persisted zero-cookie device credential —
 *      `deviceId` + `deviceSecret`) restores the session on boot: the credential
 *      mints a fresh access token, the account is handed off to the SessionClient
 *      (`addCurrentAccount` — cold boot ensures MEMBERSHIP, not a deliberate
 *      activation), and the full user is hydrated via `getCurrentUser`.
 *
 * `createSessionClient` is mocked so the post-boot handoff is deterministic +
 * offline (the real client opens a socket + hits the backend); its `getState()`
 * returns null so the authenticated projection comes from `commitSession`'s
 * `getCurrentUser`.
 */

import React from 'react';
import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AUTH_STATE_STORAGE_KEY, type User } from '@oxyhq/core';

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
 * A `@oxyhq/core`-shaped stub. `mintFromDeviceSecret` is the zero-cookie mint the
 * web cold boot uses to restore a returning device; it is only called when a
 * `deviceId` + `deviceSecret` is persisted, so a signed-out boot (no seed) never
 * reaches it. `getCurrentUser` hydrates the committed session in the restore case.
 */
function buildStub(overrides: Record<string, unknown> = {}) {
  let currentToken: string | null = null;
  return {
    stub: {
      config: {},
      httpService: {
        setTokens: (token: string) => { currentToken = token; },
        setAuthRefreshHandler: jest.fn(),
        refreshAccessToken: jest.fn(async () => null),
        // The device-secret mint runs through the client's single-flight; a plain
        // passthrough is enough for these (non-concurrent) integration paths.
        runSingleFlightDeviceSecretMint: (mint: () => Promise<unknown>) => mint(),
      },
      getBaseURL: () => API_BASE_URL,
      getSessionBaseUrl: () => API_BASE_URL,
      getAccessToken: () => currentToken,
      getAccessTokenExpiry: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: (token: string) => { currentToken = token; },
      clearTokens: () => { currentToken = null; },
      clearCache: jest.fn(),
      // Zero-cookie mint: restores the device's active account from the persisted
      // device credential. Never invoked when no credential is seeded.
      mintFromDeviceSecret: jest.fn(async () => ({
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
      })),
      signInWithSharedIdentity: jest.fn(async () => null),
      getCurrentUser: jest.fn(async (): Promise<User> => ({ id: USER_ID, username: 'cbuser' } as User)),
      getUsersByIds: jest.fn(async () => []),
      listAccounts: jest.fn(async () => []),
      ...overrides,
    },
  };
}

let capturedContext: OxyContextState | null = null;

function Capture() {
  capturedContext = useOxy();
  return null;
}

function renderProvider(oxyServices: unknown): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider oxyServices={oxyServices as never} baseURL={API_BASE_URL} clientId="oxy_test_client">
        <Capture />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe('OxyContext cold boot (device-first)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    capturedContext = null;
    redirectToAuthorize.mockClear();
    useAuthStore.getState().logout();
    Object.values(fakeSessionClient).forEach((fn) => (fn as jest.Mock).mockClear());
    fakeSessionClientHost.setDeviceCredential.mockClear();
    fakeSessionClientHost.setCurrentAccountId.mockClear();
  });

  it('a signed-out boot on an official app resolves SIGNED OUT and never navigates the tab', async () => {
    // The default provider — no `webAuthMode` prop — on an official Oxy origin
    // (`https://app.oxy.so/`) with no persisted device credential. Before phase
    // 7b this was the exact shape that triggered the `prompt=none` bounce to
    // auth.oxy.so; it must now settle in place.
    const { stub } = buildStub();

    renderProvider(stub);

    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));

    expect(capturedContext?.isAuthenticated).toBe(false);
    expect(stub.mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(redirectToAuthorize).not.toHaveBeenCalled();
    // Nothing was written to sessionStorage either: the silent-restore loop
    // guards went away with the lane they guarded.
    expect(window.sessionStorage.length).toBe(0);
  });

  it('defaults webAuthMode to popup, so interactive sign-in opens a window from the gesture', async () => {
    const { stub } = buildStub();

    renderProvider(stub);

    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));

    expect(capturedContext?.webAuthMode).toBe('popup');
  });

  it('plants a still-valid persisted warm token as-is and skips the device-secret mint', async () => {
    // The persisted warm access token is valid well beyond the refresh lead
    // window, so warm-token-plant wins on the first paint: it plants the token
    // AS-IS (no rotation, no network) and the mint lane never runs. The proactive
    // refresh scheduler rotates it in the background afterwards.
    window.localStorage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'sess_cb',
        userId: USER_ID,
        deviceId: 'dev-cb',
        deviceSecret: 'cb.device.secret',
        accessToken: 'cb.warm.token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { stub } = buildStub();

    renderProvider(stub);

    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    expect(capturedContext?.isAuthResolved).toBe(true);

    // Warm token planted AS-IS; the zero-cookie mint was skipped entirely.
    expect(stub.mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(stub.getAccessToken()).toBe('cb.warm.token');
    // The full user is still hydrated for the committed session.
    expect(stub.getCurrentUser).toHaveBeenCalled();
    expect(capturedContext?.user?.id).toBe(USER_ID);
    expect(redirectToAuthorize).not.toHaveBeenCalled();
  });

  it('restores a session from the persisted store (device-secret mint) and hands off to the SessionClient', async () => {
    // A returning device: a persisted zero-cookie device credential (`deviceId` +
    // `deviceSecret`). Its warm access token has EXPIRED since the last visit, so
    // warm-token-plant skips and cold boot mints a fresh access token from the
    // credential.
    window.localStorage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'sess_cb',
        userId: USER_ID,
        deviceId: 'dev-cb',
        deviceSecret: 'cb.device.secret',
        accessToken: 'cb.access.token',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const { stub } = buildStub();

    renderProvider(stub);

    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    expect(capturedContext?.isAuthResolved).toBe(true);

    // The device credential was presented to the zero-cookie mint.
    expect(stub.mintFromDeviceSecret).toHaveBeenCalledWith('dev-cb', 'cb.device.secret');
    // The full user was hydrated via getCurrentUser.
    expect(stub.getCurrentUser).toHaveBeenCalled();
    expect(capturedContext?.user?.id).toBe(USER_ID);
    // The token was planted from the freshly minted access token.
    expect(stub.getAccessToken()).toBe('cb.minted.access');
    // Cold boot handoff ensures device-set MEMBERSHIP (addCurrentAccount), not a
    // deliberate activation (registerAndActivate) — the server's own active
    // account wins.
    await waitFor(() => expect(fakeSessionClient.addCurrentAccount).toHaveBeenCalledTimes(1));
    expect(fakeSessionClient.registerAndActivate).not.toHaveBeenCalled();
    expect(fakeSessionClient.start).toHaveBeenCalled();
    // Rotated device credential from mint must reach the SessionClient host.
    expect(fakeSessionClientHost.setDeviceCredential).toHaveBeenCalledWith({
      deviceId: 'dev-cb',
      deviceSecret: 'cb.next.secret',
    });
    expect(redirectToAuthorize).not.toHaveBeenCalled();
  });

  it('restores a session when persisted device credentials exist', async () => {
    // Stale (expired) warm token → warm-token-plant skips → device-secret mint runs.
    window.localStorage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'sess_old',
        userId: USER_ID,
        deviceId: 'dev-legacy',
        deviceSecret: 'legacy.secret',
        accessToken: 'legacy.access',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const { stub } = buildStub();

    renderProvider(stub);

    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));

    expect(stub.mintFromDeviceSecret).toHaveBeenCalledWith('dev-legacy', 'legacy.secret');
    expect(redirectToAuthorize).not.toHaveBeenCalled();
  });
});
