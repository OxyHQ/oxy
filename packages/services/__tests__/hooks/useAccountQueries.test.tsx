/**
 * The account family's reads on `@oxy.so/bloom-data`, and the React Query
 * edge cases they carry over:
 * - a read waits (`skip`) while its arguments are unknown (`enabled: false`);
 * - fresh data is not read again within `stale`; stale data is shown, then read;
 * - the SDK's retry rule: transport errors and 5xx retried (twice), 4xx never;
 * - an answer that lands after the account switched is dropped;
 * - a person already held (a feed author) shows at once, and the full profile
 *   is still read on mount (the old stale-seed contract).
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import type { User } from '@oxy.so/core';
import { storeUsers, User as UserEntity } from '../../src/ui/data/user';
import {
  useConnectedApps,
  usePrivacySettings,
  useUserById,
  useUserByUsername,
  useUsersBySessions,
} from '../../src/ui/hooks/queries/useAccountQueries';

const SPARSE = { id: 'target-1', username: 'alice', name: { displayName: 'Alice' } };
const FULL = {
  ...SPARSE,
  createdAt: '2021-03-04T00:00:00.000Z',
  relationship: { isFollowing: false, followsYou: true },
} as User;

const makeServices = () => ({
  users: {
    get: jest.fn(async (id: string) => ({ ...SPARSE, id }) as User),
    byUsername: jest.fn(async () => FULL),
    bySessions: jest.fn(async (ids: string[]) =>
      ids.map((sessionId) => ({ sessionId, user: { id: `u-${sessionId}`, username: sessionId } })),
    ),
  },
  privacy: { settings: jest.fn(async () => ({ isPrivateAccount: true })) },
  apps: { connected: { list: jest.fn(async () => []) } },
});

let mockState = {
  oxyServices: makeServices(),
  activeSessionId: 'sess' as string | null,
  isAuthenticated: true,
  user: null as { id: string } | null,
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
const wrapper = ({ children }: { children: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);

beforeEach(() => {
  mockState = {
    oxyServices: makeServices(),
    activeSessionId: 'sess',
    isAuthenticated: true,
    user: null,
  };
  store = new Store();
});

afterEach(() => {
  jest.useRealTimers();
});

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('gated reads', () => {
  it('read nothing until their arguments are known', () => {
    const byId = renderHook(() => useUserById(null), { wrapper });
    const byName = renderHook(() => useUserByUsername('alice', { enabled: false }), { wrapper });
    const privacy = renderHook(() => usePrivacySettings(), { wrapper });
    mockState.isAuthenticated = false;
    const apps = renderHook(() => useConnectedApps(), { wrapper });
    const sessions = renderHook(() => useUsersBySessions([]), { wrapper });

    for (const view of [byId, byName, privacy, apps]) {
      expect(view.result.current.status).toBe('idle');
      expect(view.result.current.isLoading).toBe(false);
    }
    expect(sessions.result.current.ids).toEqual([]);
    expect(mockState.oxyServices.users.get).not.toHaveBeenCalled();
    expect(mockState.oxyServices.users.byUsername).not.toHaveBeenCalled();
    expect(mockState.oxyServices.privacy.settings).not.toHaveBeenCalled();
    expect(mockState.oxyServices.apps.connected.list).not.toHaveBeenCalled();
    expect(mockState.oxyServices.users.bySessions).not.toHaveBeenCalled();
  });
});

describe('useUserById', () => {
  it('reads a person into User', async () => {
    const { result } = renderHook(() => useUserById('target-1'), { wrapper });
    await waitFor(() => expect(result.current.value?.username).toBe('alice'));
    expect(withStore(store, () => UserEntity.get('target-1'))).toMatchObject(SPARSE);
  });

  it('does not read a fresh person again within 5 minutes, and does once stale', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z'), doNotFake: ['queueMicrotask'] });
    const first = renderHook(() => useUserById('target-1'), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe('success'));
    first.unmount();

    jest.setSystemTime(new Date('2026-11-21T10:04:00Z'));
    const second = renderHook(() => useUserById('target-1'), { wrapper });
    expect(second.result.current.value?.username).toBe('alice');
    second.unmount();
    expect(mockState.oxyServices.users.get).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-11-21T10:06:00Z'));
    const third = renderHook(() => useUserById('target-1'), { wrapper });
    // Stale data is shown while it is read again.
    expect(third.result.current.value?.username).toBe('alice');
    await waitFor(() => expect(mockState.oxyServices.users.get).toHaveBeenCalledTimes(2));
  });

  it('retries a server failure (twice, backing off) but never a refusal', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    mockState.oxyServices.users.get.mockRejectedValue(httpError(503));
    const failing = renderHook(() => useUserById('target-1'), { wrapper });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(mockState.oxyServices.users.get).toHaveBeenCalledTimes(3);
    expect(failing.result.current.status).toBe('error');

    mockState.oxyServices.users.get.mockClear();
    mockState.oxyServices.users.get.mockRejectedValue(httpError(404));
    const refused = renderHook(() => useUserById('target-2'), { wrapper });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(mockState.oxyServices.users.get).toHaveBeenCalledTimes(1);
    expect(refused.result.current.status).toBe('error');
  });

  it('drops an answer that lands after the account switched', async () => {
    let answer!: (user: User) => void;
    mockState.oxyServices.users.get.mockReturnValueOnce(
      new Promise<User>((resolve) => {
        answer = resolve;
      }),
    );
    const left = store;
    const { result, rerender } = renderHook(() => useUserById('target-1'), { wrapper });
    expect(mockState.oxyServices.users.get).toHaveBeenCalledTimes(1);

    // The session opens the next account's store and closes this one.
    store = new Store();
    await act(async () => {
      await left.close();
    });
    rerender();
    await waitFor(() => expect(result.current.value?.username).toBe('alice'));

    await act(async () => {
      answer({ ...SPARSE, username: 'late' } as User);
    });
    expect(result.current.value?.username).toBe('alice');
    expect(withStore(store, () => UserEntity.get('target-1'))?.username).toBe('alice');
  });
});

describe('useUserByUsername', () => {
  it('shows a held feed author at once, then reads the full profile on mount', async () => {
    // A feed precached the author, sparse (no createdAt, no relationship).
    withStore(store, () => storeUsers(SPARSE));
    const { result } = renderHook(() => useUserByUsername('Alice'), { wrapper });
    expect(result.current.value?.name?.displayName).toBe('Alice');
    await waitFor(() => expect(result.current.value?.createdAt).toBe(FULL.createdAt));
    expect(result.current.value?.relationship).toEqual(FULL.relationship);
    expect(mockState.oxyServices.users.byUsername).toHaveBeenCalledTimes(1);
    // The handle is normalised before the request.
    expect(mockState.oxyServices.users.byUsername).toHaveBeenCalledWith('alice');
  });

  it('does not read a profile again that this read fetched under 5 minutes ago', async () => {
    const first = renderHook(() => useUserByUsername('alice'), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe('success'));
    first.unmount();
    const second = renderHook(() => useUserByUsername('ALICE '), { wrapper });
    expect(second.result.current.value?.createdAt).toBe(FULL.createdAt);
    expect(mockState.oxyServices.users.byUsername).toHaveBeenCalledTimes(1);
  });

  it('reads again in the store a sign-in opens, where the viewer relationship lives', async () => {
    const { result, rerender } = renderHook(() => useUserByUsername('alice'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('success'));
    store = new Store();
    rerender();
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(mockState.oxyServices.users.byUsername).toHaveBeenCalledTimes(2);
  });
});

describe('useUsersBySessions', () => {
  it('reads many sessions in one request; the list holds the session ids', async () => {
    const { result } = renderHook(() => useUsersBySessions(['s1', 's2']), { wrapper });
    await waitFor(() => expect(result.current.ids).toEqual(['s1', 's2']));
    expect(mockState.oxyServices.users.bySessions).toHaveBeenCalledTimes(1);
    expect(withStore(store, () => UserEntity.get('u-s2'))?.username).toBe('s2');
  });
});
