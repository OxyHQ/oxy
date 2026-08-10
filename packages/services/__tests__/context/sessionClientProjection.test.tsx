/**
 * Task 1 (Fase 3-B): `SessionClient` wiring into `OxyContext` is ADDITIVE and
 * INERT until Task 2 calls `client.start()`.
 *
 * `OxyRuntimeProvider` now builds a `SessionClient` (via the Fase 3-A
 * `createSessionClient` factory) once per `oxyServices` instance and
 * subscribes to it, projecting `client.getState()` onto the exposed
 * `sessions` / `activeSessionId` / `user` through the SAME setters the
 * existing cold-boot path uses. `client.start()` is NOT called by this task —
 * that is Task 2's job — so in production `client.getState()` never advances
 * past `null` and the projection is a guaranteed no-op.
 *
 * This suite proves the projection logic in isolation by swapping in a
 * controllable fake client (mocking only `createSessionClient` from the
 * `../session` barrel; the pure projection helpers — `deviceStateToClientSessions`,
 * `activeSessionIdOf`, `activeUserOf`, `accountIdsOf` — are the REAL
 * implementations via `jest.requireActual`):
 *
 *  1. When the fake client's `getState()` returns a populated 2-account
 *     `DeviceSessionState` and the subscriber fires, the context exposes both
 *     sessions, the correct `activeSessionId`, and the active account's `user`.
 *  2. When `getState()` returns `null` (the REAL production shape, since
 *     nothing calls `client.start()` in this task) firing the subscriber is a
 *     no-op — the existing state is left untouched.
 *
 * The mount-time web-SSO / session-socket side effects are neutralized (as in
 * `oxyClientTokenSync.test.tsx`) so the real `OxyServices` instance the
 * provider builds settles deterministically offline; the projection under
 * test is exercised against that same real instance's `getUsersByIds`.
 */

import React from 'react';
import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxyhq/core';
import type { DeviceSessionState } from '@oxyhq/contracts';

// Neutralize the mount-time network effects so the provider settles
// deterministically without a backend — mirrors `oxyClientTokenSync.test.tsx`.
// Forcing the device-first cold boot onto the NATIVE ladder (`isWebBrowser: () =>
// false`) leaves only the (empty-store → skip) `device-secret-mint` step and the
// native shared-key step (`signInWithSharedIdentity` returns null off-device), so
// the real `OxyServices` instance the provider constructs never attempts a network
// call on its own; the ONLY network-shaped call this suite exercises is
// `getUsersByIds`, driven entirely by the SessionClient projection under test.
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createSessionClient: jest.fn(),
  };
});

import { OxyRuntimeProvider, useOxy, type OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';
import { createSessionClient } from '../../src/ui/session';

const mockedCreateSessionClient = createSessionClient as jest.MockedFunction<typeof createSessionClient>;

type StateListener = (state: DeviceSessionState | null) => void;

/** A controllable stand-in for `SessionClient`: `getState()` + `subscribe()`
 * are all `syncFromClient` reads — the rest of the real class (`bootstrap`,
 * `switchAccount`, `signOut`, `start`, `stop`) is intentionally NOT
 * implemented since Task 1 never calls them. */
function buildFakeClient(initialState: DeviceSessionState | null) {
  let state = initialState;
  const listeners = new Set<StateListener>();
  return {
    fakeClient: {
      getState: () => state,
      subscribe: (listener: StateListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setState(next: DeviceSessionState | null) {
      state = next;
    },
    fire() {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function buildDeviceState(activeAccountId: string | null): DeviceSessionState {
  return {
    deviceId: 'dev-1',
    accounts: [
      { accountId: 'a1', sessionId: 'sess-a1', authuser: 0 },
      { accountId: 'a2', sessionId: 'sess-a2', authuser: 1 },
    ],
    activeAccountId,
    revision: 1,
    updatedAt: Date.now(),
  };
}

function buildUser(id: string): User {
  return { id, username: `user-${id}`, publicKey: `pk-${id}` } as User;
}

function makeSink(): { current: OxyContextState | null } {
  return { current: null };
}

const Capture: React.FC<{ sink: { current: OxyContextState | null } }> = ({ sink }) => {
  sink.current = useOxy();
  return null;
};

function requireContext(sink: { current: OxyContextState | null }): OxyContextState {
  if (!sink.current) {
    throw new Error('OxyContext was not captured');
  }
  return sink.current;
}

function renderProvider(sink: { current: OxyContextState | null }): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider baseURL="https://api.oxy.so">
        <Capture sink={sink} />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe('SessionClient projection into OxyContext (Task 1 — additive, inert until client.start())', () => {
  afterEach(() => {
    useAuthStore.getState().logout();
    mockedCreateSessionClient.mockReset();
  });

  it('projects a populated DeviceSessionState onto sessions/activeSessionId/user when the client notifies', async () => {
    const deviceState = buildDeviceState('a2');
    const fake = buildFakeClient(deviceState);
    const setCurrentAccountId = jest.fn();
    mockedCreateSessionClient.mockReturnValue({
      client: fake.fakeClient as never,
      host: { setCurrentAccountId, setDeviceCredential: jest.fn(), getDeviceCredential: () => null } as never,
    });

    const sink = makeSink();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());

    const getUsersByIdsSpy = jest
      .spyOn(requireContext(sink).oxyServices, 'getUsersByIds')
      .mockResolvedValue([buildUser('a1'), buildUser('a2')]);

    act(() => {
      fake.fire();
    });

    await waitFor(() => expect(requireContext(sink).sessions.length).toBe(2));
    expect(requireContext(sink).activeSessionId).toBe('sess-a2');
    expect(requireContext(sink).user?.id).toBe('a2');
    expect(getUsersByIdsSpy).toHaveBeenCalledWith(['a1', 'a2']);
    expect(setCurrentAccountId).toHaveBeenCalledWith('a2');

    getUsersByIdsSpy.mockRestore();
  });

  it('is inert while client.getState() is null (the real production shape — nothing calls client.start() in this task)', async () => {
    const fake = buildFakeClient(null);
    mockedCreateSessionClient.mockReturnValue({
      client: fake.fakeClient as never,
      host: { setCurrentAccountId: jest.fn(), setDeviceCredential: jest.fn(), getDeviceCredential: () => null } as never,
    });

    const sink = makeSink();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());

    const getUsersByIdsSpy = jest.spyOn(requireContext(sink).oxyServices, 'getUsersByIds');

    act(() => {
      fake.fire();
    });

    expect(requireContext(sink).sessions).toEqual([]);
    expect(requireContext(sink).activeSessionId).toBeNull();
    expect(requireContext(sink).user).toBeNull();
    expect(getUsersByIdsSpy).not.toHaveBeenCalled();

    getUsersByIdsSpy.mockRestore();
  });
});
