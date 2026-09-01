/**
 * @jest-environment-options {"url": "https://app.mention.earth/"}
 *
 * Task 4 (Fase 3-B): the SessionClient socket replaces the per-domain
 * `useSessionSocket`.
 *
 * `SessionClient.start()` (Task 2's cold-boot handoff) already owns the
 * `device:<deviceId>` realtime socket: a server-pushed `session_state` event
 * flows through `applyState` -> `notify()` -> the `client.subscribe(...)`
 * effect in `OxyContext` -> `syncFromClient()`, which reprojects the exposed
 * `sessions` / `activeSessionId` / `user`. There is no more per-domain
 * `useSessionSocket` hook wiring a second, parallel socket.
 *
 * This suite drives that push path directly against a controllable fake
 * client (same pattern as `mutationsSessionClient.test.tsx`): `start()` seeds
 * the initial `DeviceSessionState`, and a `push(nextState)` helper mutates the
 * tracked state and notifies subscribers exactly like a real
 * `socket.on('session_state', ...)` delivery — WITHOUT going through
 * `switchAccount`/`signOut`, so this is a genuinely REMOTE change (e.g. a
 * second tab/device), not a locally-initiated mutation.
 *
 * Covers:
 *  (a) a pushed state with a DIFFERENT active account reprojects
 *      `sessions`/`activeSessionId`/`user` onto the new active account.
 *  (b) a pushed state with ZERO accounts (a remote full sign-out — e.g. the
 *      last device account was signed out from another tab) clears local auth
 *      via the SAME `clearSessionState()` a local full sign-out uses — the
 *      Task 4 gap fix inside `syncFromClient`.
 *  (c) the exposed `refreshSessions()` calls `client.bootstrap()` then
 *      reprojects via `syncFromClient`.
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
const SESSION_A1 = 'sess-a1';
const SESSION_A2 = 'sess-a2';

const bootSession: SessionLoginResponse = {
  sessionId: SESSION_A1,
  deviceId: 'dev-1',
  accessToken: 'a1.access.token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: ACCOUNT_A1, username: 'user-a1' },
} as SessionLoginResponse;

/** Two-account device state: a1 active, a2 present. */
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

type StateListener = (state: DeviceSessionState | null) => void;

/**
 * A controllable stand-in for `SessionClient`. `start()` seeds `getState()`
 * with `initial` (mirrors the real `bootstrap()` following a successful
 * `GET /session/device/state`). `push(next)` mutates the tracked state and
 * notifies subscribers directly — simulating a server-pushed
 * `socket.on('session_state', ...)` delivery from a REMOTE actor, bypassing
 * `switchAccount`/`signOut` entirely (those model a LOCALLY-initiated
 * mutation, covered by `mutationsSessionClient.test.tsx`).
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

  const addCurrentAccount = jest.fn(async () => undefined);
  const switchAccount = jest.fn(async () => undefined);
  const signOut = jest.fn(async () => undefined);

  const bootstrap = jest.fn(async () => {
    notify();
  });

  const push = (next: DeviceSessionState) => {
    state = next;
    notify();
  };

  return {
    start,
    addCurrentAccount,
    switchAccount,
    signOut,
    bootstrap,
    push,
    getState: () => state,
    // The dialog controller reads the directory on every snapshot build, so a
    // stand-in that omits these is not a SessionClient. Null is the honest
    // answer for a fake that was never given one.
    getDirectory: () => null,
    refreshDirectory: async () => null,
    activateContext: async () => null,
    fakeClient: {
      getState: () => state,
      // The dialog controller reads the directory on every snapshot build, so a
      // stand-in that omits these is not a SessionClient. Null is the honest
      // answer for a fake that was never given one.
      getDirectory: () => null,
      refreshDirectory: async () => null,
      activateContext: async () => null,
      subscribe: (listener: StateListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // The device DIRECTORY half (ADR 0002). This fake never reads one, so it
      // answers `null` — the shape a client that has not opted into the
      // directory holds. Omitting it entirely made the runtime's projection
      // throw and be swallowed, which reads as "the projection did nothing".
      getDirectory: () => null,
      refreshDirectory: async () => undefined,
      activateContext: async () => undefined,
      signOutContext: async () => undefined,
      signOutPrincipal: async () => undefined,
      start,
      addCurrentAccount,
      switchAccount,
      signOut,
      bootstrap,
    },
  };
}

function buildStub(baseURL: string) {
  let currentToken: string | null = null;
  const getUsersByIds = jest.fn(async (ids: string[]): Promise<User[]> =>
    ids.map((id) => ({ id, username: `user-${id}` } as User)),
  );
  return {
    getUsersByIds,
    stub: {
      config: { authWebUrl: 'https://auth.oxy.so' },
      httpService: {
        setTokens: (token: string) => { currentToken = token; },
        setAuthRefreshHandler: jest.fn(),
        refreshAccessToken: jest.fn(async () => null),
      },
      getBaseURL: () => baseURL,
      getSessionBaseUrl: () => baseURL,
      getAccessToken: () => currentToken,
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
// (mirrors `mutationsSessionClient.test.tsx`).
let bootCounter = 0;
function nextBaseURL(): string {
  bootCounter += 1;
  return `https://api.mention.earth/session-client-socket-${bootCounter}`;
}

/**
 * Seed a persisted zero-cookie device credential so the device-first cold boot's
 * `device-secret-mint` step mints a session (via the stubbed
 * `mintFromDeviceSecret`) — the stand-in for a returning signed-in device.
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
  const { stub, getUsersByIds } = buildStub(baseURL);
  seedWarmSession();
  renderProvider(stub, baseURL);

  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(captured.sessionsLength).toBe(deviceState.accounts.length));
  await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A1));

  return { fake, getUsersByIds };
}

describe('SessionClient socket replaces per-domain useSessionSocket (Task 4)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    captured = { isAuthenticated: false, activeSessionId: null, sessionsLength: 0, userId: undefined };
    oxyApi = null;
    useAuthStore.getState().logout();
    mockedCreateSessionClient.mockReset();
  });

  it('a pushed state with a DIFFERENT active account reprojects sessions/activeSessionId/user', async () => {
    const { fake } = await bootWithDeviceState(twoAccountDeviceState());

    const pushed: DeviceSessionState = {
      ...twoAccountDeviceState(),
      activeAccountId: ACCOUNT_A2,
      revision: 2,
      updatedAt: Date.now(),
    };

    act(() => {
      fake.push(pushed);
    });

    await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A2));
    await waitFor(() => expect(captured.userId).toBe(ACCOUNT_A2));
    // Both accounts remain on the device — this is a re-election, not a
    // sign-out — so the user stays authenticated.
    expect(captured.sessionsLength).toBe(2);
    expect(captured.isAuthenticated).toBe(true);
  });

  it('a pushed state with ZERO accounts (remote full sign-out) clears local auth via clearSessionState', async () => {
    const { fake } = await bootWithDeviceState(twoAccountDeviceState());

    const pushed: DeviceSessionState = {
      deviceId: 'dev-1',
      accounts: [],
      activeAccountId: null,
      revision: 2,
      updatedAt: Date.now(),
    };

    // Simulates BOTH device accounts being signed out from another
    // tab/device — no `logout()`/`logoutAll()` call happens on THIS
    // instance, only the remote push.
    act(() => {
      fake.push(pushed);
    });

    await waitFor(() => expect(captured.isAuthenticated).toBe(false));
    expect(captured.sessionsLength).toBe(0);
    expect(captured.activeSessionId).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('exposed refreshSessions() calls client.bootstrap() then reprojects via syncFromClient', async () => {
    const { fake, getUsersByIds } = await bootWithDeviceState(twoAccountDeviceState());
    getUsersByIds.mockClear();

    await act(async () => {
      await getOxyApi().refreshSessions();
    });

    expect(fake.bootstrap).toHaveBeenCalledTimes(1);
    // syncFromClient re-ran and refetched profiles for the (unchanged) state.
    await waitFor(() => expect(getUsersByIds).toHaveBeenCalledWith([ACCOUNT_A1, ACCOUNT_A2]));
  });

  it('I3: an OLDER profile fetch that resolves AFTER a newer one must not clobber the fresher projected state (last-write-wins revision guard)', async () => {
    const { fake, getUsersByIds } = await bootWithDeviceState(twoAccountDeviceState());
    getUsersByIds.mockClear();

    // Replace the stub with a controllable deferred so each `syncFromClient`
    // invocation's `getUsersByIds` call can be resolved independently and out
    // of order.
    const deferreds: Array<{ resolve: (users: User[]) => void }> = [];
    getUsersByIds.mockImplementation(() => {
      return new Promise<User[]>((resolve) => {
        deferreds.push({ resolve });
      });
    });

    // Push #1 (OLDER): revision 2, active account switches to A2. This
    // triggers `syncFromClient`, which captures revision 2 and calls
    // `getUsersByIds` — left pending (deferred #0).
    act(() => {
      fake.push({
        ...twoAccountDeviceState(),
        activeAccountId: ACCOUNT_A2,
        revision: 2,
        updatedAt: Date.now(),
      });
    });
    await waitFor(() => expect(deferreds.length).toBe(1));

    // Push #2 (NEWER): revision 3, active account back to A1. This arrives
    // and is projected BEFORE the OLDER fetch above resolves — models a slow
    // older request racing a fast newer one. Triggers a second
    // `syncFromClient` call, capturing revision 3 (deferred #1).
    act(() => {
      fake.push({
        ...twoAccountDeviceState(),
        activeAccountId: ACCOUNT_A1,
        revision: 3,
        updatedAt: Date.now(),
      });
    });
    await waitFor(() => expect(deferreds.length).toBe(2));

    const usersResponse: User[] = [
      { id: ACCOUNT_A1, username: 'user-a1' } as User,
      { id: ACCOUNT_A2, username: 'user-a2' } as User,
    ];

    // Resolve the NEWER fetch (revision 3) FIRST.
    act(() => {
      deferreds[1].resolve(usersResponse);
    });
    await waitFor(() => expect(captured.activeSessionId).toBe(SESSION_A1));
    await waitFor(() => expect(captured.userId).toBe(ACCOUNT_A1));

    // Resolve the OLDER (stale) fetch (revision 2) LAST. Its captured
    // revision no longer matches the client's current revision (3), so the
    // last-write-wins guard must skip applying it. Without the fix this
    // clobbers `activeSessionId`/`user` back to A2.
    act(() => {
      deferreds[0].resolve(usersResponse);
    });

    // Flush the stale continuation's microtasks, then assert nothing
    // regressed back to the older (revision 2) projection.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captured.activeSessionId).toBe(SESSION_A1);
    expect(captured.userId).toBe(ACCOUNT_A1);
    expect(captured.sessionsLength).toBe(2);
  });
});
