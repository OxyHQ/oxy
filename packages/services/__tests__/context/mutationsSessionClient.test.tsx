/**
 * @jest-environment-options {"url": "https://app.mention.earth/"}
 *
 * Task 3 (Fase 3-B): reroute mutations through `SessionClient`.
 *
 * `switchSession` (exposed on `OxyContextState`), `logout`, and `logoutAll`
 * now resolve the target device account from the server-authoritative
 * `SessionClient` state and route the mutation through `client.switchAccount`
 * / `client.signOut` instead of the legacy bearer/cookie endpoints.
 *
 * This suite mocks `createSessionClient` (from the `../../src/ui/session`
 * barrel, same pattern as `coldBootSessionClient.test.tsx`) with a
 * controllable fake client that mutates its own `DeviceSessionState` the same
 * way the real server does (`deviceSession.service.ts`), so
 * `getState()`/`subscribe` reflect each mutation and `syncFromClient`
 * reprojects it onto the exposed context.
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AUTH_STATE_STORAGE_KEY, type SessionLoginResponse, type User } from '@oxyhq/core';
import type { DeviceSessionState } from '@oxyhq/contracts';

jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createSessionClient: jest.fn(),
  };
});

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import type { OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';
import { createSessionClient } from '../../src/ui/session';

const mockedCreateSessionClient = createSessionClient as jest.MockedFunction<typeof createSessionClient>;

const ACCOUNT_A1 = 'user-a1';
const ACCOUNT_A2 = 'user-a2';
const ACCOUNT_A3 = 'user-a3';
const SESSION_A1 = 'sess-a1';
const SESSION_A2 = 'sess-a2';
const SESSION_A3 = 'sess-a3';

const bootSession: SessionLoginResponse = {
  sessionId: SESSION_A1,
  deviceId: 'dev-1',
  accessToken: 'a1.access.token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: ACCOUNT_A1, username: 'user-a1' },
} as SessionLoginResponse;

/** Two-account device state: a1 active, a2 present — the fixture used across this suite. */
function twoAccountDeviceState(): DeviceSessionState {
  return {
    deviceId: 'dev-1',
    accounts: [
      { accountId: ACCOUNT_A1, sessionId: SESSION_A1, authuser: 0 },
      { accountId: ACCOUNT_A2, sessionId: SESSION_A2, authuser: 1 },
    ],
    activeAccountId: ACCOUNT_A1,
    revision: 1,
    updatedAt: Date.now(),
  };
}

/** Single-account device state: only a1 — used to exercise the FULL sign-out path. */
function singleAccountDeviceState(): DeviceSessionState {
  return {
    deviceId: 'dev-1',
    accounts: [{ accountId: ACCOUNT_A1, sessionId: SESSION_A1, authuser: 0 }],
    activeAccountId: ACCOUNT_A1,
    revision: 1,
    updatedAt: Date.now(),
  };
}

type StateListener = (state: DeviceSessionState | null) => void;

/**
 * A controllable stand-in for `SessionClient`. `start()` seeds `getState()`
 * with `initial` (mirrors the real `bootstrap()` following a successful
 * `GET /session/device/state`). `switchAccount`/`signOut` mutate the tracked
 * state the same way the real server (`deviceSession.service.ts`) does —
 * `signOut` re-electing the next active account from what remains — and
 * notify subscribers, exactly like a real socket-pushed `session_state`.
 */
function buildFakeClient(initial: DeviceSessionState) {
  let state: DeviceSessionState | null = null;
  const listeners = new Set<StateListener>();
  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const start = jest.fn(async () => {
    state = initial;
    notify();
  });

  // The cold-boot handoff (`commitSession` with `activate:false`) registers the
  // recovered account via `addCurrentAccount`; a deliberate first-time mint
  // (`switchToAccount` into an account not yet on the device) activates via
  // `registerAndActivate`.
  const addCurrentAccount = jest.fn(async () => undefined);
  const registerAndActivate = jest.fn(async () => undefined);

  const switchAccount = jest.fn(async (accountId: string) => {
    if (!state) return;
    state = { ...state, activeAccountId: accountId, revision: state.revision + 1, updatedAt: Date.now() };
    notify();
  });

  const signOut = jest.fn(async (target: { accountId: string } | { all: true }) => {
    if (!state) return;
    if ('all' in target) {
      state = { ...state, accounts: [], activeAccountId: null, revision: state.revision + 1, updatedAt: Date.now() };
    } else {
      const remaining = state.accounts.filter((account) => account.accountId !== target.accountId);
      const activeStillPresent = remaining.some((account) => account.accountId === state?.activeAccountId);
      const nextActive = activeStillPresent ? state.activeAccountId : (remaining[0]?.accountId ?? null);
      state = { ...state, accounts: remaining, activeAccountId: nextActive, revision: state.revision + 1, updatedAt: Date.now() };
    }
    notify();
  });

  return {
    start,
    addCurrentAccount,
    registerAndActivate,
    switchAccount,
    signOut,
    getState: () => state,
    fakeClient: {
      getState: () => state,
      subscribe: (listener: StateListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start,
      addCurrentAccount,
      registerAndActivate,
      switchAccount,
      signOut,
    },
  };
}

function buildStub(baseURL: string) {
  let currentToken: string | null = null;
  const getUsersByIds = jest.fn(async (ids: string[]): Promise<User[]> =>
    ids.map((id) => ({ id, username: `user-${id}` } as User)),
  );
  // First-time mint path for `switchToAccount` (Task 4.5's "not yet on the
  // device" branch): mints a brand-new session for whatever account id is
  // requested, mirroring `SwitchAccountResult`.
  const switchToAccount = jest.fn(async (accountId: string) => ({
    sessionId: SESSION_A3,
    deviceId: 'dev-1',
    accessToken: 'a3.access.token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: accountId, username: 'user-a3' },
    authuser: 2,
  }));
  return {
    getUsersByIds,
    switchToAccount,
    stub: {
      config: { authWebUrl: 'https://auth.oxy.so' },
      // `installAuthRefreshHandler` (SDK-owned unified refresh) installs the one
      // core refresh handler on the client's HttpService at mount.
      httpService: {
        setTokens: (token: string) => { currentToken = token; },
        setAuthRefreshHandler: jest.fn(),
        refreshAccessToken: jest.fn(async () => null),
      },
      getBaseURL: () => baseURL,
      getSessionBaseUrl: () => baseURL,
      getAccessToken: () => currentToken,
      // Opaque token → no scheduled proactive refresh (the reactive 401 path
      // stays the only trigger); keeps `startTokenRefreshScheduler` inert here.
      getAccessTokenExpiry: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: (token: string) => { currentToken = token; },
      clearTokens: () => { currentToken = null; },
      clearCache: jest.fn(),
      // The device-first cold boot recovers the session by minting from the
      // persisted zero-cookie device credential (`deviceId` + `deviceSecret`)
      // seeded into localStorage before render (the `device-secret-mint` step).
      mintFromDeviceSecret: jest.fn(async () => ({
        accessToken: 'a1.access.token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        nextDeviceSecret: 'a1.next.secret',
        state: {
          deviceId: 'dev-1',
          accounts: [{ accountId: ACCOUNT_A1, sessionId: SESSION_A1, authuser: 0 }],
          activeAccountId: ACCOUNT_A1,
          revision: 1,
          updatedAt: Date.now(),
        },
      })),
      signInWithSharedIdentity: jest.fn(async () => null),
      getCurrentUser: jest.fn(async (): Promise<User> => ({ id: ACCOUNT_A1, username: 'user-a1' } as User)),
      getUserBySession: jest.fn(async (): Promise<User> => ({ id: ACCOUNT_A1, username: 'user-a1' } as User)),
      listAccounts: jest.fn(async () => []),
      switchToAccount,
      getUsersByIds,
    },
  };
}

let captured: { isAuthenticated: boolean; activeSessionId: string | null; sessionsLength: number; userId: string | undefined } = {
  isAuthenticated: false,
  activeSessionId: null,
  sessionsLength: 0,
  userId: undefined,
};
let oxyApi: OxyContextState | null = null;

function getOxyApi(): OxyContextState {
  if (!oxyApi) {
    throw new Error('OxyContextState not captured yet');
  }
  return oxyApi;
}

function Capture() {
  const oxy = useOxy();
  oxyApi = oxy;
  captured = {
    isAuthenticated: oxy.isAuthenticated,
    activeSessionId: oxy.activeSessionId,
    sessionsLength: oxy.sessions.length,
    userId: oxy.user?.id,
  };
  return null;
}

function renderProvider(oxyServices: unknown, baseURL: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider oxyServices={oxyServices as never} baseURL={baseURL}>
        <Capture />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

// Each test mounts a fresh provider and boots through the cold-boot ladder,
// whose per-origin SSO/session state lives in `sessionStorage` keyed by origin.
// A distinct `baseURL` per boot keeps those keys isolated across mounts so one
// test's bounce/attempt guards never leak into the next
// (mirroring `coldBootSessionClient.test.tsx`'s per-case URLs).
let bootCounter = 0;
function nextBaseURL(): string {
  bootCounter += 1;
  return `https://api.mention.earth/mutations-session-client-${bootCounter}`;
}

/**
 * Seed a persisted zero-cookie device credential so the device-first cold boot's
 * `device-secret-mint` step mints a session (via the stubbed
 * `mintFromDeviceSecret`) — the stand-in for "this device already has a
 * signed-in session". Recovers ACCOUNT_A1 / SESSION_A1.
 */
function seedWarmSession() {
  window.localStorage.setItem(
    AUTH_STATE_STORAGE_KEY,
    JSON.stringify({
      sessionId: SESSION_A1,
      userId: ACCOUNT_A1,
      deviceId: 'dev-1',
      deviceSecret: 'a1.device.secret',
      accessToken: bootSession.accessToken,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
}

/**
 * Boots the provider through the real device-first cold-boot ladder (the
 * `device-secret-mint` step mints from the seeded device credential), then hands
 * off to the fake `SessionClient`, whose `start()` seeds `deviceState` and notifies
 * — projecting it onto the exposed context exactly like the real handoff.
 */
async function bootWithDeviceState(deviceState: DeviceSessionState) {
  const fake = buildFakeClient(deviceState);
  mockedCreateSessionClient.mockReturnValue({
    client: fake.fakeClient as never,
    host: { setCurrentAccountId: jest.fn(), setDeviceCredential: jest.fn(), getDeviceCredential: () => null } as never,
  });

  const baseURL = nextBaseURL();
  const { stub, getUsersByIds, switchToAccount } = buildStub(baseURL);
  seedWarmSession();
  renderProvider(stub, baseURL);

  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(captured.sessionsLength).toBe(deviceState.accounts.length));
  await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A1));

  return { fake, getUsersByIds, stub, switchToAccount };
}

describe('Mutations routed through SessionClient (Task 3)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    captured = { isAuthenticated: false, activeSessionId: null, sessionsLength: 0, userId: undefined };
    oxyApi = null;
    useAuthStore.getState().logout();
    mockedCreateSessionClient.mockReset();
  });

  it('switchSession("sess-a2") calls client.switchAccount("user-a2") and resolves to the newly active User', async () => {
    const { fake } = await bootWithDeviceState(twoAccountDeviceState());

    let resolvedUser: User | undefined;
    await act(async () => {
      resolvedUser = await getOxyApi().switchSession(SESSION_A2);
    });

    expect(fake.switchAccount).toHaveBeenCalledWith(ACCOUNT_A2);
    expect(resolvedUser).toEqual(expect.objectContaining({ id: ACCOUNT_A2 }));
    await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A2));
  });

  it('switchSession rejects with a clear error for a session id absent from the device state', async () => {
    await bootWithDeviceState(twoAccountDeviceState());

    let caught: unknown;
    await act(async () => {
      try {
        await getOxyApi().switchSession('sess-unknown');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/No device account found/);
  });

  it('logout() with no target signs out the ACTIVE account via SessionClient.signOut and reprojects the remaining account', async () => {
    const { fake } = await bootWithDeviceState(twoAccountDeviceState());

    await act(async () => {
      await getOxyApi().logout();
    });

    expect(fake.signOut).toHaveBeenCalledWith({ accountId: ACCOUNT_A1 });
    // Partial sign-out: a2 remains and becomes active — observable local
    // reprojection via `syncFromClient` (sessions/activeSessionId update),
    // NOT a full authStore reset.
    await waitFor(() => expect(captured.sessionsLength).toBe(1));
    await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A2));
    expect(captured.isAuthenticated).toBe(true);
  });

  it('logout() clears local session state (authStore reset) when it signs out the last device account', async () => {
    const { fake } = await bootWithDeviceState(singleAccountDeviceState());

    await act(async () => {
      await getOxyApi().logout();
    });

    expect(fake.signOut).toHaveBeenCalledWith({ accountId: ACCOUNT_A1 });
    // Genuine full sign-out: local cleanup observable via the authStore
    // reset (`clearSessionState` -> `logoutStore()`).
    await waitFor(() => expect(captured.isAuthenticated).toBe(false));
    expect(captured.sessionsLength).toBe(0);
    expect(captured.activeSessionId).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('logoutAll() calls client.signOut({ all: true }) and clears local session state', async () => {
    const { fake } = await bootWithDeviceState(twoAccountDeviceState());

    await act(async () => {
      await getOxyApi().logoutAll();
    });

    expect(fake.signOut).toHaveBeenCalledWith({ all: true });
    await waitFor(() => expect(captured.isAuthenticated).toBe(false));
    expect(captured.sessionsLength).toBe(0);
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe('switchToAccount unifies org/managed-account switching through the device switch path (Task 4.5)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    captured = { isAuthenticated: false, activeSessionId: null, sessionsLength: 0, userId: undefined };
    oxyApi = null;
    useAuthStore.getState().logout();
    mockedCreateSessionClient.mockReset();
  });

  it('switchToAccount(ACCOUNT_A2) — already on the device — routes through client.switchAccount and never re-mints', async () => {
    const { fake, stub, switchToAccount } = await bootWithDeviceState(twoAccountDeviceState());

    // `sessionClient.addCurrentAccount()` already ran ONCE as part of the
    // cold-boot handoff (Task 2) before this switch — track the delta rather
    // than an absolute count.
    const addCurrentAccountCallsBefore = fake.addCurrentAccount.mock.calls.length;
    const listAccountsCallsBefore = stub.listAccounts.mock.calls.length;

    await act(async () => {
      await getOxyApi().switchToAccount(ACCOUNT_A2);
    });

    // Uniform path: the SAME `client.switchAccount` `switchSession` uses.
    expect(fake.switchAccount).toHaveBeenCalledWith(ACCOUNT_A2);
    // No mint for an account the device already holds.
    expect(switchToAccount).not.toHaveBeenCalled();
    // No NEW registration into the device set — this account is already there.
    expect(fake.addCurrentAccount.mock.calls.length).toBe(addCurrentAccountCallsBefore);
    // Shared post-switch side effects still ran (`refreshAccounts` calls
    // `oxyServices.listAccounts()`).
    await waitFor(() => expect(stub.listAccounts.mock.calls.length).toBeGreaterThan(listAccountsCallsBefore));
  });

  it('switchToAccount(ACCOUNT_A3) — NOT yet on the device — keeps the first-time mint path and activates it via registerAndActivate', async () => {
    const { fake, stub, switchToAccount } = await bootWithDeviceState(twoAccountDeviceState());

    const addCurrentAccountCallsBefore = fake.addCurrentAccount.mock.calls.length;
    const listAccountsCallsBefore = stub.listAccounts.mock.calls.length;

    await act(async () => {
      await getOxyApi().switchToAccount(ACCOUNT_A3);
    });

    // First-time mint: `oxyServices.switchToAccount` is called for an account
    // not yet in the device's multi-account set…
    expect(switchToAccount).toHaveBeenCalledWith(ACCOUNT_A3);
    // …then committed through the shared funnel as a DELIBERATE activation, which
    // registers + activates the minted account via `registerAndActivate` (NOT the
    // cold-boot `addCurrentAccount` path).
    expect(fake.registerAndActivate).toHaveBeenCalledWith(ACCOUNT_A3);
    // No additional cold-boot-style membership-only registration.
    expect(fake.addCurrentAccount.mock.calls.length).toBe(addCurrentAccountCallsBefore);
    // Shared post-switch side effects still ran, same as the already-on-device branch.
    await waitFor(() => expect(stub.listAccounts.mock.calls.length).toBeGreaterThan(listAccountsCallsBefore));
  });
});
