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
import { render, waitFor, act, fireEvent, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { AUTH_STATE_STORAGE_KEY, createNativeAuthStateStore } from '@oxy.so/core/session';
import { type User } from '@oxy.so/core';

let mockWebBrowser = true;
jest.mock('../../src/ui/utils/isWebBrowser', () => ({ isWebBrowser: () => mockWebBrowser }));
const mockOAuthCompletion = jest.fn();
jest.mock('../../src/ui/oauth/browserAuthTransport', () => {
  const actual = jest.requireActual('../../src/ui/oauth/browserAuthTransport');
  return { ...actual, startWebOAuthSignIn: (...args: unknown[]) => mockOAuthCompletion(...args) };
});
jest.mock('../../src/ui/session/sharedDeviceCredentialStore', () => {
  const actual = jest.requireActual('../../src/ui/session/sharedDeviceCredentialStore');
  return {...actual, createPlatformSharedDeviceCredentialStore: jest.fn(() => null)};
});
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
  resetLocalState: jest.fn(),
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
    createPlatformAuthStateStore: jest.fn((...args: unknown[]) => actual.createPlatformAuthStateStore(...args)),
    createSessionClient: jest.fn(() => ({
      client: fakeSessionClient,
      host: fakeSessionClientHost,
    })),
  };
});

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import type { OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';
import { useAuth } from '../../src/ui/hooks/useAuth';
import OxySignInButton from '../../src/ui/components/OxySignInButton';
import { KeyManager } from '@oxy.so/core/crypto';

const API_BASE_URL = 'https://api.oxy.so';
const USER_ID = 'user_cb_1';

/**
 * A `@oxy.so/core`-shaped stub. `mintFromDeviceSecret` is the zero-cookie mint the
 * web cold boot uses to restore a returning device; it is only called when a
 * `deviceId` + `deviceSecret` is persisted, so a signed-out boot (no seed) never
 * reaches it. `getCurrentUser` hydrates the committed session in the restore case.
 */
function buildStub(overrides: Record<string, unknown> = {}) {
  let currentToken: string | null = null;
  return {
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
apps: { getPublic: jest.fn(async () => ({ id: 'registered-app', name: 'Registered App', type: 'first_party', isOfficial: false, isInternal: false, scopes: [] })) },
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
      auth: { signInWithCommonsIdentity: jest.fn(async () => null) },
      users: { me: jest.fn(async (): Promise<User> => ({ id: USER_ID, username: 'cbuser' } as User)), getMany: jest.fn(async () => []) },
      accounts: { list: jest.fn(async () => []) },
      ...overrides,
    },
  };
}

let capturedContext: OxyContextState | null = null;
let capturedAuth: ReturnType<typeof useAuth> | null = null;

function Capture() {
  capturedContext = useOxy();
  capturedAuth = useAuth();
  return null;
}

function renderProvider(oxyServices: unknown, options: { button?: boolean; onError?: jest.Mock } = {}): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider oxyServices={oxyServices as never} baseURL={API_BASE_URL} clientId="oxy_test_client" onError={options.onError}>
        <Capture />
        {options.button && <OxySignInButton text="Retry sign in" />}
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
    expect(stub.devices.mintToken).not.toHaveBeenCalled();
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
    expect(stub.devices.mintToken).not.toHaveBeenCalled();
    expect(stub.session.accessToken).toBe('cb.warm.token');
    // The full user is still hydrated for the committed session.
    expect(stub.users.me).toHaveBeenCalled();
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
    expect(stub.devices.mintToken).toHaveBeenCalledWith('dev-cb', 'cb.device.secret');
    // The full user was hydrated via getCurrentUser.
    expect(stub.users.me).toHaveBeenCalled();
    expect(capturedContext?.user?.id).toBe(USER_ID);
    // The token was planted from the freshly minted access token.
    expect(stub.session.accessToken).toBe('cb.minted.access');
    // The mint already returned authoritative device state, so handoff neither
    // re-registers nor re-reads the same state.
    expect(fakeSessionClient.adoptState).toHaveBeenCalledTimes(1);
    expect(fakeSessionClient.addCurrentAccount).not.toHaveBeenCalled();
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

    expect(stub.devices.mintToken).toHaveBeenCalledWith('dev-legacy', 'legacy.secret');
    expect(redirectToAuthorize).not.toHaveBeenCalled();
  });
});

it.each([false, true])('device -> isolated OAuth keeps only the exchanged bearer; self-logout expired=%s', async (expired) => {
  window.localStorage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify({ sessionId: 'device-old', userId: USER_ID, deviceId: 'prior-device', deviceSecret: 'prior-secret', accessToken: 'old-device-bearer', expiresAt: new Date(Date.now()+3600000).toISOString() }));
  const { stub } = buildStub();
  const revoke = jest.fn(async () => { if (expired) throw Object.assign(new Error('Session expired'), {status:401}); });
  Object.assign(stub.session, { logout: revoke });
  renderProvider(stub);
  await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
  fakeSessionClient.registerAndActivate.mockClear(); fakeSessionClient.addCurrentAccount.mockClear(); fakeSessionClient.start.mockClear(); fakeSessionClient.refreshDirectory.mockClear();
  mockOAuthCompletion.mockImplementation(async (context) => {
    // exchangeCode plants its bearer before entering the commit funnel.
    stub.session.setAccessToken('new-isolated-bearer');
    await context.commitSession({ sessionId: 'isolated-new', accessToken: 'new-isolated-bearer', userId: USER_ID, user: { id: USER_ID, username: 'cbuser' } });
    return { status: 'signed-in' };
  });
  const context = capturedContext;
  if (!context) throw new Error('Expected a mounted provider context');
  await act(async () => { await context.startWebOAuthSignIn({ redirectUri: 'https://external.fixture/callback' }); });
  expect(stub.session.accessToken).toBe('new-isolated-bearer');
  expect(capturedContext?.activeSessionId).toBe('isolated-new');
  expect(capturedContext?.sessions.map((entry) => entry.sessionId)).toEqual(['isolated-new']);
  expect(fakeSessionClient.resetLocalState).toHaveBeenCalled();
  expect(fakeSessionClientHost.setDeviceCredential).toHaveBeenLastCalledWith(null);
  expect(fakeSessionClient.registerAndActivate).not.toHaveBeenCalled();
  expect(fakeSessionClient.addCurrentAccount).not.toHaveBeenCalled();
  expect(fakeSessionClient.start).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(AUTH_STATE_STORAGE_KEY)).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  await act(async () => { await capturedAuth!.signOut(); });
  await act(async () => { await capturedAuth!.signOut(); });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledWith('isolated-new');
  expect(stub.session.accessToken).toBeNull();
  expect(capturedContext?.isAuthenticated).toBe(false);
});


describe('SDK public recovery regressions', () => {
  beforeEach(() => {
    mockWebBrowser = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.getState().logout();
    capturedContext = null;
    capturedAuth = null;
    Object.values(fakeSessionClient).forEach((fn) => (fn as jest.Mock).mockClear());
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); mockWebBrowser = true; });

  function refuseApp(stub: ReturnType<typeof buildStub>['stub'], kind: string) {
    if (kind === 'external') stub.apps.getPublic.mockResolvedValue({ id: 'external', name: 'External', type: 'third_party', isOfficial: false, isInternal: false, scopes: [] });
    else if (kind === 'malformed') stub.apps.getPublic.mockResolvedValue({ id: 'malformed', isOfficial: true } as never);
    else stub.apps.getPublic.mockRejectedValue(Object.assign(new Error(kind), { status: kind === 'inactive' ? 403 : 404 }));
  }

  it('recovers classification on the real sign-in button without remounting the provider', async () => {
    const { stub } = buildStub();
    stub.apps.getPublic.mockRejectedValueOnce(new Error('registry unavailable'));
    const read = jest.spyOn(Storage.prototype, 'getItem');
    const view = renderProvider(stub, { button: true });
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    expect(read.mock.calls.some(([key]) => key === AUTH_STATE_STORAGE_KEY)).toBe(false);
    expect(stub.devices.mintToken).not.toHaveBeenCalled();
    expect(stub.auth.signInWithCommonsIdentity).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('Retry sign in'));
    await waitFor(() => expect(capturedContext?.isAccountDialogOpen).toBe(true));
  });

  it.each(['external', 'unknown', 'inactive', 'malformed'])('refuses native identity probes through useAuth for %s application', async (kind) => {
    const { stub } = buildStub();
    refuseApp(stub, kind);
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    mockWebBrowser = false;
    jest.requireMock('../../src/ui/session').createPlatformAuthStateStore.mockImplementation(
      (...args: unknown[]) => jest.requireActual('../../src/ui/session').createPlatformAuthStateStore(...args));
    jest.requireMock('../../src/ui/session/sharedDeviceCredentialStore').createPlatformSharedDeviceCredentialStore.mockReturnValue(null);
    const hasIdentity = jest.spyOn(KeyManager, 'hasIdentity').mockResolvedValue(false);
    const getPublicKey = jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);
    await act(async () => { await capturedAuth!.signIn().catch(() => undefined); });
    expect(hasIdentity).not.toHaveBeenCalled();
    expect(getPublicKey).not.toHaveBeenCalled();
  });

  it.each(['external', 'unknown', 'inactive', 'malformed'])('refuses explicit-key challenge through useAuth for %s application', async (kind) => {
    const { stub } = buildStub();
    refuseApp(stub, kind);
    const requestChallenge = jest.fn(async () => { throw new Error('unexpected challenge'); });
    Object.assign(stub.auth, { requestChallenge });
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    await act(async () => { await capturedAuth!.signIn('explicit-key').catch(() => undefined); });
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('recovers a timed-out initial classification on the same mounted public button', async () => {
    jest.useFakeTimers();
    const { stub } = buildStub();
    stub.apps.getPublic.mockImplementationOnce(() => new Promise(() => {}));
    const view = renderProvider(stub, { button: true });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { jest.advanceTimersByTime(5001); });
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    expect(stub.devices.mintToken).not.toHaveBeenCalled();
    expect(stub.auth.signInWithCommonsIdentity).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('Retry sign in'));
    await waitFor(() => expect(capturedContext?.isAccountDialogOpen).toBe(true));
  });

  it.each(['external', 'unknown', 'inactive', 'malformed'])('refuses direct useOxy.signIn for %s application', async (kind) => {
    const { stub } = buildStub();
    refuseApp(stub, kind);
    const requestChallenge = jest.fn(async () => { throw new Error('unexpected challenge'); });
    Object.assign(stub.auth, { requestChallenge });
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    await act(async () => { await capturedContext!.signIn('explicit-key').catch(() => undefined); });
    expect(requestChallenge).not.toHaveBeenCalled();
    expect(stub.devices.mintToken).not.toHaveBeenCalled();
  });

  it('refuses an old public sign-in callback after the provider client changes', async () => {
    const { stub } = buildStub();
    const requestChallenge = jest.fn(async () => { throw new Error('unexpected challenge'); });
    Object.assign(stub.auth, { requestChallenge });
    const view = renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    const oldSignIn = capturedAuth!.signIn;
    const next = buildStub().stub;
    refuseApp(next, 'external');
    view.rerender(<QueryClientProvider client={new QueryClient()}>
      <OxyRuntimeProvider oxyServices={next as never} clientId="different-client" baseURL={API_BASE_URL}><Capture /></OxyRuntimeProvider>
    </QueryClientProvider>);
    const oldQueries = stub.apps.getPublic.mock.calls.length;
    await act(async () => { await expect(oldSignIn('explicit-key')).rejects.toThrow('superseded'); });
    expect(stub.apps.getPublic).toHaveBeenCalledTimes(oldQueries);
    expect(requestChallenge).not.toHaveBeenCalled();
    expect(capturedContext?.isAccountDialogOpen).toBe(false);
  });

  it.each(['503', 'network'])('reports isolated logout %s through the public hook and preserves the session for retry', async (failureKind) => {
    const { stub } = buildStub();
    const failure = failureKind === '503' ? Object.assign(new Error('Logout unavailable'), { status: 503 }) : new Error('Logout unavailable');
    const logout = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    Object.assign(stub.session, { logout });
    const onError = jest.fn();
    renderProvider(stub, { onError });
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    mockOAuthCompletion.mockImplementation(async (context) => {
      stub.session.setAccessToken('isolated-token');
      await context.commitSession({ sessionId: 'isolated', accessToken: 'isolated-token', userId: USER_ID, user: { id: USER_ID, username: 'cbuser' } });
      return { status: 'signed-in' };
    });
    await act(async () => { await capturedContext!.startWebOAuthSignIn({ redirectUri: 'https://external.fixture/callback' }); });
    let rejected: unknown;
    await act(async () => { try { await capturedAuth!.signOut(); } catch (error) { rejected = error; } });
    expect({ rejected, notified: onError.mock.calls.length, error: capturedAuth?.error,
      authenticated: capturedAuth?.isAuthenticated, token: stub.session.accessToken })
      .toEqual({ rejected: failure, notified: 1, error: 'Logout unavailable', authenticated: true, token: 'isolated-token' });
    await act(async () => { await capturedAuth!.signOut(); });
    expect(stub.session.accessToken).toBeNull();
    expect(capturedAuth?.isAuthenticated).toBe(false);
  });
});


// These drive the real provider's AppState subscriptions. Only the network-shaped
// SessionClient and profile service are synthetic; runtime projection is real.
describe('native foreground device-state reconciliation', () => {
  const listeners = new Set<(state: string) => void>();
  beforeEach(() => {
    mockWebBrowser = false;
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.getState().logout();
    capturedContext = null;
    capturedAuth = null;
    listeners.clear();
    Object.values(fakeSessionClient).forEach((fn) => (fn as jest.Mock).mockClear());
    fakeSessionClient.getState.mockReturnValue(null);
    fakeSessionClient.bootstrap.mockImplementation(async () => undefined);
    jest.spyOn(KeyManager, 'hasIdentity').mockResolvedValue(false);
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      listeners.add(listener);
      return { remove: () => { listeners.delete(listener); } };
    });
    AppState.currentState = 'active';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockWebBrowser = true;
    fakeSessionClient.getState.mockReturnValue(null);
    fakeSessionClient.bootstrap.mockImplementation(async () => undefined);
  });

  async function emit(state: string) {
    AppState.currentState = state;
    await act(async () => { for (const listener of listeners) listener(state); });
  }

  it('projects a sibling account switch on background→active without a manual refresh', async () => {
    const { stub } = buildStub();
    stub.users.getMany.mockResolvedValue([
      { id: USER_ID, username: 'fixture-person' },
      { id: 'fixture-org', username: 'fixture-org' },
    ] as never);
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    // No mount-time reconcile or private mint is added by the resume listener.
    fakeSessionClient.bootstrap.mockClear();
    stub.session.setAccessToken('existing-device-token');
    fakeSessionClient.bootstrap.mockImplementation(async () => {
      fakeSessionClient.getState.mockReturnValue({
        deviceId: 'fixture-device', accounts: [
          { accountId: USER_ID, sessionId: 'fixture-person-session', authuser: 0 },
          { accountId: 'fixture-org', sessionId: 'fixture-org-session', authuser: 1 },
        ], activeAccountId: 'fixture-org', revision: 2, updatedAt: Date.now(),
      } as never);
    });
    await emit('background');
    expect(fakeSessionClient.bootstrap).not.toHaveBeenCalled();
    await emit('active');
    await waitFor(() => expect(capturedContext?.user?.id).toBe('fixture-org'));
    expect(capturedContext?.activeSessionId).toBe('fixture-org-session');
    expect(fakeSessionClient.bootstrap).toHaveBeenCalledTimes(1);
    expect(stub.http.refreshAccessToken).toHaveBeenCalledWith('preflight');
  });

  it('coalesces repeated foreground events while the authoritative read is pending', async () => {
    const { stub } = buildStub();
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    stub.session.setAccessToken('existing-device-token');
    fakeSessionClient.bootstrap.mockClear();
    let complete: (() => void) | undefined;
    fakeSessionClient.bootstrap.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    await emit('inactive');
    await emit('active');
    await emit('background');
    await emit('active');
    expect(fakeSessionClient.bootstrap).toHaveBeenCalledTimes(1);
    if (!complete) throw new Error('Expected an authoritative foreground read');
    await act(async () => { complete(); });
    await emit('inactive');
    await emit('active');
    expect(fakeSessionClient.bootstrap).toHaveBeenCalledTimes(2);
    await act(async () => { complete?.(); });
  });

  it('does not bootstrap on initial unknown→active, then heals a real background resume', async () => {
    Reflect.set(AppState, 'currentState', null);
    const { stub } = buildStub();
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    stub.session.setAccessToken('existing-device-token');
    fakeSessionClient.bootstrap.mockClear();
    await emit('active');
    expect(fakeSessionClient.bootstrap).not.toHaveBeenCalled();
    await emit('background');
    await emit('active');
    expect(fakeSessionClient.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('checks canonical shared recovery on native resume without bootstrapping an absent session', async () => {
    const { stub } = buildStub();
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    fakeSessionClient.bootstrap.mockClear();
    await emit('background');
    await emit('active');
    expect(fakeSessionClient.bootstrap).not.toHaveBeenCalled();
    expect(stub.http.refreshAccessToken).toHaveBeenCalledWith('preflight');
  });

  it('leaves an isolated OAuth grant outside the native device resume lane', async () => {
    const { stub } = buildStub();
    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    mockOAuthCompletion.mockImplementation(async (context) => {
      await context.commitSession({ sessionId: 'isolated-native', accessToken: 'isolated-bearer', userId: USER_ID, user: { id: USER_ID, username: 'cbuser' } });
      return { status: 'signed-in' };
    });
    await act(async () => { await capturedContext?.startWebOAuthSignIn({ redirectUri: 'https://external.fixture/callback' }); });
    fakeSessionClient.bootstrap.mockClear();
    await emit('background');
    await emit('active');
    expect(fakeSessionClient.bootstrap).not.toHaveBeenCalled();
    expect(stub.http.refreshAccessToken).not.toHaveBeenCalled();
    expect(stub.session.accessToken).toBe('isolated-bearer');
  });

  async function sharedRecoveryFixture() {
    const values = new Map<string, string>();
    const kv = {getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => {values.set(key, value);}, removeItem: async (key: string) => {values.delete(key);}};
    const store = createNativeAuthStateStore(kv);
    const prior = {sessionId: 'old-native-session', userId: USER_ID, deviceId: 'old-native-device', deviceSecret: 'old-native-holder'};
    await store.save(prior);
    jest.requireMock('../../src/ui/session').createPlatformAuthStateStore.mockReturnValue(store);
    let published = false;
    const slot = {read: async () => published ? {state: 'present', credential: {deviceId: 'new-native-device', deviceSecret: 'new-native-holder'}} : {state: 'absent'}, publish: async () => true, clear: jest.fn()};
    jest.requireMock('../../src/ui/session/sharedDeviceCredentialStore').createPlatformSharedDeviceCredentialStore.mockReturnValue(slot);
    const {stub} = buildStub();
    stub.devices.mintToken.mockImplementation(async (device: string) => {
      if (device === prior.deviceId) throw Object.assign(new Error('invalid_device_secret'), {status: 401});
      return {accessToken: 'shared-new-token', nextDeviceSecret: 'new-native-holder', expiresAt: new Date(Date.now() + 300_000).toISOString(), state: {deviceId: 'new-native-device', accounts: [{accountId: USER_ID, sessionId: 'new-native-session', authuser: 0}], activeAccountId: USER_ID, revision: 1, updatedAt: Date.now()}};
    });
    stub.http.refreshAccessToken.mockImplementation(async reason => {
      const calls = stub.http.setAuthRefreshHandler.mock.calls;
      const handler = calls[calls.length - 1]?.[0];
      return handler ? handler(reason) : null;
    });
    stub.users.getMany.mockResolvedValue([{id: USER_ID, username: 'fixture-person'}] as never);
    const view = renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    expect(capturedContext?.isAuthenticated).toBe(false);
    fakeSessionClient.bootstrap.mockImplementation(async () => {
      fakeSessionClient.getState.mockReturnValue({deviceId: 'new-native-device', accounts: [{accountId: USER_ID, sessionId: 'new-native-session', authuser: 0}], activeAccountId: USER_ID, revision: 1, updatedAt: Date.now()} as never);
    });
    return {store, kv, prior, stub, view, publish: () => {published = true;}};
  }

  it('a native resume adopts a newly proved shared re-login through the installed canonical handler', async () => {
    const f = await sharedRecoveryFixture(); f.publish();
    await emit('background'); await emit('active');
    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    expect(capturedContext?.user?.id).toBe(USER_ID);
    expect(await f.store.load()).toMatchObject({deviceId: 'new-native-device', sessionId: 'new-native-session'});
    expect(f.stub.auth.signInWithCommonsIdentity).not.toHaveBeenCalled();
  });

  it('unmounting during a shared mint prevents storage and token commits', async () => {
    const f = await sharedRecoveryFixture(); f.publish();
    let finish: ((value: unknown) => void) | undefined;
    f.stub.devices.mintToken.mockImplementation(async (device: string) => {
      if (device === f.prior.deviceId) throw Object.assign(new Error('invalid_device_secret'), {status: 401});
      return new Promise(resolve => {finish = resolve;});
    });
    await emit('background'); await emit('active');
    await waitFor(() => expect(finish).toBeDefined());
    f.view.unmount();
    await act(async () => {finish?.({accessToken: 'late-token', nextDeviceSecret: 'new-native-holder', expiresAt: new Date(Date.now() + 300_000).toISOString(), state: {deviceId: 'new-native-device', accounts: [{accountId: USER_ID, sessionId: 'late-session', authuser: 0}], activeAccountId: USER_ID, revision: 1, updatedAt: Date.now()}});});
    expect(await createNativeAuthStateStore(f.kv).load()).toEqual(f.prior);
    expect(f.stub.session.accessToken).toBeNull();
  });

  it('removes native listeners on unmount', async () => {
    const { stub } = buildStub();
    const view = renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
    stub.session.setAccessToken('existing-device-token');
    view.unmount();
    fakeSessionClient.bootstrap.mockClear();
    await emit('background');
    await emit('active');
    expect(fakeSessionClient.bootstrap).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
