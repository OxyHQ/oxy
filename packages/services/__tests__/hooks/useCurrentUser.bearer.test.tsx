/**
 * `useCurrentUser` reads the CURRENT user from the bearer (`GET /users/me`),
 * NOT from a session id in the URL (`GET /session/user/:activeSessionId`).
 *
 * Post zero-cookie cutover the bearer is the single source of session truth. The
 * old session-id URL was a second, independently-updated source that, on an
 * account switch, fired under the PREVIOUS account's token against the NEW
 * account's session id and 404'd.
 *
 * These tests assert (a) the hook calls `users.me()` and NEVER `bySession()`,
 * (b) a switch (the session opens the next account's store) reads the new
 * account, (c) it re-reads on focus once stale, the one way an owner-only
 * change made on another device (their languages) reaches an open app, and
 * (d) the mirror into the signed-in profile keeps its two guards.
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DataProvider, environment, Store, withStore } from '@oxy.so/bloom-data';
import type { User } from '@oxy.so/core';
import { updateProfile } from '../../src/ui/data/account';
import { User as UserEntity } from '../../src/ui/data/user';
import { useCurrentUser } from '../../src/ui/hooks/queries/useAccountQueries';
import { activeRuntime, bindActiveRuntime } from '../../src/ui/runtime/activeRuntime';
import { createTestRuntime } from '../helpers/runtimeHarness';

const ACCOUNT_A = 'user-a';
const ACCOUNT_B = 'user-b';

// Languages the bearer account currently has in Oxy — edited "on another device"
// by reassigning it.
let bearerLanguages = ['es-ES', 'en-US'];
let bearerUpdatedAt = '2026-11-01T00:00:00.000Z';
// `users.me()` answers for whichever account the bearer identifies.
let bearerAccountId = ACCOUNT_A;

const makeServices = () => ({
  users: {
    me: jest.fn(
      async (): Promise<User> =>
        ({
          id: bearerAccountId,
          username: bearerAccountId,
          name: { displayName: bearerAccountId },
          languages: bearerLanguages,
          updatedAt: bearerUpdatedAt,
        }) as User,
    ),
    bySession: jest.fn(async (): Promise<User> => {
      throw new Error('bySession must not be called by useCurrentUser');
    }),
    updateMe: jest.fn(),
  },
});

let mockState = {
  oxyServices: makeServices(),
  activeSessionId: 'sess-a' as string | null,
  isAuthenticated: true,
  user: { id: ACCOUNT_A } as User | null,
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_oxy: unknown, _session: unknown, call: () => unknown) => call(),
}));

let store: Store;
let unbind: () => void;
const wrapper = ({ children }: { children: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);

beforeEach(() => {
  bearerAccountId = ACCOUNT_A;
  bearerLanguages = ['es-ES', 'en-US'];
  bearerUpdatedAt = '2026-11-01T00:00:00.000Z';
  mockState = {
    oxyServices: makeServices(),
    activeSessionId: 'sess-a',
    isAuthenticated: true,
    user: { id: ACCOUNT_A } as User,
  };
  store = new Store();
  unbind = bindActiveRuntime(createTestRuntime());
  activeRuntime()?.setAccount({ id: ACCOUNT_A } as User);
});

afterEach(() => {
  unbind();
  jest.useRealTimers();
});

it('reads users.me (GET /users/me) and NEVER bySession', async () => {
  const { result } = renderHook(() => useCurrentUser(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('success'));
  expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(1);
  expect(mockState.oxyServices.users.bySession).not.toHaveBeenCalled();
  expect(result.current.value?.id).toBe(ACCOUNT_A);
});

it('shows the signed-in profile the session holds until it is read', () => {
  mockState.oxyServices.users.me.mockReturnValue(new Promise(() => undefined));
  mockState.user = { id: ACCOUNT_A, username: 'held' } as User;
  const { result } = renderHook(() => useCurrentUser(), { wrapper });
  expect(result.current.value?.username).toBe('held');
  expect(result.current.updatedAt).toBe(0);
});

it('reads nothing while the session is not signed in (gated)', () => {
  mockState.isAuthenticated = false;
  const { result } = renderHook(() => useCurrentUser(), { wrapper });
  expect(result.current.status).toBe('idle');
  expect(mockState.oxyServices.users.me).not.toHaveBeenCalled();
});

it('reads the NEW account on a switch, never a mismatched session', async () => {
  const { result, rerender } = renderHook(() => useCurrentUser(), { wrapper });
  await waitFor(() => expect(result.current.value?.id).toBe(ACCOUNT_A));

  // Account switch: the bearer now identifies B, and the session opens B's store.
  bearerAccountId = ACCOUNT_B;
  mockState = { ...mockState, activeSessionId: 'sess-b', user: { id: ACCOUNT_B } as User };
  store = new Store();
  rerender();

  await waitFor(() => expect(result.current.value?.id).toBe(ACCOUNT_B));
  expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(2);
  expect(mockState.oxyServices.users.bySession).not.toHaveBeenCalled();
});

it("re-reads the owner profile on focus once stale, so another device's language change arrives", async () => {
  jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), doNotFake: ['queueMicrotask'] });
  const { result } = renderHook(() => useCurrentUser(), { wrapper });
  await waitFor(() => expect(result.current.value?.languages).toEqual(['es-ES', 'en-US']));

  bearerLanguages = ['ca-ES', 'es-ES', 'en-US'];
  // Fresh (under a minute): coming back reads nothing.
  act(() => {
    environment.setFocused(false);
    environment.setFocused(true);
  });
  expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(1);

  // Older than `stale`, as it is after the app has been in the background.
  jest.setSystemTime(new Date('2026-11-21T10:02:00Z'));
  act(() => {
    environment.setFocused(false);
    environment.setFocused(true);
  });
  await waitFor(() => expect(result.current.value?.languages).toEqual(['ca-ES', 'es-ES', 'en-US']));
});

describe('the mirror into the signed-in profile', () => {
  it('copies the read profile into the session', async () => {
    renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() =>
      expect(activeRuntime()?.getSnapshot().account?.languages).toEqual(['es-ES', 'en-US']),
    );
  });

  it('never copies a read older than the profile held', async () => {
    activeRuntime()?.setAccount({
      id: ACCOUNT_A,
      username: 'newer',
      updatedAt: '2026-11-10T00:00:00.000Z',
    } as User);
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(activeRuntime()?.getSnapshot().account?.username).toBe('newer');
  });

  it('waits while a write is in flight, then copies what it settled', async () => {
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('success'));

    let answer!: (user: User) => void;
    mockState.oxyServices.users.updateMe.mockReturnValue(
      new Promise<User>((resolve) => {
        answer = resolve;
      }),
    );
    let write!: Promise<unknown>;
    act(() => {
      write = withStore(store, () =>
        updateProfile(mockState.oxyServices as never, 'sess-a', { bio: 'optimistic' }),
      );
    });
    // The optimistic layer shows on the record, but the session is not told yet.
    expect(withStore(store, () => UserEntity.get(ACCOUNT_A))?.bio).toBe('optimistic');
    expect(activeRuntime()?.getSnapshot().account?.bio).toBeUndefined();

    bearerUpdatedAt = '2026-11-02T00:00:00.000Z';
    await act(async () => {
      answer({
        id: ACCOUNT_A,
        username: ACCOUNT_A,
        bio: 'saved',
        updatedAt: bearerUpdatedAt,
      } as User);
      await write;
    });
    await waitFor(() => expect(activeRuntime()?.getSnapshot().account?.bio).toBe('saved'));
  });
});
